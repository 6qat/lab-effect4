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
					const notifyClose = () => {
						if (!hasClosed) {
							hasClosed = true;
							callbacks.onClose();
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
									callbacks.onData(data);
								},
								drain() {
									callbacks.onDrain();
								},
								error(_socket, cause) {
									callbacks.onError(
										cause instanceof Error ? cause : new Error(String(cause)),
									);
								},
								end() {
									notifyClose();
								},
								close() {
									notifyClose();
								},
							},
						}).then(
							(socket) => {
								if (cancelled) {
									try {
										socket.end();
									} catch {
										// Best-effort teardown
									}
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
					// `Bun.connect` exposes no abort signal, so a connect that is
					// still pending at this point cannot be torn down until the
					// promise settles — the `cancelled` flag guarantees that
					// settlement never leaks the socket.
					return Effect.sync(() => {
						cancelled = true;
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
