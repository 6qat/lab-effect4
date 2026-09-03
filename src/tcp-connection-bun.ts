import { Effect, Layer } from "effect";
import {
	ConnectionConfig,
	ConnectionConfigLive,
	type ConnectionConfigShape,
	type RawSocketHandle,
	type RawSocketWriteResult,
	type SocketCallbacks,
	TcpStreamEngine,
	TcpStreamError,
	TcpStreamLayer,
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
			const connectOnce = Effect.tryPromise<RawSocketHandle, TcpStreamError>({
				try: async () => {
					const socket = await Bun.connect<undefined>({
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
								callbacks.onClose();
							},
							close() {
								callbacks.onClose();
							},
						},
					});

					let hasEnded = false;
					const rawHandle: RawSocketHandle = {
						write(chunk: Uint8Array): RawSocketWriteResult {
							const written = socket.write(chunk);
							socket.flush();
							return {
								bytesWritten: written,
								flushed: written === chunk.byteLength,
							};
						},
						close() {
							if (!hasEnded) {
								hasEnded = true;
								try {
									socket.end();
								} catch {
									// Best-effort teardown
								}
							}
						},
					};

					return rawHandle;
				},
				catch: (cause) =>
					new TcpStreamError({
						operation: "connect",
						message: `Failed to connect: ${unknownToMessage(cause)}`,
						cause,
					}),
			});

			return connectOnce;
		},
	}),
);

/**
 * Convenience Layer providing TcpStream powered by the Bun engine.
 */
export const TcpStreamBunLive = (config?: ConnectionConfigShape) => {
	const base = TcpStreamLayer.pipe(Layer.provide(TcpStreamEngineBunLive));
	return config !== undefined
		? base.pipe(Layer.provide(ConnectionConfigLive(config)))
		: base;
};

// Aliases for backward compatibility
export { TcpStreamBunLive as TcpStreamLive };
export const ConnectionConfigBunLive = ConnectionConfigLive;
export { ConnectionConfig as ConnectionConfigBun };
