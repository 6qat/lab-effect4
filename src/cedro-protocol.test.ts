import { describe, expect, it } from "bun:test";
import { Effect, Exit, Layer, Stream } from "effect";
import {
	CedroClient,
	CedroClientLive,
	CedroConfigLive,
} from "./cedro-protocol.js";
import { ConnectionConfigLive, TcpStreamLive } from "./tcp-connection.js";

describe("CedroProtocol", () => {
	it("composes layers cleanly and sends authentication and subscription frames over TCP", async () => {
		const port = 59230;
		const receivedData: string[] = [];

		const server = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: {
				data(socket, data) {
					const text = new TextDecoder().decode(data);
					receivedData.push(text);
					socket.write("ACK\n");
				},
			},
		});

		const tcpConfig = ConnectionConfigLive({
			host: "127.0.0.1",
			port,
			retry: false,
		});

		const cedroConfig = CedroConfigLive({
			magicToken: "TOKEN_123",
			username: "trader_user",
			password: "secret_password",
			tickers: ["PETR4", "VALE3"],
		});

		// Compose Cedro layer: CedroClientLive requires TcpStream & CedroConfig
		const tcpLayer = TcpStreamLive().pipe(Layer.provide(tcpConfig));
		const cedroLayer = CedroClientLive.pipe(
			Layer.provide(Layer.merge(tcpLayer, cedroConfig)),
		);

		const program = Effect.gen(function* () {
			const client = yield* CedroClient;
			yield* client.authenticate();
			yield* client.subscribe(["PETR4", "VALE3"]);
			// Await acknowledgement chunk from server
			yield* Stream.runHead(client.lines);
		}).pipe(Effect.provide(cedroLayer));

		try {
			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(receivedData.join("")).toContain(
				"AUTH|TOKEN_123|trader_user|secret_password\n",
			);
			expect(receivedData.join("")).toContain("SUB|PETR4,VALE3\n");
		} finally {
			server.stop(true);
		}
	});

	it("frames fragmented and batched byte streams into discrete lines", async () => {
		const port = 59232;

		const server = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: {
				open(socket) {
					// 1. Send fragmented line across two writes
					socket.write("AUTH|O");
					setTimeout(() => {
						socket.write("K\n");
						// 2. Send multiple lines in a single write
						socket.write("QUOTE|PETR4|30.50\nQUOTE|VALE3|60.00\n");
						// 3. Send another fragmented line and close
						socket.write("HEART");
						setTimeout(() => {
							socket.write("BEAT\n");
							socket.end();
						}, 20);
					}, 20);
				},
				data() {},
			},
		});

		const tcpConfig = ConnectionConfigLive({
			host: "127.0.0.1",
			port,
			retry: false,
		});

		const cedroConfig = CedroConfigLive({
			magicToken: "TOKEN_123",
			username: "trader_user",
			password: "secret_password",
			tickers: ["PETR4", "VALE3"],
		});

		const tcpLayer = TcpStreamLive().pipe(Layer.provide(tcpConfig));
		const cedroLayer = CedroClientLive.pipe(
			Layer.provide(Layer.merge(tcpLayer, cedroConfig)),
		);

		const program = Effect.gen(function* () {
			const client = yield* CedroClient;
			return yield* Stream.runCollect(client.lines);
		}).pipe(Effect.provide(cedroLayer));

		try {
			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isSuccess(exit)).toBe(true);
			if (Exit.isSuccess(exit)) {
				const lines = Array.from(exit.value);
				expect(lines).toEqual([
					"AUTH|OK",
					"QUOTE|PETR4|30.50",
					"QUOTE|VALE3|60.00",
					"HEARTBEAT",
				]);
			}
		} finally {
			server.stop(true);
		}
	});

	it("fails with CedroProtocolError when credentials are missing", async () => {
		const port = 59231;

		const server = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: {
				data() {},
			},
		});

		const tcpConfig = ConnectionConfigLive({
			host: "127.0.0.1",
			port,
			retry: false,
		});

		const cedroConfig = CedroConfigLive({
			magicToken: "",
			username: "trader_user",
			password: "secret_password",
			tickers: [],
		});

		const tcpLayer = TcpStreamLive().pipe(Layer.provide(tcpConfig));
		const cedroLayer = CedroClientLive.pipe(
			Layer.provide(Layer.merge(tcpLayer, cedroConfig)),
		);

		const program = Effect.gen(function* () {
			const client = yield* CedroClient;
			yield* client.authenticate();
		}).pipe(Effect.provide(cedroLayer));

		try {
			const exit = await Effect.runPromiseExit(program);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(exit.cause.toString()).toContain("CedroProtocolError");
			}
		} finally {
			server.stop(true);
		}
	});
});
