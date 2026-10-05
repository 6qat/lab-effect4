import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Fiber } from "effect";
import {
	CedroScidSink,
	CedroScidSinkLive,
	makeCedroScidSink,
} from "./cedro-scid-sink.js";
import {
	deserializeScidHeader,
	deserializeScidRecord,
	SCID_HEADER_SIZE,
	SCID_RECORD_SIZE,
} from "./scid-format.js";

describe("CedroScidSink: Multi-Ticker Routing & Buffered I/O", () => {
	it("routes multiple tickers to separate SCID files and ignores non-trade lines", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scid-sink-test-"));

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							sessionDate: "2026-10-05",
							flushInterval: "1 hour", // disable periodic flush for manual test
						});

						// Interleaved trades and non-trade noise
						yield* sink.writeLine("You are connected");
						yield* sink.writeLine(
							"V:PETR4:A:10:00:01.000:36.00:1:2:100:101:0:A:0",
						);
						yield* sink.writeLine(
							"V:WINV26:A:10:00:01.500:130000:10:20:5:201:0:V:0",
						);
						yield* sink.writeLine("V:PETR4:D:999"); // deletion noise
						yield* sink.writeLine(
							"V:PETR4:A:10:00:02.000:36.10:3:4:200:102:0:A:0",
						);
						yield* sink.writeLine(
							"V:WINV26:A:10:00:02.500:130050:30:40:10:202:0:A:0",
						);

						// Explicit manual flush
						yield* sink.flush();
					}),
				),
			);

			// Assert PETR4.scid
			const petrFile = path.join(tmpDir, "PETR4.scid");
			const petrBuf = await fs.readFile(petrFile);
			expect(petrBuf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2);

			const petrHeader = deserializeScidHeader(
				petrBuf.subarray(0, SCID_HEADER_SIZE),
			);
			expect(petrHeader.fileType).toBe("SCID");

			const pRec1 = deserializeScidRecord(petrBuf, SCID_HEADER_SIZE);
			expect(pRec1.close).toBeCloseTo(36.0, 2);
			expect(pRec1.askVolume).toBe(100);

			const pRec2 = deserializeScidRecord(
				petrBuf,
				SCID_HEADER_SIZE + SCID_RECORD_SIZE,
			);
			expect(pRec2.close).toBeCloseTo(36.1, 2);
			expect(pRec2.askVolume).toBe(200);

			// Assert WINV26.scid
			const winFile = path.join(tmpDir, "WINV26.scid");
			const winBuf = await fs.readFile(winFile);
			expect(winBuf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2);

			const wRec1 = deserializeScidRecord(winBuf, SCID_HEADER_SIZE);
			expect(wRec1.close).toBe(130000);
			expect(wRec1.bidVolume).toBe(5); // seller aggressor

			const wRec2 = deserializeScidRecord(
				winBuf,
				SCID_HEADER_SIZE + SCID_RECORD_SIZE,
			);
			expect(wRec2.close).toBe(130050);
			expect(wRec2.askVolume).toBe(10); // buyer aggressor
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("flushes immediately when batchSize threshold is reached", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scid-sink-batch-"));
		const petrFile = path.join(tmpDir, "PETR4.scid");

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							sessionDate: "2026-10-05",
							batchSize: 2, // Threshold of 2 records
							flushInterval: "1 hour", // disable periodic flush
						});

						yield* sink.writeLine(
							"V:PETR4:A:10:00:01.000:36.00:1:2:100:101:0:A:0",
						);

						// 1 record is below batchSize: file should not exist yet
						const existsBefore = yield* Effect.promise(() =>
							fs
								.stat(petrFile)
								.then(() => true)
								.catch(() => false),
						);
						expect(existsBefore).toBe(false);

						// 2nd record reaches batchSize: triggers flush automatically
						yield* sink.writeLine(
							"V:PETR4:A:10:00:02.000:36.10:3:4:200:102:0:A:0",
						);

						const statAfter = yield* Effect.promise(() => fs.stat(petrFile));
						expect(statAfter.size).toBe(
							SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2,
						);
					}),
				),
			);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("flushes buffered records on periodic interval", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "scid-sink-interval-"),
		);
		const petrFile = path.join(tmpDir, "PETR4.scid");

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							sessionDate: "2026-10-05",
							batchSize: 100, // Large batch size so threshold is not hit
							flushInterval: "20 millis",
						});

						yield* sink.writeLine(
							"V:PETR4:A:10:00:01.000:36.00:1:2:100:101:0:A:0",
						);

						// Sleep long enough for the background interval to trigger flush
						yield* Effect.sleep("60 millis");

						const stat = yield* Effect.promise(() => fs.stat(petrFile));
						expect(stat.size).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE);
					}),
				),
			);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("guarantees clean flush of in-memory records upon scope finalization / interruption", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scid-sink-scope-"));
		const petrFile = path.join(tmpDir, "PETR4.scid");

		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					// Run sink in a child fiber that gets interrupted
					const fiber = yield* Effect.scoped(
						Effect.gen(function* () {
							const sink = yield* makeCedroScidSink({
								baseDir: tmpDir,
								sessionDate: "2026-10-05",
								batchSize: 1000,
								flushInterval: "1 hour",
							});

							yield* sink.writeLine(
								"V:PETR4:A:10:00:01.000:36.00:1:2:100:101:0:A:0",
							);
							yield* sink.writeLine(
								"V:PETR4:A:10:00:02.000:36.05:1:2:100:102:0:A:0",
							);

							// Sleep forever until interrupted
							yield* Effect.never;
						}),
					).pipe(Effect.forkChild);

					// Give time for lines to be processed
					yield* Effect.sleep("20 millis");

					// Interrupt the fiber
					yield* Fiber.interrupt(fiber);

					// Assert that finalizer flushed the 2 records to disk
					const buf = yield* Effect.promise(() => fs.readFile(petrFile));
					expect(buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2);
				}),
			);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("preserves strict monotonicity when resuming on an existing SCID file", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "scid-sink-resume-"),
		);
		const petrFile = path.join(tmpDir, "PETR4.scid");

		try {
			// Session 1: write 1 record
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							sessionDate: "2026-10-05",
							flushInterval: "1 hour",
						});
						yield* sink.writeLine(
							"V:PETR4:A:10:00:00.000:36.00:1:2:100:101:0:A:0",
						);
						yield* sink.flush();
					}),
				),
			);

			// Session 2: new sink instance pointing to same file, writes record with SAME or earlier timestamp
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							sessionDate: "2026-10-05",
							flushInterval: "1 hour",
						});
						yield* sink.writeLine(
							"V:PETR4:A:10:00:00.000:36.10:3:4:200:102:0:A:0",
						);
						yield* sink.flush();
					}),
				),
			);

			const buf = await fs.readFile(petrFile);
			expect(buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2);

			const r1 = deserializeScidRecord(buf, SCID_HEADER_SIZE);
			const r2 = deserializeScidRecord(
				buf,
				SCID_HEADER_SIZE + SCID_RECORD_SIZE,
			);
			expect(r2.dateTime).toBeGreaterThan(r1.dateTime);
			expect(r2.dateTime).toBe(r1.dateTime + 1n);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("supports CedroScidSinkLive Layer and daily partition mode", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scid-sink-layer-"));
		const expectedFile = path.join(tmpDir, "VALE3", "VALE3-2026-10-05.scid");

		try {
			const program = Effect.gen(function* () {
				const sink = yield* CedroScidSink;
				yield* sink.writeLine("V:VALE3:A:11:00:00.000:60.00:1:2:500:301:0:A:0");
				yield* sink.flush();
			});

			const liveLayer = CedroScidSinkLive({
				baseDir: tmpDir,
				sessionDate: "2026-10-05",
				partitionMode: "daily",
				flushInterval: "1 hour",
			});

			await Effect.runPromise(program.pipe(Effect.provide(liveLayer)));

			const buf = await fs.readFile(expectedFile);
			expect(buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE);

			const rec = deserializeScidRecord(buf, SCID_HEADER_SIZE);
			expect(rec.close).toBeCloseTo(60.0, 2);
			expect(rec.askVolume).toBe(500);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
