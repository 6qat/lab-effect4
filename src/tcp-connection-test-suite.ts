import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Option, Schedule, Stream } from "effect";
import {
	type ConnectionConfig,
	ConnectionConfigLive,
	type ConnectionConfigShape,
	TcpStream,
	type TcpStreamEngine,
	TcpStreamLayer,
} from "./tcp-connection-common.js";

export interface TcpStreamTestSuiteOptions {
	readonly engineName: string;
	readonly layerFactory: {
		(config: ConnectionConfigShape): Layer.Layer<TcpStream>;
		(): Layer.Layer<TcpStream, never, ConnectionConfig>;
	};
	readonly basePort: number;
	readonly engineLayer?: Layer.Layer<TcpStreamEngine>;
}

export const defineTcpStreamTestSuite = ({
	engineName,
	layerFactory,
	basePort,
	engineLayer,
}: TcpStreamTestSuiteOptions) => {
	describe(`TcpStream ${engineName} operations and retry policy`, () => {
		it("fails with TcpStreamError after exhausting configured retry attempts on unreachable port", async () => {
			const unreachablePort = basePort + 3;

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port: unreachablePort,
				retry: {
					initialDelay: "10 millis",
					factor: 1.5,
					maxAttempts: 3,
					jitter: false,
				},
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
			const program = TcpStream.pipe(Effect.provide(tcpLayer));

			const startTime = Date.now();
			const exit = await Effect.runPromiseExit(program);
			const elapsed = Date.now() - startTime;

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const error = exit.cause;
				expect(error.toString()).toContain("TcpStreamError");
			}
			expect(elapsed).toBeGreaterThanOrEqual(25);
		});

		it("fails immediately when retry is disabled (retry: false)", async () => {
			const unreachablePort = basePort + 4;

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port: unreachablePort,
				retry: false,
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
			const program = TcpStream.pipe(Effect.provide(tcpLayer));

			const startTime = Date.now();
			const exit = await Effect.runPromiseExit(program);
			const elapsed = Date.now() - startTime;

			expect(Exit.isFailure(exit)).toBe(true);
			expect(elapsed).toBeLessThan(150);
		});

		it("supports custom retrySchedule", async () => {
			const unreachablePort = basePort + 6;
			let attempts = 0;

			const customSchedule = Schedule.recurs(2).pipe(
				Schedule.tap(() =>
					Effect.sync(() => {
						attempts++;
					}),
				),
			);

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port: unreachablePort,
				retrySchedule: customSchedule,
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
			const program = TcpStream.pipe(Effect.provide(tcpLayer));

			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(attempts).toBe(2);
		});

		it("recovers and connects successfully when server opens during retry backoff window", async () => {
			const port = basePort + 5;
			let server:
				| { stop: (closeActiveConnections?: boolean) => void }
				| undefined;

			setTimeout(() => {
				server = Bun.listen({
					hostname: "127.0.0.1",
					port,
					socket: {
						data(socket, data) {
							socket.write(data);
						},
					},
				});
			}, 50);

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port,
				retry: {
					initialDelay: "20 millis",
					factor: 1.5,
					maxAttempts: 6,
					jitter: false,
				},
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));

			const program = Effect.gen(function* () {
				const tcp = yield* TcpStream;
				yield* tcp.sendText(`hello ${engineName} retry`);
				const chunk = yield* Stream.runHead(tcp.stream);
				yield* tcp.close;
				return chunk;
			}).pipe(Effect.provide(tcpLayer));

			try {
				const exit = await Effect.runPromiseExit(program);
				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					const maybeChunk = exit.value;
					expect(Option.isSome(maybeChunk)).toBe(true);
					if (Option.isSome(maybeChunk)) {
						const received = new TextDecoder().decode(maybeChunk.value);
						expect(received).toBe(`hello ${engineName} retry`);
					}
				}
			} finally {
				server?.stop(true);
			}
		});

		it("sends binary data and closes gracefully", async () => {
			const port = basePort + 7;
			let server:
				| { stop: (closeActiveConnections?: boolean) => void }
				| undefined;

			server = Bun.listen({
				hostname: "127.0.0.1",
				port,
				socket: {
					data(socket, data) {
						socket.write(data);
					},
				},
			});

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port,
				retry: false,
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
			const payload = new Uint8Array([1, 2, 3, 4, 5]);

			const program = Effect.gen(function* () {
				const tcp = yield* TcpStream;
				yield* tcp.send(payload);
				const chunk = yield* Stream.runHead(tcp.stream);
				yield* tcp.close;
				return chunk;
			}).pipe(Effect.provide(tcpLayer));

			try {
				const exit = await Effect.runPromiseExit(program);
				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					const maybeChunk = exit.value;
					expect(Option.isSome(maybeChunk)).toBe(true);
					if (Option.isSome(maybeChunk)) {
						expect(Array.from(maybeChunk.value)).toEqual(Array.from(payload));
					}
				}
			} finally {
				server?.stop(true);
			}
		});

		if (engineLayer) {
			it("supports composable layer composition with TcpStreamLayer and engine live layer", async () => {
				const port = basePort + 8;
				let server:
					| { stop: (closeActiveConnections?: boolean) => void }
					| undefined;

				server = Bun.listen({
					hostname: "127.0.0.1",
					port,
					socket: {
						data(socket, data) {
							socket.write(data);
						},
					},
				});

				const configLayer = ConnectionConfigLive({
					host: "127.0.0.1",
					port,
					retry: false,
				});

				const tcpLayer = TcpStreamLayer.pipe(
					Layer.provide(engineLayer),
					Layer.provide(configLayer),
				);

				const program = Effect.gen(function* () {
					const tcp = yield* TcpStream;
					yield* tcp.sendText("composable-engine");
					const chunk = yield* Stream.runHead(tcp.stream);
					yield* tcp.close;
					return chunk;
				}).pipe(Effect.provide(tcpLayer));

				try {
					const exit = await Effect.runPromiseExit(program);
					expect(Exit.isSuccess(exit)).toBe(true);
					if (Exit.isSuccess(exit)) {
						const maybeChunk = exit.value;
						expect(Option.isSome(maybeChunk)).toBe(true);
						if (Option.isSome(maybeChunk)) {
							const received = new TextDecoder().decode(maybeChunk.value);
							expect(received).toBe("composable-engine");
						}
					}
				} finally {
					server?.stop(true);
				}
			});
		}
	});
};
