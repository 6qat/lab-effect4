import * as net from "node:net";
import * as tls from "node:tls";
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

type Socket = net.Socket;
const adapter = (
	config: TcpStreamEngineConfig,
	emit: (event: TcpStreamEngineAdapterEvent) => "accepted" | "closed",
) =>
	Effect.callback<RawSocketHandle, unknown>((resume) => {
		let socket: Socket | undefined;
		let settled = false;
		let cancelled = false;
		let destroyed = false;
		const destroy = () => {
			if (!destroyed) {
				destroyed = true;
				socket?.destroy();
			}
		};
		const fail = (cause: unknown) => {
			if (settled) return;
			settled = true;
			destroy();
			emit({ _tag: "Error", cause });
			resume(Effect.fail(cause));
		};
		const onReady = () => {
			if (settled || cancelled) return;
			const handle: RawSocketHandle = {
				write: (
					chunk: Uint8Array,
				): Effect.Effect<RawSocketWriteResult, TcpStreamError> =>
					Effect.try({
						try: () => ({
							bytesWritten: chunk.byteLength,
							flushed: socket?.write(chunk) ?? false,
						}),
						catch: (cause) =>
							new TcpStreamError({
								operation: "write",
								message: `Socket write failed: ${unknownToMessage(cause)}`,
								cause,
							}),
					}),
				close: () => Effect.sync(destroy),
			};
			if (emit({ _tag: "Ready" }) === "closed") {
				destroy();
				return;
			}
			settled = true;
			resume(Effect.succeed(handle));
		};
		const onError = (cause: unknown) => {
			if (!settled) fail(cause);
			else emit({ _tag: "Error", cause });
		};
		try {
			socket = config.tls
				? tls.connect({
						...(typeof config.tls === "boolean"
							? {}
							: (config.tls as tls.ConnectionOptions)),
						host: config.host,
						port: config.port,
					})
				: net.createConnection({ host: config.host, port: config.port });
			socket.on("data", (chunk) => {
				if (cancelled) return;
				emit({
					_tag: "Data",
					chunk:
						typeof chunk === "string"
							? new TextEncoder().encode(chunk)
							: new Uint8Array(chunk).slice(),
				});
			});
			socket.on("drain", () => {
				if (!cancelled) emit({ _tag: "Drain" });
			});
			socket.once("close", () => {
				if (!cancelled) emit({ _tag: "Close" });
			});
			socket.once("error", onError);
			socket.once(config.tls ? "secureConnect" : "connect", onReady);
		} catch (cause) {
			fail(cause);
		}
		return Effect.sync(() => {
			cancelled = true;
			if (!settled) {
				settled = true;
				destroy();
			}
		});
	});

const engine = makeTcpStreamEngine(adapter);
export const TcpStreamEngineNodejsLive = Layer.succeed(TcpStreamEngine, engine);
export const TcpStreamNodejsLive = makeConvenienceLayer(
	TcpStreamEngineNodejsLive,
);
export { TcpStreamNodejsLive as TcpStreamNodeLive };
export const ConnectionConfigNodejsLive = ConnectionConfigLive;
export * from "./tcp-connection-common.js";
export {
	type ConnectionEvent,
	TcpStreamEngine,
	type TcpStreamEngineConfig,
} from "./tcp-stream-engine.js";
export {
	ConnectionConfig as ConnectionConfigNodejs,
	ConnectionConfig as ConnectionConfigNode,
	ConnectionConfigNodejsLive as ConnectionConfigNodeLive,
};
