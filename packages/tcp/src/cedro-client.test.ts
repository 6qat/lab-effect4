import { describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Layer, Stream } from "effect";
import {
	CedroAuthRejectionError,
	CedroAuthTimeoutError,
	receiveCedroCommands,
	runCedroSession,
} from "./cedro-client.js";
import {
	CedroClient,
	CedroClientLive,
	CedroConfigLive,
} from "./cedro-protocol.js";
import { TcpStream, TcpStreamLive } from "./tcp-connection.js";

const credentials = {
	magicToken: "magic-key",
	username: "test-user",
	password: "test-password",
};

describe("Cedro client", () => {
	it("runs the reusable command with the requested environment names and redacts echoed credentials", async () => {
		const token = "magic-test-user-key";
		const expectedLogin = `${token}\n${credentials.username}\n${credentials.password}\n`;
		let received = "";
		let replied = false;
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					received += new TextDecoder().decode(data);
					if (!replied && received.split("\n").length >= 4) {
						replied = true;
						socket.end(
							`You are connected\n${token} ${credentials.username} ${credentials.password}\nQUOTE|PETR4|42.10\nQUOTE|PETR4|42.11\n`,
						);
					}
				},
			},
		});
		const child = Bun.spawn([process.execPath, "run", "cedro"], {
			cwd: `${import.meta.dir}/../../..`,
			env: {
				PATH: process.env.PATH,
				CEDRO_HOST: "127.0.0.1",
				CEDRO_PORT: String(server.port),
				CEDRO_TOKEN: token,
				CEDRO_USERNAME: credentials.username,
				CEDRO_PASSWORD: credentials.password,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeout = setTimeout(() => child.kill(), 3000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode).toBe(0);
			expect(received).toBe(expectedLogin);
			expect(stdout).toBe(
				"You are connected\n[REDACTED] [REDACTED] [REDACTED]\nQUOTE|PETR4|42.10\nQUOTE|PETR4|42.11\n",
			);
			for (const secret of [
				token,
				credentials.username,
				credentials.password,
			]) {
				expect(stdout).not.toContain(secret);
				expect(stderr).not.toContain(secret);
			}
		} finally {
			clearTimeout(timeout);
			child.kill();
			server.stop(true);
		}
	});

	it("sends the login fields immediately, then receives server lines until disconnect", async () => {
		let received = "";
		let replied = false;
		const expectedLogin = "magic-key\ntest-user\ntest-password\n";
		const lines: string[] = [];
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					received += new TextDecoder().decode(data);
					if (!replied && received.split("\n").length >= 4) {
						replied = true;
						// Arbitrary server text, not an assumed authentication response.
						socket.end("SERVER MESSAGE\nCOMMAND|one\nCOMMAND|two\n");
					}
				},
			},
		});
		const layer = CedroClientLive.pipe(
			Layer.provide(
				Layer.merge(
					TcpStreamLive({ host: "127.0.0.1", port: server.port, retry: false }),
					CedroConfigLive(credentials),
				),
			),
		);
		try {
			await Effect.runPromise(
				receiveCedroCommands((line) =>
					Effect.sync(() => {
						lines.push(line);
					}),
				).pipe(Effect.provide(layer), Effect.timeout("2 seconds")),
			);
			expect(received).toBe(expectedLogin);
			expect(lines).toEqual(["SERVER MESSAGE", "COMMAND|one", "COMMAND|two"]);
		} finally {
			server.stop(true);
		}
	});

	for (const field of ["magicToken", "username", "password"] as const) {
		for (const separator of ["\n", "\r"]) {
			it(`rejects ${field} containing ${JSON.stringify(separator)} before sending anything`, async () => {
				const sent: string[] = [];
				const layer = CedroClientLive.pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(TcpStream, {
								stream: Stream.empty,
								send: () => Effect.void,
								sendText: (text) =>
									Effect.sync(() => {
										sent.push(text);
									}),
								close: Effect.void,
							}),
							CedroConfigLive({
								...credentials,
								[field]: `invalid${separator}value`,
							}),
						),
					),
				);
				const exit = await Effect.runPromiseExit(
					Effect.gen(function* () {
						const client = yield* CedroClient;
						yield* client.authenticate();
					}).pipe(Effect.provide(layer)),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					expect(exit.cause.toString()).toContain("CedroProtocolError");
				}
				expect(sent).toEqual([]);
			});
		}
	}

	it("gates trade subscriptions behind confirmed authentication and preserves pre-confirmation / same-chunk messages", async () => {
		let received = "";
		let replied = false;
		const serverLines: string[] = [];
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					received += new TextDecoder().decode(data);
					if (!replied && received.includes("test-password\n")) {
						replied = true;
						// Pre-confirmation noise, confirmation, and trade message in the SAME chunk
						socket.write(
							"BANNER|Cedro v3\nSYN\nYou are connected\nTRADE|WINV26|120000\n",
						);
					}
					if (received.includes("GQT PETR4 S\n")) {
						socket.end("TRADE|PETR4|42.10\n");
					}
				},
			},
		});

		const layer = CedroClientLive.pipe(
			Layer.provide(
				Layer.merge(
					TcpStreamLive({ host: "127.0.0.1", port: server.port, retry: false }),
					CedroConfigLive(credentials),
				),
			),
		);

		try {
			await Effect.runPromise(
				runCedroSession(
					(line) =>
						Effect.sync(() => {
							serverLines.push(line);
						}),
					{ tickers: ["WINV26", "PETR4"], authTimeout: "2 seconds" },
				).pipe(Effect.provide(layer), Effect.scoped),
			);

			expect(received).toContain("magic-key\ntest-user\ntest-password\n");
			expect(received).toContain("GQT WINV26 S\n");
			expect(received).toContain("GQT PETR4 S\n");
			expect(serverLines).toEqual([
				"BANNER|Cedro v3",
				"SYN",
				"You are connected",
				"TRADE|WINV26|120000",
				"TRADE|PETR4|42.10",
			]);
		} finally {
			server.stop(true);
		}
	});

	it("fails with CedroAuthTimeoutError when confirmation is not received within authTimeout", async () => {
		let received = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					received += new TextDecoder().decode(data);
					if (received.includes("test-password\n")) {
						// Send banners but NEVER send "You are connected"
						socket.write("BANNER|Welcome\nSYN\nHEARTBEAT\n");
					}
				},
			},
		});

		const layer = CedroClientLive.pipe(
			Layer.provide(
				Layer.merge(
					TcpStreamLive({ host: "127.0.0.1", port: server.port, retry: false }),
					CedroConfigLive(credentials),
				),
			),
		);

		try {
			const exit = await Effect.runPromiseExit(
				runCedroSession(() => Effect.void, {
					tickers: ["WINV26"],
					authTimeout: "50 millis",
				}).pipe(Effect.provide(layer), Effect.scoped),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(Cause.squash(exit.cause)).toBeInstanceOf(CedroAuthTimeoutError);
			}
		} finally {
			server.stop(true);
		}
	});

	it("fails with CedroAuthRejectionError when server sends an explicit rejection", async () => {
		let received = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					received += new TextDecoder().decode(data);
					if (received.includes("test-password\n")) {
						socket.write("ERROR: Authentication failed for user test-user\n");
					}
				},
			},
		});

		const layer = CedroClientLive.pipe(
			Layer.provide(
				Layer.merge(
					TcpStreamLive({ host: "127.0.0.1", port: server.port, retry: false }),
					CedroConfigLive(credentials),
				),
			),
		);

		try {
			const exit = await Effect.runPromiseExit(
				runCedroSession(() => Effect.void, {
					tickers: ["WINV26"],
					authTimeout: "1 second",
				}).pipe(Effect.provide(layer), Effect.scoped),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(Cause.squash(exit.cause)).toBeInstanceOf(
					CedroAuthRejectionError,
				);
			}
		} finally {
			server.stop(true);
		}
	});

	it("fails fast when server disconnects before authentication confirmation", async () => {
		let received = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					received += new TextDecoder().decode(data);
					if (received.includes("test-password\n")) {
						// Cleanly close connection before sending confirmation
						socket.end();
					}
				},
			},
		});

		const layer = CedroClientLive.pipe(
			Layer.provide(
				Layer.merge(
					TcpStreamLive({ host: "127.0.0.1", port: server.port, retry: false }),
					CedroConfigLive(credentials),
				),
			),
		);

		try {
			const start = Date.now();
			const exit = await Effect.runPromiseExit(
				runCedroSession(() => Effect.void, {
					tickers: ["WINV26"],
					authTimeout: "5 seconds",
				}).pipe(Effect.provide(layer), Effect.scoped),
			);
			const elapsed = Date.now() - start;

			// Should fail almost immediately on EOF, well before 5 seconds
			expect(elapsed).toBeLessThan(2000);
			expect(Exit.isFailure(exit)).toBe(true);
		} finally {
			server.stop(true);
		}
	});
});
