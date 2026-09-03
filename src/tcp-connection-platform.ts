import * as tls from "node:tls";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	MutableRef,
	Option,
	Queue,
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
 *   - Plain TCP: delegates to NodeSocket.makeNet({ host, port }).
 *   - TLS: connects via tls.connect and wraps duplex stream via NodeSocket.fromDuplex.
 */
const createPlatformSocket = (
	config: ConnectionConfigShape,
): Effect.Effect<Socket.Socket, Socket.SocketError, Scope.Scope> => {
	if (!config.tls) {
		return NodeSocket.makeNet({
			host: config.host,
			port: config.port,
		});
	}

	const tlsOptions: tls.ConnectionOptions =
		typeof config.tls === "boolean"
			? {}
			: (config.tls as tls.ConnectionOptions);

	return NodeSocket.fromDuplex(
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
 * Architectural decisions:
 * - Parallel TcpStream implementation (Q2 -> Option A): Directly implements TcpStreamShape
 *   rather than shoehorning @effect/platform into the lower-level TcpStreamEngine.
 * - Push-to-Pull queue bridge (Q3 -> Option A): Forks socket.run in the connection scope,
 *   pushing received chunks into Queue.unbounded and reading via Stream.fromQueue.
 * - Readiness handshake deferred (Q4 -> Option A): Awaits socket.run({ onOpen }) so that
 *   initial connection failures trigger configured retry schedules before returning.
 * - Scoped lifecycle: Isolated child scopes per attempt ensure that failed attempts clean up
 *   immediately while the successful connection scope persists for the session.
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
	const state = MutableRef.make<ConnectionState>({ _tag: "Open" });

	const finishIncoming = (error?: TcpStreamError): boolean => {
		const currentState = MutableRef.get(state);
		if (currentState._tag === "Closed") {
			return false;
		}

		if (error) {
			MutableRef.set(state, { _tag: "Closed", error });
			Queue.failCauseUnsafe(incoming, Cause.fail(error));
		} else {
			MutableRef.set(state, { _tag: "Closed" });
			Queue.endUnsafe(incoming);
		}
		return true;
	};

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
		let isConnected = false;

		// Fork the push-based read loop in the child scope
		yield* socket
			.run(
				(chunk) => {
					Queue.offerUnsafe(incoming, chunk);
				},
				{
					onOpen: Effect.sync(() => {
						isConnected = true;
						Deferred.doneUnsafe(ready, Effect.void);
					}),
				},
			)
			.pipe(
				Effect.catch((err: Socket.SocketError) => {
					const streamError = mapSocketError(err);
					if (!isConnected) {
						Deferred.doneUnsafe(ready, Effect.fail(streamError));
					} else {
						finishIncoming(streamError);
					}
					return Effect.void;
				}),
				Effect.andThen(
					Effect.sync(() => {
						if (isConnected) {
							finishIncoming();
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
			const currentState = MutableRef.get(state);
			if (currentState._tag === "Closed") {
				return yield* currentState.error ??
					new TcpStreamError({
						operation: "write",
						message: "Cannot send data on a closed TCP connection",
					});
			}

			yield* writer(data).pipe(Effect.mapError(mapSocketError));
		});

	const encoder = new TextEncoder();
	const sendText = (data: string) => send(encoder.encode(data));

	const close = Effect.gen(function* () {
		finishIncoming();
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
export const TcpStreamPlatformLive = (config?: ConnectionConfigShape) => {
	const base = Layer.effect(TcpStream, makeTcpStreamPlatform);
	return config !== undefined
		? base.pipe(Layer.provide(ConnectionConfigLive(config)))
		: base;
};
