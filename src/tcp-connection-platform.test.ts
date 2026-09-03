import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Option, Schedule, Stream } from "effect";
import {
	ConnectionConfigLive,
	TcpStream,
	TcpStreamPlatformLive,
} from "./tcp-connection-platform.js";

describe("TcpStream Platform (@effect/platform Socket.Socket.run)", () => {
	it("fails with TcpStreamError after exhausting configured retry attempts on unreachable port", async () => {
		const unreachablePort = 59323;

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

		const tcpLayer = TcpStreamPlatformLive().pipe(Layer.provide(configLayer));
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
		const unreachablePort = 59324;

		const configLayer = ConnectionConfigLive({
			host: "127.0.0.1",
			port: unreachablePort,
			retry: false,
		});

		const tcpLayer = TcpStreamPlatformLive().pipe(Layer.provide(configLayer));
		const program = TcpStream.pipe(Effect.provide(tcpLayer));

		const startTime = Date.now();
		const exit = await Effect.runPromiseExit(program);
		const elapsed = Date.now() - startTime;

		expect(Exit.isFailure(exit)).toBe(true);
		expect(elapsed).toBeLessThan(150);
	});

	it("supports custom retrySchedule", async () => {
		const unreachablePort = 59326;
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

		const tcpLayer = TcpStreamPlatformLive().pipe(Layer.provide(configLayer));
		const program = TcpStream.pipe(Effect.provide(tcpLayer));

		const exit = await Effect.runPromiseExit(program);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(attempts).toBe(2);
	});

	it("recovers and connects successfully when server opens during retry backoff window", async () => {
		const port = 59325;
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

		const tcpLayer = TcpStreamPlatformLive().pipe(Layer.provide(configLayer));

		const program = Effect.gen(function* () {
			const tcp = yield* TcpStream;
			yield* tcp.sendText("hello platform retry");
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
					expect(received).toBe("hello platform retry");
				}
			}
		} finally {
			server?.stop(true);
		}
	});

	it("sends binary data and closes gracefully", async () => {
		const port = 59327;
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

		const tcpLayer = TcpStreamPlatformLive().pipe(Layer.provide(configLayer));

		const payload = new Uint8Array([10, 20, 30, 40, 50]);

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
});
