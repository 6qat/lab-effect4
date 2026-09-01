import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Option, Schedule, Stream } from "effect";
import {
	ConnectionConfigBunLive,
	TcpStream,
	TcpStreamBunLive,
} from "./tcp-connection-bun.js";

describe("TcpStream Bun retry policy", () => {
	it("fails with TcpStreamError after exhausting configured retry attempts on unreachable port", async () => {
		const unreachablePort = 59123;

		const configLayer = ConnectionConfigBunLive({
			host: "127.0.0.1",
			port: unreachablePort,
			retry: {
				initialDelay: "10 millis",
				factor: 1.5,
				maxAttempts: 3,
				jitter: false,
			},
		});

		const tcpLayer = TcpStreamBunLive().pipe(Layer.provide(configLayer));
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
		const unreachablePort = 59124;

		const configLayer = ConnectionConfigBunLive({
			host: "127.0.0.1",
			port: unreachablePort,
			retry: false,
		});

		const tcpLayer = TcpStreamBunLive().pipe(Layer.provide(configLayer));
		const program = TcpStream.pipe(Effect.provide(tcpLayer));

		const startTime = Date.now();
		const exit = await Effect.runPromiseExit(program);
		const elapsed = Date.now() - startTime;

		expect(Exit.isFailure(exit)).toBe(true);
		expect(elapsed).toBeLessThan(150);
	});

	it("supports custom retrySchedule", async () => {
		const unreachablePort = 59126;
		let attempts = 0;

		const customSchedule = Schedule.recurs(2).pipe(
			Schedule.tap(() =>
				Effect.sync(() => {
					attempts++;
				}),
			),
		);

		const configLayer = ConnectionConfigBunLive({
			host: "127.0.0.1",
			port: unreachablePort,
			retrySchedule: customSchedule,
		});

		const tcpLayer = TcpStreamBunLive().pipe(Layer.provide(configLayer));
		const program = TcpStream.pipe(Effect.provide(tcpLayer));

		const exit = await Effect.runPromiseExit(program);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(attempts).toBe(2);
	});

	it("recovers and connects successfully when server opens during retry backoff window", async () => {
		const port = 59125;
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

		const configLayer = ConnectionConfigBunLive({
			host: "127.0.0.1",
			port,
			retry: {
				initialDelay: "20 millis",
				factor: 1.5,
				maxAttempts: 6,
				jitter: false,
			},
		});

		const tcpLayer = TcpStreamBunLive().pipe(Layer.provide(configLayer));

		const program = Effect.gen(function* () {
			const tcp = yield* TcpStream;
			yield* tcp.sendText("hello retry");
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
					expect(received).toBe("hello retry");
				}
			}
		} finally {
			server?.stop(true);
		}
	});
});
