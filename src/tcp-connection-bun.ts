import { Effect, Layer } from "effect";
import {
	ConnectionConfig,
	ConnectionConfigLive,
	type ConnectionConfigShape,
	type RawSocketHandle,
	type RawSocketWriteResult,
	type SocketCallbacks,
	TcpStreamEngine,
	type TcpStreamEngineShape,
	TcpStreamError,
	TcpStreamLayer,
	unknownToMessage,
} from "./tcp-connection-common.js";

export * from "./tcp-connection-common.js";

/**
 * Pure Bun socket adapter for TcpStreamEngine.
 *
 * Decisions made:
 * - Minimal raw socket adapter responsible solely for Bun.connect and socket callbacks (Q1 -> Option A).
 * - Normalizes Bun socket.write() to RawSocketWriteResult (Q4 -> Option A).
 * - Socket teardown handled via raw handle close() (Q6 -> Option B).
 */
const makeTcpStreamEngineBun: TcpStreamEngineShape = {
	connect: (
		config: ConnectionConfigShape,
		callbacks: SocketCallbacks,
	): Effect.Effect<RawSocketHandle, TcpStreamError> => {
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
					message: `Connection failed: ${unknownToMessage(cause)}`,
					cause,
				}),
		}).pipe(
			Effect.timeout("3 seconds"),
			Effect.mapError((cause) =>
				cause instanceof TcpStreamError
					? cause
					: new TcpStreamError({
							operation: "connect",
							message: "Connection timeout",
							cause,
						}),
			),
		);

		return connectOnce;
	},
};

/**
 * Adapter layer providing Bun implementation of TcpStreamEngine.
 */
export const TcpStreamEngineBunLive = Layer.succeed(
	TcpStreamEngine,
	makeTcpStreamEngineBun,
);

/**
 * Packaged convenience layer for Bun (Q2 -> Option C).
 * Combines TcpStreamLayer with TcpStreamEngineBunLive and optional ConnectionConfig.
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
