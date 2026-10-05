import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import {
	CedroAuthRejectionError,
	CedroAuthTimeoutError,
	receiveCedroCommands,
	runCedroSession,
	runCedroSupervisor,
} from "./cedro-client.js";
import {
	CedroClient,
	CedroClientLive,
	CedroConfigLive,
} from "./cedro-protocol.js";
import {
	deserializeScidHeader,
	deserializeScidRecord,
	SCID_HEADER_SIZE,
	SCID_RECORD_SIZE,
} from "./scid-format.js";
import { TcpStream, TcpStreamLive } from "./tcp-connection.js";

const credentials = {
	magicToken: "magic-key",
	username: "test-user",
	password: "test-password",
};

describe("Cedro client", () => {
	it("runs the reusable command with reconnection, trade restoration, and credential redaction", async () => {
		const token = "magic-test-user-key";
		let connectionCount = 0;
		const receivedData: string[] = [];

		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					const text = new TextDecoder().decode(data);
					receivedData.push(text);
					if (text.includes("test-password\n")) {
						socket.write(
							`You are connected\n${token} ${credentials.username} ${credentials.password}\n`,
						);
					}
					if (
						text.includes("GQT WINV26 S\n") ||
						text.includes("GQT PETR4 S\n")
					) {
						if (connectionCount === 1) {
							socket.end("TRADE|WINV26|120000\n");
						} else {
							socket.write("TRADE|PETR4|42.10\n");
						}
					}
				},
				open() {
					connectionCount++;
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

		let stdoutText = "";
		const reader = (async () => {
			const stream = child.stdout;
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				stdoutText += decoder.decode(chunk);
				if (stdoutText.includes("TRADE|PETR4|42.10")) {
					child.kill("SIGINT");
					break;
				}
			}
		})();

		const timeout = setTimeout(() => child.kill(), 5000);
		try {
			await reader;
			await child.exited;
			const stderrText = await new Response(child.stderr).text();

			expect(connectionCount).toBe(2);
			expect(stdoutText).toContain("You are connected");
			expect(stdoutText).toContain("[REDACTED] [REDACTED] [REDACTED]");
			expect(stdoutText).toContain("TRADE|WINV26|120000");
			expect(stdoutText).toContain("TRADE|PETR4|42.10");

			for (const secret of [
				token,
				credentials.username,
				credentials.password,
			]) {
				expect(stdoutText).not.toContain(secret);
				expect(stderrText).not.toContain(secret);
			}
		} finally {
			clearTimeout(timeout);
			child.kill();
			server.stop(true);
		}
	});

	it("spawns cedro CLI subprocess with SCID persistence and verifies binary .scid files on disk", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "cedro-cli-scid-test-"),
		);
		const token = "magic-test-scid-token";

		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					const text = new TextDecoder().decode(data);
					if (text.includes("test-password\n")) {
						socket.write("You are connected\n");
					}
					if (
						text.includes("GQT WINV26 S\n") ||
						text.includes("GQT PETR4 S\n")
					) {
						socket.write(
							"V:WINV26:A:10:00:01.000:130000:1:2:5:101:0:A:0\n" +
								"V:PETR4:A:10:00:02.000:36.50:3:4:100:102:0:V:0\n" +
								"V:WINV26:A:10:00:03.000:130050:5:6:10:103:0:A:0\n" +
								"V:PETR4:A:10:00:04.000:36.60:7:8:200:104:0:A:0\n",
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
				SCID_BASE_DIR: tmpDir,
				SCID_PARTITION_STRATEGY: "daily",
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		let stdoutText = "";
		const reader = (async () => {
			const stream = child.stdout;
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				stdoutText += decoder.decode(chunk);
				if (stdoutText.includes("104:0:A:0")) {
					// Wait briefly for lines to be processed, then signal graceful interrupt
					await new Promise((r) => setTimeout(r, 100));
					child.kill("SIGINT");
					break;
				}
			}
		})();

		const timeout = setTimeout(() => child.kill(), 8000);
		try {
			await reader;
			await child.exited;
			const stderrText = await new Response(child.stderr).text();

			expect(stdoutText).toContain("SCID persistence active");
			expect(stdoutText).toContain("strategy=daily");

			// Ensure credentials were not leaked
			expect(stdoutText).not.toContain(token);
			expect(stdoutText).not.toContain(credentials.username);
			expect(stdoutText).not.toContain(credentials.password);
			expect(stderrText).not.toContain(token);

			// Verify .scid files on disk
			const dateStr = new Date().toISOString().slice(0, 10);

			// 1. WINV26.scid
			const winFile = path.join(tmpDir, "WINV26", `WINV26-${dateStr}.scid`);
			const winBuf = await fs.readFile(winFile);
			expect(winBuf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2);

			const winHeader = deserializeScidHeader(
				winBuf.subarray(0, SCID_HEADER_SIZE),
			);
			expect(winHeader.fileType).toBe("SCID");

			const wRec1 = deserializeScidRecord(winBuf, SCID_HEADER_SIZE);
			expect(wRec1.close).toBe(130000);
			expect(wRec1.askVolume).toBe(5);

			const wRec2 = deserializeScidRecord(
				winBuf,
				SCID_HEADER_SIZE + SCID_RECORD_SIZE,
			);
			expect(wRec2.close).toBe(130050);
			expect(wRec2.askVolume).toBe(10);

			// 2. PETR4.scid
			const petrFile = path.join(tmpDir, "PETR4", `PETR4-${dateStr}.scid`);
			const petrBuf = await fs.readFile(petrFile);
			expect(petrBuf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2);

			const petrHeader = deserializeScidHeader(
				petrBuf.subarray(0, SCID_HEADER_SIZE),
			);
			expect(petrHeader.fileType).toBe("SCID");

			const pRec1 = deserializeScidRecord(petrBuf, SCID_HEADER_SIZE);
			expect(pRec1.close).toBeCloseTo(36.5, 2);
			expect(pRec1.bidVolume).toBe(100);

			const pRec2 = deserializeScidRecord(
				petrBuf,
				SCID_HEADER_SIZE + SCID_RECORD_SIZE,
			);
			expect(pRec2.close).toBeCloseTo(36.6, 2);
			expect(pRec2.askVolume).toBe(200);
		} finally {
			clearTimeout(timeout);
			child.kill();
			server.stop(true);
			await fs.rm(tmpDir, { recursive: true, force: true });
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

	it("reconnects on server disconnect, re-authenticates, and restores both trade subscriptions", async () => {
		let connectionCount = 0;
		const loginsReceived: string[] = [];
		const subscriptionsReceived: string[] = [];
		const tradesReceived: string[] = [];

		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					const text = new TextDecoder().decode(data);
					if (text.includes("test-password\n")) {
						loginsReceived.push(text);
						socket.write("You are connected\n");
					}
					if (
						text.includes("GQT WINV26 S\n") ||
						text.includes("GQT PETR4 S\n")
					) {
						subscriptionsReceived.push(text);
						if (connectionCount === 1) {
							// First connection: emit a trade and close
							socket.end("TRADE|WINV26|100\n");
						} else {
							// Second connection: emit trade and keep open
							socket.write("TRADE|PETR4|200\n");
						}
					}
				},
				open() {
					connectionCount++;
				},
			},
		});

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const done = yield* Deferred.make<void>();

					const supervisorFiber = yield* Effect.forkChild(
						runCedroSupervisor(
							(line) =>
								Effect.gen(function* () {
									tradesReceived.push(line);
									if (line === "TRADE|PETR4|200") {
										yield* Deferred.succeed(done, void 0);
									}
								}),
							{
								host: "127.0.0.1",
								port: server.port,
								credentials,
								tickers: ["WINV26", "PETR4"],
								backoffDelays: ["10 millis", "20 millis"],
								authTimeout: "1 second",
							},
						),
					);

					yield* Deferred.await(done);
					yield* Fiber.interrupt(supervisorFiber);
				}),
			);

			expect(connectionCount).toBe(2);
			expect(loginsReceived.length).toBe(2);
			expect(tradesReceived).toContain("TRADE|WINV26|100");
			expect(tradesReceived).toContain("TRADE|PETR4|200");
		} finally {
			server.stop(true);
		}
	});

	it("progresses backoff delays on failure and resets backoff upon successful session", async () => {
		let connectionCount = 0;
		const statuses: string[] = [];

		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					const text = new TextDecoder().decode(data);
					if (text.includes("test-password\n")) {
						if (connectionCount <= 2) {
							// Fail first two attempts by dropping connection before auth
							socket.end();
						} else {
							// Succeed on third attempt
							socket.write("You are connected\n");
						}
					}
					if (text.includes("GQT WINV26 S\n")) {
						// Once subscribed on third attempt, close connection to test backoff reset
						socket.end("TRADE|DONE\n");
					}
				},
				open() {
					connectionCount++;
				},
			},
		});

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const done = yield* Deferred.make<void>();

					const supervisorFiber = yield* Effect.forkChild(
						runCedroSupervisor(
							(line) =>
								Effect.gen(function* () {
									if (line === "TRADE|DONE") {
										// Wait a bit to observe next status after disconnect
										yield* Effect.sleep("50 millis");
										yield* Deferred.succeed(done, void 0);
									}
								}),
							{
								host: "127.0.0.1",
								port: server.port,
								credentials,
								tickers: ["WINV26"],
								backoffDelays: ["10 millis", "30 millis", "60 millis"],
								authTimeout: "500 millis",
								onStatus: (status) =>
									Effect.sync(() => {
										statuses.push(status);
									}),
							},
						),
					);

					yield* Deferred.await(done);
					yield* Fiber.interrupt(supervisorFiber);
				}),
			);

			// Should have logged backoff progresses: attempt 1 (10ms), attempt 2 (30ms)
			expect(
				statuses.some((s) => s.includes("10ms") || s.includes("0.01s")),
			).toBe(true);
			expect(
				statuses.some((s) => s.includes("30ms") || s.includes("0.03s")),
			).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("explicit auth rejection is fatal and stops supervisor immediately", async () => {
		let connectionCount = 0;
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					const text = new TextDecoder().decode(data);
					if (text.includes("test-password\n")) {
						socket.write("ERROR: Authentication failed\n");
					}
				},
				open() {
					connectionCount++;
				},
			},
		});

		try {
			const exit = await Effect.runPromiseExit(
				runCedroSupervisor(() => Effect.void, {
					host: "127.0.0.1",
					port: server.port,
					credentials,
					tickers: ["WINV26"],
					backoffDelays: ["10 millis"],
					authTimeout: "1 second",
				}),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(Cause.squash(exit.cause)).toBeInstanceOf(
					CedroAuthRejectionError,
				);
			}
			expect(connectionCount).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	it("stops promptly when interrupted during backoff sleep", async () => {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket) {
					// Drop immediately to trigger backoff
					socket.end();
				},
			},
		});

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const fiber = yield* Effect.forkChild(
						runCedroSupervisor(() => Effect.void, {
							host: "127.0.0.1",
							port: server.port,
							credentials,
							tickers: ["WINV26"],
							backoffDelays: ["5 seconds"],
							authTimeout: "1 second",
						}),
					);

					// Allow it to fail connection 1 and enter 5-second sleep
					yield* Effect.sleep("50 millis");
					// Interrupt should finish promptly without waiting 5 seconds
					const start = Date.now();
					yield* Fiber.interrupt(fiber);
					const elapsed = Date.now() - start;
					expect(elapsed).toBeLessThan(1000);
				}),
			);
		} finally {
			server.stop(true);
		}
	});
});
