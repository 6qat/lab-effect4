import * as tls from "node:tls";
import { BunSocket } from "@effect/platform-bun";
import { Context, Deferred, Effect, Exit, Layer, Ref, Scope } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import {
	type ConnectionConfigShape,
	makeConvenienceLayer,
	makeTcpStream,
	type RawSocketHandle,
	type RawSocketWriteResult,
	type SocketCallbacks,
	TcpStreamEngine,
	type TcpStreamEngineShape,
	TcpStreamError,
	unknownToMessage,
} from "./tcp-connection-common.js";

export * from "./tcp-connection-common.js";

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
 * Engine adapter implementation for @effect/platform Socket.
 */
const makeTcpStreamEnginePlatform: TcpStreamEngineShape = {
	connect: (
		config: ConnectionConfigShape,
		callbacks: SocketCallbacks,
	): Effect.Effect<RawSocketHandle, TcpStreamError, Scope.Scope> =>
		Effect.gen(function* () {
			// Fork a child of the ambient scope (rather than an orphaned
			// Scope.make()) so an interrupted or finalizing ambient scope
			// always tears down this connection too, even if `close()` is
			// never explicitly invoked.
			const parentScope = yield* Scope.Scope;
			const childScope = yield* Scope.fork(parentScope);

			const socket = yield* createPlatformSocket(config).pipe(
				Effect.mapError(mapSocketError),
				Scope.provide(childScope),
			);

			const ready = yield* Deferred.make<void, TcpStreamError>();
			const isConnected = yield* Ref.make(false);

			yield* socket
				.run(
					(chunk) => {
						callbacks.onData(chunk);
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
								callbacks.onError(new Error(streamError.message));
							}
						}),
					),
					Effect.andThen(
						Effect.gen(function* () {
							const connected = yield* Ref.get(isConnected);
							if (connected) {
								callbacks.onClose();
							}
						}),
					),
					Effect.forkIn(childScope),
				);

			const readyExit = yield* Effect.exit(Deferred.await(ready));
			if (Exit.isFailure(readyExit)) {
				yield* Scope.close(childScope, Exit.void);
				return yield* Effect.failCause(readyExit.cause);
			}

			const writer = yield* socket.writer.pipe(Scope.provide(childScope));

			const rawHandle: RawSocketHandle = {
				write: (
					chunk: Uint8Array,
				): Effect.Effect<RawSocketWriteResult, TcpStreamError> =>
					writer(chunk).pipe(
						Effect.mapBoth({
							onFailure: mapSocketError,
							onSuccess: () => ({
								bytesWritten: chunk.byteLength,
								flushed: true,
							}),
						}),
					),
				// Scope.close is idempotent (a no-op once the scope is already
				// closed), so close() can unconditionally close childScope
				// instead of tracking "already closed" separately from
				// "the read loop already ended" — the two are not the same
				// thing, and conflating them previously skipped teardown
				// (destroying the socket, ending the writer) whenever the
				// remote side closed the connection before close() was
				// called explicitly.
				close: (): Effect.Effect<void> => Scope.close(childScope, Exit.void),
			};

			return rawHandle;
		}),
};

/**
 * Adapter layer providing @effect/platform implementation of TcpStreamEngine.
 */
export const TcpStreamEnginePlatformLive = Layer.succeed(
	TcpStreamEngine,
	makeTcpStreamEnginePlatform,
);

/**
 * Convenience Layer providing TcpStream powered by the Platform engine.
 */
export const TcpStreamPlatformLive = makeConvenienceLayer(
	TcpStreamEnginePlatformLive,
);

/**
 * Programmatic constructor for TcpStreamPlatform, reusing the shared orchestrator.
 */
export const makeTcpStreamPlatform = makeTcpStream.pipe(
	Effect.provide(TcpStreamEnginePlatformLive),
);
