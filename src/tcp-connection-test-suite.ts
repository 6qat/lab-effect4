import { describe, expect, it } from "bun:test";
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Schedule,
	Stream,
} from "effect";
import {
	type ConnectionConfig,
	ConnectionConfigLive,
	type ConnectionConfigShape,
	TcpStream,
	type TcpStreamEngine,
	type TcpStreamError,
	TcpStreamLayer,
	type TcpStreamShape,
} from "./tcp-connection-common.js";

type EchoServer = {
	readonly port: number;
	readonly stop: (closeActiveConnections?: boolean) => void;
};

type TlsServer = import("node:tls").Server;
type UnreachableEndpoint = {
	readonly host: "127.0.0.2";
	readonly port: number;
	readonly release: () => void;
};

type TlsServerLifecycle = {
	readonly ready: Promise<number>;
	readonly close: () => Promise<void>;
};

const listenTlsServer = (
	server: TlsServer,
	signal: AbortSignal,
	forceClose: () => void,
): TlsServerLifecycle => {
	let startupPending = true;
	let startupFailed = false;
	let aborted = false;
	let closePromise: Promise<void> | undefined;

	const close = (): Promise<void> => {
		if (closePromise !== undefined) {
			return closePromise;
		}

		closePromise = new Promise((resolve) => {
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				server.removeListener("close", onClose);
				server.removeListener("listening", onLateListening);
				resolve();
			};
			const onClose = () => finish();
			const onLateListening = () => {
				server.removeListener("listening", onLateListening);
				requestClose();
			};
			const requestClose = () => {
				forceClose();
				if (startupFailed || (!startupPending && !server.listening)) {
					finish();
					return;
				}
				if (!server.listening) {
					server.once("listening", onLateListening);
					try {
						server.close();
					} catch {
						// The pending listen may still emit `listening` later.
					}
					return;
				}
				server.once("close", onClose);
				try {
					server.close();
				} catch {
					finish();
				}
			};

			server.once("close", onClose);
			requestClose();
		});

		return closePromise;
	};

	const ready = new Promise<number>((resolve, reject) => {
		const cleanup = () => {
			server.removeListener("error", onError);
			server.removeListener("listening", onListening);
			server.removeListener("close", onStartupClose);
			signal.removeEventListener("abort", onAbort);
		};
		const onStartupClose = () => {
			cleanup();
		};
		const onAbort = () => {
			aborted = true;
			void close().then(() => {
				cleanup();
				reject(new Error("TLS server startup was interrupted"));
			});
		};
		const onError = (cause: Error) => {
			startupPending = false;
			startupFailed = true;
			cleanup();
			reject(cause);
		};
		const onListening = () => {
			startupPending = false;
			if (aborted) {
				void close();
				return;
			}
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				startupFailed = true;
				cleanup();
				reject(new Error("TLS server did not expose a TCP address"));
				return;
			}
			cleanup();
			resolve(address.port);
		};

		server.once("error", onError);
		server.once("listening", onListening);
		server.once("close", onStartupClose);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			aborted = true;
			startupPending = false;
			startupFailed = true;
			cleanup();
			reject(new Error("TLS server startup was interrupted"));
			return;
		}
		try {
			server.listen(0, "127.0.0.1");
			if (server.listening) {
				onListening();
			}
		} catch (cause) {
			onError(cause instanceof Error ? cause : new Error(String(cause)));
		}
	});

	return { ready, close };
};

/** Shared plaintext echo server fixture (one handler set, not ~7 copies). */
const startEchoServer = (port = 0, hostname = "127.0.0.1"): EchoServer => {
	const server = Bun.listen({
		hostname,
		port,
		socket: {
			data(socket, data) {
				socket.write(data);
			},
		},
	});
	return {
		port: server.port,
		stop: (closeActiveConnections?: boolean) =>
			server.stop(closeActiveConnections),
	};
};

/**
 * Reserves a port on one loopback address while tests use the same port on a
 * different loopback address. This removes the release-then-connect race from
 * unreachable-port tests while still allowing the retry-recovery test to bind
 * the target address later.
 */
const reserveUnreachableEndpoint = (): UnreachableEndpoint => {
	const reservation = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	return {
		host: "127.0.0.2",
		port: reservation.port,
		release: () => reservation.stop(true),
	};
};

const interruptTestFiber = (fiber: Fiber.Fiber<unknown, unknown>) =>
	Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"));

export interface TcpStreamTestSuiteOptions {
	readonly engineName: string;
	readonly layerFactory: {
		(config: ConnectionConfigShape): Layer.Layer<TcpStream>;
		(): Layer.Layer<TcpStream, never, ConnectionConfig>;
	};
	readonly engineLayer?: Layer.Layer<TcpStreamEngine>;
}

export const defineTcpStreamTestSuite = ({
	engineName,
	layerFactory,
	engineLayer,
}: TcpStreamTestSuiteOptions) => {
	describe(`TcpStream ${engineName} operations and retry policy`, () => {
		it("fails with TcpStreamError after exhausting configured retry attempts on unreachable port", async () => {
			const endpoint = reserveUnreachableEndpoint();
			try {
				const configLayer = ConnectionConfigLive({
					host: endpoint.host,
					port: endpoint.port,
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
				// An upper bound (generous relative to the ~10-25ms schedule) catches
				// a retry attempt that fails to clean up and hangs instead of moving
				// on to the next attempt or failing.
				expect(elapsed).toBeLessThan(2000);
			} finally {
				endpoint.release();
			}
		});

		it("fails immediately when retry is disabled (retry: false)", async () => {
			const endpoint = reserveUnreachableEndpoint();
			try {
				const configLayer = ConnectionConfigLive({
					host: endpoint.host,
					port: endpoint.port,
					retry: false,
				});

				const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
				const program = TcpStream.pipe(Effect.provide(tcpLayer));

				const startTime = Date.now();
				const exit = await Effect.runPromiseExit(program);
				const elapsed = Date.now() - startTime;

				expect(Exit.isFailure(exit)).toBe(true);
				expect(elapsed).toBeLessThan(150);
			} finally {
				endpoint.release();
			}
		});

		it("supports custom retrySchedule", async () => {
			const endpoint = reserveUnreachableEndpoint();
			try {
				let attempts = 0;

				const customSchedule = Schedule.recurs(2).pipe(
					Schedule.tap(() =>
						Effect.sync(() => {
							attempts++;
						}),
					),
				);

				const configLayer = ConnectionConfigLive({
					host: endpoint.host,
					port: endpoint.port,
					retrySchedule: customSchedule,
				});

				const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
				const program = TcpStream.pipe(Effect.provide(tcpLayer));

				const exit = await Effect.runPromiseExit(program);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(attempts).toBe(2);
			} finally {
				endpoint.release();
			}
		});

		it("recovers and connects successfully when server opens during retry backoff window", async () => {
			const endpoint = reserveUnreachableEndpoint();
			const port = endpoint.port;
			let serverFiber: Fiber.Fiber<unknown, unknown> | undefined;

			try {
				// Gate server startup on the client actually entering backoff
				// (rather than a blind `setTimeout(50)`): each failed attempt
				// increments via the tapped schedule, and the gate opens on the
				// first failure. This removes the race where a slow initial
				// attempt (e.g. Platform connect + readiness round-trip) eats the
				// whole backoff window before the server exists.
				const attemptGate = await Effect.runPromise(Deferred.make<void>());
				let attempts = 0;
				const backoffGateSchedule = Schedule.spaced("20 millis").pipe(
					Schedule.tap(() =>
						Effect.gen(function* () {
							attempts++;
							// `Deferred.succeed` completes immediately; no need to
							// fork an unmanaged fiber just to open the gate.
							yield* Deferred.succeed(attemptGate, void 0);
						}),
					),
				);

				serverFiber = Effect.runFork(
					Effect.gen(function* () {
						yield* Deferred.await(attemptGate);
						const server = startEchoServer(port, endpoint.host);
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => server.stop(true)),
						);
						yield* Effect.never;
					}).pipe(Effect.scoped),
				);

				const configLayer = ConnectionConfigLive({
					host: endpoint.host,
					port,
					retrySchedule: backoffGateSchedule,
				});

				const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));

				const program = Effect.gen(function* () {
					const tcp = yield* TcpStream;
					yield* tcp.sendText(`hello ${engineName} retry`);
					const chunk = yield* Stream.runHead(tcp.stream);
					yield* tcp.close;
					return chunk;
				}).pipe(
					Effect.provide(tcpLayer),
					// The gate opens on the first failed attempt, so this settles in
					// a few hundred ms; the bound turns a broken gate into a clear
					// timeout failure instead of relying on the runner's default.
					Effect.timeout("5 seconds"),
				);

				const exit = await Effect.runPromiseExit(program);
				expect(attempts).toBeGreaterThanOrEqual(1);
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
				try {
					if (serverFiber !== undefined) {
						await Effect.runPromise(interruptTestFiber(serverFiber));
					}
				} finally {
					endpoint.release();
				}
			}
		});

		it("sends binary data and closes gracefully", async () => {
			const server = startEchoServer();
			const port = server.port;

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
				server.stop(true);
			}
		});

		it("a failed connection attempt fails cleanly with no defects in the Cause", async () => {
			const endpoint = reserveUnreachableEndpoint();
			try {
				const configLayer = ConnectionConfigLive({
					host: endpoint.host,
					port: endpoint.port,
					retry: false,
				});

				const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
				const program = TcpStream.pipe(Effect.provide(tcpLayer));

				const exit = await Effect.runPromiseExit(program);

				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					expect(Cause.hasDies(exit.cause)).toBe(false);
				}
			} finally {
				endpoint.release();
			}
		});

		it("a TLS client resolves its connection lifecycle against a real TLS server", async () => {
			// Positive-path coverage for the `createPlatformSocket` TLS
			// branch (`tls.connect` wrapped by `BunSocket.fromDuplex`):
			// generate a throwaway self-signed cert, serve TLS from it, and
			// run an echo round-trip through each engine with verification
			// disabled. This proves the TLS path connects and streams — the
			// plaintext-mismatch test below only proves it fails cleanly.
			const tmpDir = await Effect.runPromise(
				Effect.tryPromise({
					try: () =>
						Promise.all([import("node:fs/promises"), import("node:os")]).then(
							([fs, os]) => fs.mkdtemp(`${os.tmpdir()}/lab-effect4-tls-`),
						),
					catch: () => new Error("mkdtemp failed"),
				}),
			);
			const keyPath = `${tmpDir}/key.pem`;
			const certPath = `${tmpDir}/cert.pem`;
			const [{ readFile, rm }, tls] = await Promise.all([
				import("node:fs/promises"),
				import("node:tls"),
			]);

			let listenAbort: AbortController | undefined;
			let tlsLifecycle: TlsServerLifecycle | undefined;
			try {
				const generated = await Effect.runPromiseExit(
					Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawnSync([
								"openssl",
								"req",
								"-x509",
								"-newkey",
								"rsa:2048",
								"-keyout",
								keyPath,
								"-out",
								certPath,
								"-days",
								"1",
								"-nodes",
								"-subj",
								"/CN=127.0.0.1",
							]);
							if (proc.exitCode !== 0) {
								throw new Error(`openssl exited ${proc.exitCode}`);
							}
						},
						catch: (cause) => cause,
					}).pipe(Effect.timeout("15 seconds")),
				);
				// Fail loudly (not silently skip) if the fixture can't be built:
				// a missing openssl or tmpdir would otherwise hide a real
				// regression behind a green suite.
				expect(Exit.isSuccess(generated)).toBe(true);

				const [key, cert] = await Promise.all([
					readFile(keyPath),
					readFile(certPath),
				]);
				const activeSockets = new Set<import("node:net").Socket>();
				const tlsServer = tls.createServer({ key, cert }, (socket) => {
					socket.on("data", (chunk: Buffer) => {
						socket.write(chunk);
					});
				});
				tlsServer.on("connection", (socket) => {
					activeSockets.add(socket);
					socket.once("close", () => activeSockets.delete(socket));
				});
				const startupAbort = new AbortController();
				listenAbort = startupAbort;
				const lifecycle = listenTlsServer(
					tlsServer,
					startupAbort.signal,
					() => {
						for (const socket of activeSockets) {
							socket.destroy();
						}
					},
				);
				tlsLifecycle = lifecycle;
				const port = await Effect.runPromise(
					Effect.tryPromise({
						try: () => lifecycle.ready,
						catch: (cause) =>
							cause instanceof Error ? cause : new Error(String(cause)),
					}).pipe(Effect.timeout("5 seconds")),
				);

				const configLayer = ConnectionConfigLive({
					host: "127.0.0.1",
					port,
					retry: false,
					tls: { rejectUnauthorized: false },
				});

				const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
				const program = Effect.gen(function* () {
					const tcp = yield* TcpStream;
					yield* tcp.sendText(`hello ${engineName} tls`);
					const chunk = yield* Stream.runHead(tcp.stream);
					yield* tcp.close;
					return chunk;
				}).pipe(Effect.provide(tcpLayer), Effect.timeout("10 seconds"));

				const exit = await Effect.runPromiseExit(program);
				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					expect(Option.isSome(exit.value)).toBe(true);
					if (Option.isSome(exit.value)) {
						const received = new TextDecoder().decode(exit.value.value);
						expect(received).toBe(`hello ${engineName} tls`);
					}
				}
			} finally {
				listenAbort?.abort();
				try {
					if (tlsLifecycle !== undefined) {
						await Effect.runPromise(
							Effect.tryPromise({
								try: () => tlsLifecycle?.close() ?? Promise.resolve(),
								catch: (cause) =>
									cause instanceof Error ? cause : new Error(String(cause)),
							}).pipe(Effect.timeout("5 seconds")),
						);
					}
				} finally {
					await rm(tmpDir, { recursive: true, force: true });
				}
			}
		});

		it("fails TLS handshakes cleanly when the server speaks plaintext (fromDuplex path)", async () => {
			// Covers the `createPlatformSocket` TLS branch (`tls.connect` +
			// `BunSocket.fromDuplex`), which plain-TCP tests never exercise.
			// A TLS client against a plaintext echo server must fail with a
			// `TcpStreamError` (no defects, bounded time) — not hang or leak
			// the attempt's child scope into subsequent retries — because no
			// `secureConnect` is ever emitted.
			const server = startEchoServer();
			const port = server.port;

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port,
				retry: false,
				tls: { rejectUnauthorized: false },
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));

			// Connect without retry (handshake can't complete), then exercise
			// a send: engines that defer the TLS failure until first write
			// surface it here; engines that fail at connect surface it above.
			// The combined outcome must be a clean failure (TcpStreamError
			// at connect/send, or close failing because the handshake never
			// completed) — never a success, never a defect.
			const program = Effect.gen(function* () {
				const tcp = yield* TcpStream;
				yield* tcp.sendText("tls-probe");
				yield* tcp.close;
			}).pipe(Effect.provide(tcpLayer), Effect.timeout("5 seconds"));

			try {
				const exit = await Effect.runPromiseExit(program);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					expect(Cause.hasDies(exit.cause)).toBe(false);
					expect(exit.cause.toString()).toContain("TcpStreamError");
					expect(exit.cause.toString()).not.toContain("TimeoutError");
				}
			} finally {
				server.stop(true);
			}
		});

		it("an immediate remote close ends the stream cleanly without hanging", async () => {
			let server:
				| { stop: (closeActiveConnections?: boolean) => void }
				| undefined;

			const openServer = Bun.listen({
				hostname: "127.0.0.1",
				port: 0,
				socket: {
					open(socket) {
						socket.end();
					},
					data() {},
				},
			});
			server = openServer;
			const port = openServer.port;

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port,
				retry: false,
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));

			const program = Effect.gen(function* () {
				const tcp = yield* TcpStream;
				// Observe the stream's own outcome: a regression that turns a
				// clean remote close into a stream failure must fail the
				// assertion below, so the drain result is deliberately NOT
				// caught here.
				const drainExit = yield* Effect.exit(Stream.runDrain(tcp.stream));
				yield* tcp.close;
				return drainExit;
			}).pipe(Effect.provide(tcpLayer), Effect.timeout("2 seconds"));

			try {
				const exit = await Effect.runPromiseExit(program);
				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					expect(Exit.isSuccess(exit.value)).toBe(true);
				}
			} finally {
				server?.stop(true);
			}
		});

		it("interrupting a connect attempt that never completes exits promptly without defects", async () => {
			// A TLS server that accepts the TCP connection but never completes
			// the handshake leaves the engine's connect pending indefinitely,
			// so the interruption below lands mid-setup — while the attempt's
			// per-connection resources exist. The bounded interrupt proves the
			// engine does not stall the owning fiber, and `Cause.hasDies`
			// proves the interruption path fails cleanly rather than defecting.
			// Bun cannot expose or terminate this socket until `Bun.connect`
			// settles; the established-socket teardown contract is covered by
			// the test below.
			const openGate = await Effect.runPromise(Deferred.make<void>());
			const server = Bun.listen({
				hostname: "127.0.0.1",
				port: 0,
				socket: {
					open() {
						// No Effect context exists inside a Bun socket callback,
						// so forking is the only way to complete the gate; the
						// fiber completes immediately after `Deferred.succeed`.
						Effect.runFork(Deferred.succeed(openGate, void 0));
					},
					data() {},
				},
			});

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port: server.port,
				retry: false,
				tls: { rejectUnauthorized: false },
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
			// `Fiber.interrupt` discards the interrupted fiber's exit, so the
			// program reports its own final exit through an onExit handler
			// (which runs on interruption as well, uninterruptibly).
			const programExitGate = await Effect.runPromise(
				Deferred.make<Exit.Exit<TcpStreamShape, TcpStreamError>>(),
			);
			const program = TcpStream.pipe(
				Effect.provide(tcpLayer),
				Effect.onExit((exit) => Deferred.succeed(programExitGate, exit)),
				Effect.timeout("5 seconds"),
			);

			let fiber: Fiber.Fiber<unknown, unknown> | undefined;
			try {
				fiber = Effect.runFork(program);
				await Effect.runPromise(
					Deferred.await(openGate).pipe(Effect.timeout("5 seconds")),
				);

				const startTime = Date.now();
				await Effect.runPromise(interruptTestFiber(fiber));
				const elapsed = Date.now() - startTime;

				const fiberExit = await Effect.runPromise(
					Deferred.await(programExitGate).pipe(Effect.timeout("5 seconds")),
				);
				expect(Exit.isFailure(fiberExit)).toBe(true);
				if (Exit.isFailure(fiberExit)) {
					expect(Cause.hasDies(fiberExit.cause)).toBe(false);
				}
				expect(elapsed).toBeLessThan(1500);
			} finally {
				try {
					server.stop(true);
				} finally {
					if (fiber !== undefined) {
						await Effect.runPromise(interruptTestFiber(fiber));
					}
				}
			}
		});

		it("interrupting during retry backoff, before any successful connection, does not hang", async () => {
			const endpoint = reserveUnreachableEndpoint();
			let fiber: Fiber.Fiber<unknown, unknown> | undefined;
			try {
				// Synchronize on the retry schedule itself (`enteredBackoff`
				// opens on the first backoff decision) instead of a blind
				// wall-clock `setTimeout(50)`: this guarantees the fiber under
				// test is inside the ~200ms backoff sleep — not still resolving
				// the initial connection attempt — regardless of CI timing.
				const enteredBackoff = await Effect.runPromise(Deferred.make<void>());
				const gatedSchedule = Schedule.spaced("200 millis").pipe(
					Schedule.tap(() => Deferred.succeed(enteredBackoff, void 0)),
				);

				const configLayer = ConnectionConfigLive({
					host: endpoint.host,
					port: endpoint.port,
					retrySchedule: gatedSchedule,
				});

				const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));
				const program = TcpStream.pipe(Effect.provide(tcpLayer));

				fiber = Effect.runFork(program);
				await Effect.runPromise(
					Deferred.await(enteredBackoff).pipe(Effect.timeout("5 seconds")),
				);

				const startTime = Date.now();
				await Effect.runPromise(interruptTestFiber(fiber));
				const elapsed = Date.now() - startTime;

				expect(elapsed).toBeLessThan(150);
			} finally {
				try {
					if (fiber !== undefined) {
						await Effect.runPromise(interruptTestFiber(fiber));
					}
				} finally {
					endpoint.release();
				}
			}
		});

		it("interrupting the program after connecting still tears down the underlying socket", async () => {
			const serverClosedGate = await Effect.runPromise(Deferred.make<void>());
			let server: EchoServer | undefined;

			const bunServer = Bun.listen({
				hostname: "127.0.0.1",
				port: 0,
				socket: {
					data(socket, data) {
						socket.write(data);
					},
					close() {
						Effect.runFork(Deferred.succeed(serverClosedGate, void 0));
					},
				},
			});
			server = {
				port: bunServer.port,
				stop: (closeActiveConnections?: boolean) =>
					bunServer.stop(closeActiveConnections),
			};
			const port = bunServer.port;

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port,
				retry: false,
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));

			const echoed = await Effect.runPromise(Deferred.make<void>());
			const program = Effect.gen(function* () {
				const tcp = yield* TcpStream;
				yield* tcp.sendText("ping");
				yield* Stream.runHead(tcp.stream);
				yield* Deferred.succeed(echoed, void 0);
				yield* Effect.never;
			}).pipe(Effect.provide(tcpLayer));

			let fiber: Fiber.Fiber<unknown, unknown> | undefined;
			try {
				fiber = Effect.runFork(program);
				// Wait for the echo round-trip to complete (rendezvous) rather
				// than a fixed wall-clock sleep before interrupting.
				await Effect.runPromise(
					Deferred.await(echoed).pipe(Effect.timeout("5 seconds")),
				);
				await Effect.runPromise(interruptTestFiber(fiber));
				// Wait for the server to observe the disconnect (rendezvous),
				// bounded so a teardown regression fails fast instead of
				// hanging the suite.
				const sawClose = await Effect.runPromiseExit(
					Deferred.await(serverClosedGate).pipe(Effect.timeout("2 seconds")),
				);
				expect(Exit.isSuccess(sawClose)).toBe(true);
			} finally {
				try {
					if (fiber !== undefined) {
						await Effect.runPromise(interruptTestFiber(fiber));
					}
				} finally {
					server?.stop(true);
				}
			}
		});

		it("close is idempotent: calling it a second time does not throw", async () => {
			const server = startEchoServer();
			const port = server.port;

			const configLayer = ConnectionConfigLive({
				host: "127.0.0.1",
				port,
				retry: false,
			});

			const tcpLayer = layerFactory().pipe(Layer.provide(configLayer));

			const program = Effect.gen(function* () {
				const tcp = yield* TcpStream;
				yield* tcp.sendText("ping");
				yield* Stream.runHead(tcp.stream);
				yield* tcp.close;
				yield* tcp.close;
			}).pipe(Effect.provide(tcpLayer));

			try {
				const exit = await Effect.runPromiseExit(program);
				expect(Exit.isSuccess(exit)).toBe(true);
			} finally {
				server.stop(true);
			}
		});

		if (engineLayer) {
			it("supports composable layer composition with TcpStreamLayer and engine live layer", async () => {
				const server = startEchoServer();
				const port = server.port;

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
					server.stop(true);
				}
			});
		}
	});
};
