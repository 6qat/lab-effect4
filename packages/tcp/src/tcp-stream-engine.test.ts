import { describe, expect, it } from "bun:test";
import { Cause, Effect, Layer, Result, Stream } from "effect";
import {
	ConnectionConfigLive,
	type ConnectionConfigShape,
	TcpStream,
} from "./tcp-connection-common.js";
import {
	makeTcpStreamEngine,
	type RawSocketHandle,
	TcpStreamEngine,
	type TcpStreamEngineAdapterEvent,
	TcpStreamLayer,
} from "./tcp-stream-engine.js";

const config: ConnectionConfigShape = {
	host: "scripted",
	port: 1,
	retry: false,
};
const handle: RawSocketHandle = {
	write: () => Effect.succeed({ bytesWritten: 0, flushed: true }),
	close: () => Effect.void,
};

describe("TcpStreamEngine seam", () => {
	it("preserves data and drain events emitted before readiness", async () => {
		const engine = makeTcpStreamEngine((_config, emit) =>
			Effect.sync(() => {
				emit({ _tag: "Data", chunk: new Uint8Array([1]) });
				emit({ _tag: "Drain" });
				emit({ _tag: "Ready" });
				emit({ _tag: "Data", chunk: new Uint8Array([2]) });
				emit({ _tag: "Close" });
				return handle;
			}),
		);
		const result = await Effect.runPromise(
			Effect.scoped(engine.connect(config)),
		);
		const events = await Effect.runPromise(Stream.runCollect(result.events));
		expect(Array.from(events)).toEqual([
			{ _tag: "Data", chunk: new Uint8Array([1]) },
			{ _tag: "Drain" },
			{ _tag: "Data", chunk: new Uint8Array([2]) },
		]);
	});

	it("does not leak events from a failed attempt into a later attempt", async () => {
		let attempts = 0;
		const engine = makeTcpStreamEngine((_config, emit) =>
			Effect.sync(() => {
				attempts++;
				if (attempts === 1) {
					emit({ _tag: "Data", chunk: new Uint8Array([99]) });
					emit({ _tag: "Error", cause: new Error("first attempt") });
				} else {
					emit({ _tag: "Ready" });
					emit({ _tag: "Data", chunk: new Uint8Array([7]) });
					emit({ _tag: "Close" });
				}
				return handle;
			}),
		);
		const result = await Effect.runPromise(
			Effect.scoped(engine.connect(config).pipe(Effect.retry({ times: 1 }))),
		);
		const events = await Effect.runPromise(Stream.runCollect(result.events));
		expect(attempts).toBe(2);
		expect(Array.from(events)).toEqual([
			{ _tag: "Data", chunk: new Uint8Array([7]) },
		]);
	});

	it("closes a handle when the adapter closes before readiness", async () => {
		let closed = 0;
		const lateHandle: RawSocketHandle = {
			write: () => Effect.succeed({ bytesWritten: 0, flushed: true }),
			close: () =>
				Effect.sync(() => {
					closed++;
				}),
		};
		const engine = makeTcpStreamEngine((_config, emit) =>
			Effect.sync(() => {
				emit({ _tag: "Close" });
				emit({ _tag: "Ready" });
				return lateHandle;
			}),
		);

		const exit = await Effect.runPromiseExit(
			Effect.scoped(engine.connect(config)),
		);

		expect(exit._tag).toBe("Failure");
		expect(closed).toBe(1);
	});

	it("classifies failures after readiness as read failures", async () => {
		const engine = makeTcpStreamEngine((_config, emit) =>
			Effect.sync(() => {
				emit({ _tag: "Ready" });
				emit({ _tag: "Error", cause: new Error("read failed") });
				return handle;
			}),
		);

		const connection = await Effect.runPromise(
			Effect.scoped(engine.connect(config)),
		);
		const events = await Effect.runPromiseExit(
			Stream.runCollect(connection.events),
		);

		expect(events._tag).toBe("Failure");
		if (events._tag === "Failure") {
			const failure = Cause.findError(events.cause);
			expect(Result.isSuccess(failure)).toBe(true);
			if (Result.isSuccess(failure)) {
				expect(failure.success.operation).toBe("read");
			}
		}
	});

	it("times out an attempt that never reaches readiness", async () => {
		let interrupted = false;
		const engine = makeTcpStreamEngine((_config, _emit) =>
			Effect.never.pipe(
				Effect.onInterrupt(() =>
					Effect.sync(() => {
						interrupted = true;
					}),
				),
			),
		);

		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				engine.connect({
					...config,
					connectTimeout: "10 millis",
				}),
			),
		);

		expect(exit._tag).toBe("Failure");
		expect(interrupted).toBe(true);
	});

	it("makes explicit close terminal and effective once", async () => {
		let closed = 0;
		let emitEvent:
			| ((event: TcpStreamEngineAdapterEvent) => "accepted" | "closed")
			| undefined;
		const engine = makeTcpStreamEngine((_config, emit) => {
			emitEvent = emit;
			return Effect.sync(() => {
				emit({ _tag: "Ready" });
				return {
					...handle,
					close: () =>
						Effect.sync(() => {
							closed++;
						}),
				};
			});
		});

		const events = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* engine.connect(config);
					yield* connection.socket.close();
					yield* connection.socket.close();
					expect(
						emitEvent?.({ _tag: "Data", chunk: new Uint8Array([9]) }),
					).toBe("closed");
					return yield* Stream.runCollect(connection.events);
				}),
			),
		);

		expect(Array.from(events)).toEqual([]);
		expect(closed).toBe(1);
	});

	it("ends the session stream cleanly when the session is torn down without an explicit close", async () => {
		const engine = makeTcpStreamEngine((_config, emit) =>
			Effect.sync(() => {
				emit({ _tag: "Ready" });
				return handle;
			}),
		);
		const layer = TcpStreamLayer.pipe(
			Layer.provide(Layer.succeed(TcpStreamEngine, engine)),
			Layer.provide(ConnectionConfigLive(config)),
		);
		const tcp = await Effect.runPromise(
			Effect.gen(function* () {
				const tcp = yield* TcpStream;
				yield* Effect.sleep("10 millis");
				return tcp;
			}).pipe(Effect.provide(layer)),
		);

		const drainExit = await Effect.runPromiseExit(
			Stream.runDrain(tcp.stream).pipe(Effect.timeout("2 seconds")),
		);

		expect(drainExit._tag).toBe("Success");
	});
});
