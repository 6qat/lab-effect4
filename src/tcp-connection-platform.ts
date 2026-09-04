import * as tls from "node:tls";
import { BunSocket } from "@effect/platform-bun";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Queue,
	Ref,
	Scope,
	Stream,
} from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import {
	buildDefaultRetrySchedule,
	ConnectionConfig,
	ConnectionConfigLive,
	type ConnectionConfigShape,
	TcpStream,
	TcpStreamError,
	unknownToMessage,
	validateConnectionConfig,
} from "./tcp-connection-common.js";

export * from "./tcp-connection-common.js";

type ConnectionState =
	| { readonly _tag: "Open" }
	| { readonly _tag: "Closed"; readonly error?: TcpStreamError };

/**
 * Maps typed SocketError from @effect/platform into TcpStreamError.
 *
 * Decisions made:
 * - Tag-based reason inspection (Q6 -> Option A):
 *   - SocketOpenError -> operation: "connect"
 *   - SocketWriteError -> operation: "write"
 *   - SocketReadError -> operation: "read"
 *   - SocketCloseError -> operation: "read" (if abnormal close)
 */
const mapSocketError = (error: Socket.SocketError): TcpStreamError => {
	const reason = error.reason;
	switch (reason._tag) {
		case "SocketOpenError":
			return new TcpStreamError({
				operation: "connect",
				message: `Connection failed: ${unknownToMessage(reason.cause)}`,
				cause: reason.cause,
			});
		case "SocketWriteError":
			return new TcpStreamError({
				operation: "write",
				message: `Socket write failed: ${unknownToMessage(reason.cause)}`,
				cause: reason.cause,
			});
		case "SocketReadError":
			return new TcpStreamError({
				operation: "read",
				message: `Socket read failed: ${unknownToMessage(reason.cause)}`,
				cause: reason.cause,
			});
		case "SocketCloseError":
			return new TcpStreamError({
				operation: "read",
				message: `Socket closed abnormally with code ${reason.code}`,
			});
		default:
			return new TcpStreamError({
				operation: "read",
				message: `Socket error: ${unknownToMessage(error)}`,
				cause: error,
			});
	}
};

/**
 * Creates a Socket.Socket supporting both plain TCP and TLS.
 *
 * Decisions made:
 * - Dual-mode socket instantiation via fromDuplex (Q5 -> Option A):
 *   - Plain TCP: delegates to BunSocket.makeNet({ host, port }).
 *   - TLS: connects via tls.connect and wraps duplex stream via BunSocket.fromDuplex.
 */
const createPlatformSocket = (
	config: ConnectionConfigShape,
): Effect.Effect<Socket.Socket, Socket.SocketError, Scope.Scope> => {
	if (!config.tls) {
		return BunSocket.makeNet({
			host: config.host,
			port: config.port,
		});
	}

	const tlsOptions: tls.ConnectionOptions =
		typeof config.tls === "boolean"
			? {}
			: (config.tls as tls.ConnectionOptions);

	return BunSocket.fromDuplex(
		Effect.contextWith((context) => {
			let socketInstance: tls.TLSSocket | undefined;
			return Effect.flatMap(
				Scope.addFinalizer(
					Context.get(context, Scope.Scope),
					Effect.sync(() => {
						if (socketInstance && socketInstance.closed === false) {
							socketInstance.destroy();
						}
					}),
				),
				() =>
					Effect.callback<tls.TLSSocket, Socket.SocketError>((resume) => {
						const conn = tls.connect({
							...tlsOptions,
							host: config.host,
							port: config.port,
						});
						socketInstance = conn;
						conn.once("secureConnect", () => {
							resume(Effect.succeed(conn));
						});
						conn.on("error", (cause) => {
							resume(
								Effect.fail(
									new Socket.SocketError({
										reason: new Socket.SocketOpenError({
											kind: "Unknown",
											cause,
										}),
									}),
								),
							);
						});
					}),
			);
		}),
	);
};

/**
 * Deep orchestrator for TcpStream based on @effect/platform Socket.Socket.run.
 *
 * Idiomatic Effect architectural patterns:
 * - Effectful Ref & Deferred state machine (Suggestion 1): Eliminates mutable flags
 *   in favor of pure effectful state transitions using Ref and Deferred.
 * - Queue-backed push bridge (Suggestion 2): Bridges socket.run push callback into
 *   unbounded Queue and exposes Stream.fromQueue.
 * - Scope-driven lifecycle with manual close integration (Suggestion 3): Scope finalizers
 *   ensure graceful cleanup on scope exit or explicit close invocation.
 * - Effect text stream encoder (Suggestion 4): Uses Stream.encodeText with pure runFold
 *   for UTF-8 string encoding.
 */
export const makeTcpStreamPlatform = Effect.gen(function* () {
	const config = yield* ConnectionConfig;
	const parentScope = yield* Scope.Scope;

	const validConfig = yield* Effect.fromResult(
		validateConnectionConfig(config),
	);

	const incoming = yield* Queue.unbounded<
		Uint8Array,
		TcpStreamError | Cause.Done
	>();
	const state = yield* Ref.make<ConnectionState>({ _tag: "Open" });

	const finishIncoming = (error?: TcpStreamError): Effect.Effect<void> =>
		Effect.gen(function* () {
			const currentState = yield* Ref.get(state);
			if (currentState._tag === "Closed") {
				return;
			}

			if (error) {
				yield* Ref.set(state, { _tag: "Closed", error });
				yield* Queue.failCause(incoming, Cause.fail(error));
			} else {
				yield* Ref.set(state, { _tag: "Closed" });
				yield* Queue.end(incoming);
			}
		});

	const retrySchedule =
		validConfig.retrySchedule !== undefined
			? Option.some(validConfig.retrySchedule)
			: validConfig.retry === false
				? Option.none()
				: Option.some(buildDefaultRetrySchedule(validConfig.retry));

	// Single connection attempt managing an isolated child scope
	const connectAttempt = Effect.gen(function* () {
		const childScope = yield* Scope.fork(parentScope, "sequential");
		const socket = yield* createPlatformSocket(validConfig).pipe(
			Effect.mapError(mapSocketError),
			Scope.provide(childScope),
		);

		const ready = yield* Deferred.make<void, TcpStreamError>();
		const isConnected = yield* Ref.make(false);

		// Fork the push-based read loop in the child scope
		yield* socket
			.run(
				(chunk) => {
					Queue.offerUnsafe(incoming, chunk);
				},
				{
					onOpen: Effect.gen(function* () {
						yield* Ref.set(isConnected, true);
						yield* Deferred.succeed(ready, void 0);
					}),
				},
			)
			.pipe(
				Effect.catch((err: Socket.SocketError) =>
					Effect.gen(function* () {
						const streamError = mapSocketError(err);
						const connected = yield* Ref.get(isConnected);
						if (!connected) {
							yield* Deferred.fail(ready, streamError);
						} else {
							yield* finishIncoming(streamError);
						}
					}),
				),
				Effect.andThen(
					Effect.gen(function* () {
						const connected = yield* Ref.get(isConnected);
						if (connected) {
							yield* finishIncoming();
						}
					}),
				),
				Effect.forkIn(childScope),
			);

		// Await the handshake completion (or fail early on connection refusal)
		const readyExit = yield* Effect.exit(Deferred.await(ready));
		if (Exit.isFailure(readyExit)) {
			yield* Scope.close(childScope, Exit.void);
			return yield* Effect.failCause(readyExit.cause);
		}

		const writer = yield* socket.writer.pipe(Scope.provide(childScope));
		return { childScope, socket, writer };
	});

	const { childScope, writer } = yield* Option.match(retrySchedule, {
		onNone: () => connectAttempt,
		onSome: (schedule) => Effect.retry(connectAttempt, schedule),
	});

	const send = (data: Uint8Array): Effect.Effect<void, TcpStreamError> =>
		Effect.gen(function* () {
			const currentState = yield* Ref.get(state);
			if (currentState._tag === "Closed") {
				return yield* currentState.error ??
					new TcpStreamError({
						operation: "write",
						message: "Cannot send data on a closed TCP connection",
					});
			}

			yield* writer(data).pipe(Effect.mapError(mapSocketError));
		});

	// Pure Effect string encoding using Stream.encodeText and runFold
	const sendText = (data: string): Effect.Effect<void, TcpStreamError> =>
		Stream.make(data).pipe(
			Stream.encodeText,
			Stream.runFold(
				() => new Uint8Array(0),
				(acc: Uint8Array, chunk: Uint8Array): Uint8Array => {
					if (acc.byteLength === 0) return new Uint8Array(chunk);
					const merged = new Uint8Array(acc.byteLength + chunk.byteLength);
					merged.set(acc, 0);
					merged.set(chunk, acc.byteLength);
					return merged;
				},
			),
			Effect.flatMap(send),
		);

	const close = Effect.gen(function* () {
		yield* finishIncoming();
		yield* writer(new Socket.CloseEvent(1000)).pipe(
			Effect.catch(() => Effect.void),
		);
		yield* Scope.close(childScope, Exit.void);
	});

	return TcpStream.of({
		stream: Stream.fromQueue(incoming),
		send,
		sendText,
		close,
	});
});

/**
 * Convenience and composable layer for TcpStream using @effect/platform Socket.
 */
export function TcpStreamPlatformLive(
	config: ConnectionConfigShape,
): Layer.Layer<TcpStream>;
export function TcpStreamPlatformLive(): Layer.Layer<
	TcpStream,
	never,
	ConnectionConfig
>;
export function TcpStreamPlatformLive(config?: ConnectionConfigShape) {
	const base = Layer.effect(TcpStream, makeTcpStreamPlatform);
	return config !== undefined
		? base.pipe(Layer.provide(ConnectionConfigLive(config)))
		: base;
}
