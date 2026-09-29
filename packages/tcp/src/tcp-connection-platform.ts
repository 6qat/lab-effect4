import * as tls from "node:tls";
import { BunSocket } from "@effect/platform-bun";
import { Deferred, Effect, Exit, Layer, Scope } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { unknownToMessage } from "./tcp-connection-common.js";
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

const createSocket = (
	config: TcpStreamEngineConfig,
): Effect.Effect<Socket.Socket, Socket.SocketError, Scope.Scope> => {
	if (!config.tls)
		return BunSocket.makeNet({ host: config.host, port: config.port });
	const options: tls.ConnectionOptions =
		typeof config.tls === "boolean"
			? {}
			: (config.tls as tls.ConnectionOptions);
	return BunSocket.fromDuplex(
		Effect.callback<tls.TLSSocket, Socket.SocketError>((resume) => {
			const socket = tls.connect({
				...options,
				host: config.host,
				port: config.port,
			});
			const onError = (cause: unknown) =>
				resume(
					Effect.fail(
						new Socket.SocketError({
							reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
						}),
					),
				);
			socket.once("secureConnect", () => {
				socket.removeListener("error", onError);
				resume(Effect.succeed(socket));
			});
			socket.once("error", onError);
			return Effect.sync(() => socket.destroy());
		}),
	);
};

const adapter = (
	config: TcpStreamEngineConfig,
	emit: (event: TcpStreamEngineAdapterEvent) => "accepted" | "closed",
) =>
	Effect.gen(function* () {
		const parent = yield* Scope.Scope;
		const owner = yield* Scope.fork(parent, "sequential");
		const setup = Effect.gen(function* () {
			const socket = yield* createSocket(config).pipe(Scope.provide(owner));
			const ready = yield* Deferred.make<void, unknown>();
			const run = socket
				.run(
					(chunk) => {
						emit({ _tag: "Data", chunk: chunk.slice() });
					},
					{
						onOpen: Effect.sync(() => {
							Deferred.doneUnsafe(ready, Effect.succeed(void 0));
						}),
					},
				)
				.pipe(
					Effect.catch((cause) =>
						Effect.sync(() => {
							emit({ _tag: "Error", cause });
							Deferred.doneUnsafe(ready, Effect.fail(cause));
						}),
					),
					Effect.andThen(Effect.sync(() => emit({ _tag: "Close" }))),
				);
			yield* run.pipe(Effect.forkIn(owner));
			yield* Deferred.await(ready);
			const writer = yield* socket.writer.pipe(Scope.provide(owner));
			let closed = false;
			const handle: RawSocketHandle = {
				write: (
					chunk: Uint8Array,
				): Effect.Effect<RawSocketWriteResult, TcpStreamError> =>
					writer(chunk).pipe(
						Effect.map(() => ({
							bytesWritten: chunk.byteLength,
							flushed: true,
						})),
						Effect.mapError(
							(cause) =>
								new TcpStreamError({
									operation: "write",
									message: `Socket write failed: ${unknownToMessage(cause)}`,
									cause,
								}),
						),
					),
				close: () => {
					if (closed) return Effect.void;
					closed = true;
					return Scope.close(owner, Exit.void);
				},
			};
			if (emit({ _tag: "Ready" }) === "closed") {
				closed = true;
				yield* Scope.close(owner, Exit.void);
				return yield* Effect.fail(new Error("Connection attempt was rejected"));
			}
			return handle;
		});
		return yield* Effect.onExit(setup, (exit) =>
			Exit.isSuccess(exit) ? Effect.void : Scope.close(owner, exit),
		);
	});

const engine = makeTcpStreamEngine(adapter);
export const TcpStreamEnginePlatformLive = Layer.succeed(
	TcpStreamEngine,
	engine,
);
export const TcpStreamPlatformLive = makeConvenienceLayer(
	TcpStreamEnginePlatformLive,
);
export * from "./tcp-connection-common.js";
export {
	type ConnectionEvent,
	TcpStreamEngine,
	type TcpStreamEngineConfig,
} from "./tcp-stream-engine.js";
