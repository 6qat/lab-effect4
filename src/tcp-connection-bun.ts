import { Effect, Layer } from "effect";
import {
	ConnectionConfig,
	ConnectionConfigLive,
	type ConnectionConfigShape,
	makeConvenienceLayer,
	type RawSocketHandle,
	type RawSocketWriteResult,
	type SocketCallbacks,
	TcpStreamEngine,
	TcpStreamError,
	unknownToMessage,
} from "./tcp-connection-common.js";

export * from "./tcp-connection-common.js";

/**
 * Low-level adapter for Bun.connect implementing the TcpStreamEngine seam.
 *
 * Decisions made:
 * - Direct engine seam implementation (ADR 0002): Adapts Bun's socket callbacks
 *   into the unified engine lifecycle.
 * - Handles both end() (remote EOF) and close() (socket termination) events.
 */
export const TcpStreamEngineBunLive = Layer.succeed(
	TcpStreamEngine,
	TcpStreamEngine.of({
		connect: (config: ConnectionConfigShape, callbacks: SocketCallbacks) => {
			const connectOnce = Effect.callback<RawSocketHandle, TcpStreamError>(
				(resume) => {
					let hasClosed = false;
					let connectedSocket: Bun.Socket<undefined> | undefined;
					const notifyClose = () => {
						if (!hasClosed) {
							hasClosed = true;
							callbacks.onClose();
						}
					};
					const terminateSocket = (socket: Bun.Socket<undefined>) => {
						try {
							socket.terminate();
						} catch {
							try {
								socket.end();
							} catch {
								// Best-effort teardown
							}
						}
					};

					let hasEnded = false;
					const makeHandle = (socket: Bun.Socket<undefined>) => {
						const rawHandle: RawSocketHandle = {
							write(
								chunk: Uint8Array,
							): Effect.Effect<RawSocketWriteResult, TcpStreamError> {
								return Effect.try({
									try: () => {
										const written = socket.write(chunk);
										socket.flush();
										return {
											bytesWritten: written,
											flushed: written === chunk.byteLength,
										};
									},
									catch: (cause) =>
										new TcpStreamError({
											operation: "write",
											message: `Socket write failed: ${unknownToMessage(cause)}`,
											cause,
										}),
								});
							},
							close(): Effect.Effect<void> {
								return Effect.sync(() => {
									if (!hasEnded) {
										hasEnded = true;
										try {
											socket.end();
										} catch {
											// Best-effort teardown
										}
									}
								});
							},
						};
						return rawHandle;
					};

					// If the acquiring fiber is interrupted while `Bun.connect`
					// is still in flight, the promise may still resolve
					// afterwards. `cancelled` routes that late resolution to an
					// immediate socket teardown instead of handing over a
					// handle nobody will ever release (the Node.js engine
					// covers the same window via its `Effect.callback` cleanup).
					let cancelled = false;
					const failConnect = (cause: unknown) =>
						Effect.fail(
							new TcpStreamError({
								operation: "connect",
								message: `Failed to connect: ${unknownToMessage(cause)}`,
								cause,
							}),
						);

					try {
						void Bun.connect<undefined>({
							hostname: config.host,
							port: config.port,
							...(config.tls === undefined
								? {}
								: { tls: config.tls as boolean | Bun.TLSOptions }),
							socket: {
								binaryType: "uint8array",
								data(_socket, data) {
									if (!cancelled) {
										callbacks.onData(data);
									}
								},
								drain() {
									if (!cancelled) {
										callbacks.onDrain();
									}
								},
								error(_socket, cause) {
									if (!cancelled) {
										callbacks.onError(
											cause instanceof Error ? cause : new Error(String(cause)),
										);
									}
								},
								end() {
									if (!cancelled) {
										notifyClose();
									}
								},
								close() {
									if (!cancelled) {
										notifyClose();
									}
								},
								connectError(socket, cause) {
									if (cancelled) {
										terminateSocket(socket);
										return;
									}
									resume(failConnect(cause));
								},
							},
						}).then(
							(socket) => {
								connectedSocket = socket;
								if (cancelled) {
									terminateSocket(socket);
									return;
								}
								resume(Effect.succeed(makeHandle(socket)));
							},
							(cause) => {
								if (cancelled) return;
								resume(failConnect(cause));
							},
						);
					} catch (cause) {
						resume(failConnect(cause));
					}

					// Interruption cleanup: mark the in-flight connect cancelled.
					// `Bun.connect` exposes no abort signal or socket handle before
					// settlement, so a still-pending connect cannot be torn down at
					// this point. If the socket becomes visible during the race,
					// terminate it immediately; otherwise the late-resolution branch
					// does the same and all event callbacks remain inert.
					return Effect.sync(() => {
						cancelled = true;
						if (connectedSocket !== undefined) {
							terminateSocket(connectedSocket);
						}
					});
				},
			);

			return connectOnce;
		},
	}),
);

/**
 * Convenience Layer providing TcpStream powered by the Bun engine.
 */
export const TcpStreamBunLive = makeConvenienceLayer(TcpStreamEngineBunLive);

// Aliases for backward compatibility
export { TcpStreamBunLive as TcpStreamLive };
export const ConnectionConfigBunLive = ConnectionConfigLive;
export { ConnectionConfig as ConnectionConfigBun };
