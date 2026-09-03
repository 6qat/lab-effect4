import * as net from "node:net";
import * as tls from "node:tls";
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
 * Pure Node.js socket adapter for TcpStreamEngine using node:net and node:tls.
 *
 * Decisions made:
 * - Minimal raw socket adapter responsible solely for node:net / node:tls connections (Q1 -> Option A).
 * - Normalizes Node socket.write() to RawSocketWriteResult (Q4 -> Option A).
 * - Socket teardown handled via raw handle close() (Q6 -> Option B).
 */
const makeTcpStreamEngineNodejs: TcpStreamEngineShape = {
	connect: (
		config: ConnectionConfigShape,
		callbacks: SocketCallbacks,
	): Effect.Effect<RawSocketHandle, TcpStreamError> => {
		const connectOnce = Effect.callback<RawSocketHandle, TcpStreamError>(
			(resume) => {
				let settled = false;
				let socket: net.Socket;

				const cleanup = () => {
					socket?.removeListener("connect", onConnect);
					socket?.removeListener("secureConnect", onConnect);
					socket?.removeListener("error", onError);
				};

				const onConnect = () => {
					if (!settled) {
						settled = true;
						cleanup();

						socket.on("data", (chunk: Buffer) => {
							callbacks.onData(new Uint8Array(chunk));
						});

						socket.on("drain", () => {
							callbacks.onDrain();
						});

						socket.on("error", (cause) => {
							callbacks.onError(
								cause instanceof Error ? cause : new Error(String(cause)),
							);
						});

						socket.on("close", () => {
							callbacks.onClose();
						});

						let hasDestroyed = false;
						const rawHandle: RawSocketHandle = {
							write(chunk: Uint8Array): RawSocketWriteResult {
								const flushed = socket.write(chunk);
								return {
									bytesWritten: chunk.byteLength,
									flushed,
								};
							},
							close() {
								if (!hasDestroyed) {
									hasDestroyed = true;
									try {
										socket?.destroy();
									} catch {
										// Best-effort teardown
									}
								}
							},
						};

						resume(Effect.succeed(rawHandle));
					}
				};

				const onError = (cause: unknown) => {
					if (!settled) {
						settled = true;
						cleanup();
						socket?.destroy();
						resume(
							Effect.fail(
								new TcpStreamError({
									operation: "connect",
									message: `Connection failed: ${unknownToMessage(cause)}`,
									cause,
								}),
							),
						);
					}
				};

				try {
					if (config.tls) {
						const tlsOptions: tls.ConnectionOptions =
							typeof config.tls === "boolean"
								? {}
								: (config.tls as tls.ConnectionOptions);
						socket = tls.connect({
							...tlsOptions,
							host: config.host,
							port: config.port,
						});
						socket.once("secureConnect", onConnect);
					} else {
						socket = net.createConnection({
							host: config.host,
							port: config.port,
						});
						socket.once("connect", onConnect);
					}
					socket.once("error", onError);
				} catch (cause) {
					onError(cause);
				}

				return Effect.sync(() => {
					if (!settled) {
						settled = true;
						cleanup();
						socket?.destroy();
					}
				});
			},
		).pipe(
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
 * Adapter layer providing Node.js implementation of TcpStreamEngine.
 */
export const TcpStreamEngineNodejsLive = Layer.succeed(
	TcpStreamEngine,
	makeTcpStreamEngineNodejs,
);

/**
 * Packaged convenience layer for Node.js (Q2 -> Option C).
 * Combines TcpStreamLayer with TcpStreamEngineNodejsLive and optional ConnectionConfig.
 */
export const TcpStreamNodeLive = (config?: ConnectionConfigShape) => {
	const base = TcpStreamLayer.pipe(Layer.provide(TcpStreamEngineNodejsLive));
	return config !== undefined
		? base.pipe(Layer.provide(ConnectionConfigLive(config)))
		: base;
};

// Aliases for backward compatibility
export { TcpStreamNodeLive as TcpStreamNodejsLive };
export const ConnectionConfigNodeLive = ConnectionConfigLive;
export { ConnectionConfig as ConnectionConfigNode };
