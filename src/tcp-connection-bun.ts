import { Effect, Layer } from "effect";
import {
	ConnectionConfig,
	ConnectionConfigLive,
	unknownToMessage,
} from "./tcp-connection-common.js";
import {
	makeConvenienceLayer,
	makeTcpStreamEngine,
	type RawSocketHandle,
	type RawSocketWriteResult,
	TcpStreamEngine,
	type TcpStreamEngineAdapterEvent,
	type TcpStreamEngineConfig,
	TcpStreamError,
} from "./tcp-stream-engine.js";

const adapter = (
	config: TcpStreamEngineConfig,
	emit: (event: TcpStreamEngineAdapterEvent) => "accepted" | "closed",
) =>
	Effect.callback<RawSocketHandle, unknown>((resume) => {
		let socket: Bun.Socket<undefined> | undefined;
		let settled = false;
		let cancelled = false;
		let ended = false;
		const terminate = (value: Bun.Socket<undefined> | undefined = socket) => {
			if (!value || ended) return;
			ended = true;
			try {
				value.terminate();
			} catch {
				try {
					value.end();
				} catch {}
			}
		};
		const fail = (cause: unknown) => {
			if (settled) return;
			settled = true;
			terminate();
			emit({ _tag: "Error", cause });
			resume(Effect.fail(cause));
		};
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
						if (!cancelled) emit({ _tag: "Data", chunk: data.slice() });
					},
					drain() {
						if (!cancelled) emit({ _tag: "Drain" });
					},
					end() {
						if (!cancelled) emit({ _tag: "Close" });
					},
					close() {
						if (!cancelled) emit({ _tag: "Close" });
					},
					error(_socket, cause) {
						if (!cancelled) {
							if (!settled) fail(cause);
							else emit({ _tag: "Error", cause });
						}
					},
					connectError(value, cause) {
						terminate(value);
						if (!cancelled) fail(cause);
					},
				},
			}).then((value) => {
				socket = value;
				if (cancelled) {
					terminate(value);
					return;
				}
				if (settled) return;
				const handle: RawSocketHandle = {
					write: (
						chunk: Uint8Array,
					): Effect.Effect<RawSocketWriteResult, TcpStreamError> =>
						Effect.try({
							try: () => {
								const bytesWritten = value.write(chunk);
								value.flush();
								return {
									bytesWritten,
									flushed: bytesWritten === chunk.byteLength,
								};
							},
							catch: (cause) =>
								new TcpStreamError({
									operation: "write",
									message: `Socket write failed: ${unknownToMessage(cause)}`,
									cause,
								}),
						}),
					close: () => Effect.sync(() => terminate(value)),
				};
				if (emit({ _tag: "Ready" }) === "closed") {
					terminate(value);
					return;
				}
				settled = true;
				resume(Effect.succeed(handle));
			}, fail);
		} catch (cause) {
			fail(cause);
		}
		return Effect.sync(() => {
			cancelled = true;
			terminate();
		});
	});

const engine = makeTcpStreamEngine(adapter);
export const TcpStreamEngineBunLive = Layer.succeed(TcpStreamEngine, engine);
export const TcpStreamBunLive = makeConvenienceLayer(TcpStreamEngineBunLive);
export { TcpStreamBunLive as TcpStreamLive };
export const ConnectionConfigBunLive = ConnectionConfigLive;
export * from "./tcp-connection-common.js";
export {
	type ConnectionEvent,
	TcpStreamEngine,
	type TcpStreamEngineConfig,
} from "./tcp-stream-engine.js";
export { ConnectionConfig as ConnectionConfigBun };
