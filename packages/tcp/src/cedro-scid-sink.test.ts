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

	it("handles dynamic date rollover via getCurrentDate in daily partition mode", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "scid-sink-dyn-rollover-"),
		);
		let mockDate = "2026-10-05";

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							getCurrentDate: () => mockDate,
							partitionMode: "daily",
							flushInterval: "1 hour",
						});

						// Trades on Day 1
						yield* sink.writeLine(
							"V:PETR4:A:17:59:50.000:36.00:1:2:100:101:0:A:0",
						);
						yield* sink.writeLine(
							"V:PETR4:A:17:59:55.000:36.10:1:2:100:102:0:A:0",
						);

						// Day rolls over to 2026-10-06
						mockDate = "2026-10-06";

						// Trade on Day 2 triggers automatic rollover, flushing Day 1 and initializing Day 2
						yield* sink.writeLine(
							"V:PETR4:A:10:00:00.000:36.50:1:2:200:201:0:A:0",
						);
						yield* sink.flush();
					}),
				),
			);

			// Assert Day 1 file
			const day1File = path.join(tmpDir, "PETR4", "PETR4-2026-10-05.scid");
			const day1Buf = await fs.readFile(day1File);
			expect(day1Buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2);

			const d1Header = deserializeScidHeader(
				day1Buf.subarray(0, SCID_HEADER_SIZE),
			);
			expect(d1Header.fileType).toBe("SCID");

			const d1r1 = deserializeScidRecord(day1Buf, SCID_HEADER_SIZE);
			expect(d1r1.close).toBeCloseTo(36.0, 2);

			const d1r2 = deserializeScidRecord(
				day1Buf,
				SCID_HEADER_SIZE + SCID_RECORD_SIZE,
			);
			expect(d1r2.close).toBeCloseTo(36.1, 2);

			// Assert Day 2 file
			const day2File = path.join(tmpDir, "PETR4", "PETR4-2026-10-06.scid");
			const day2Buf = await fs.readFile(day2File);
			expect(day2Buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE);

			const d2Header = deserializeScidHeader(
				day2Buf.subarray(0, SCID_HEADER_SIZE),
			);
			expect(d2Header.fileType).toBe("SCID");

			const d2r1 = deserializeScidRecord(day2Buf, SCID_HEADER_SIZE);
			expect(d2r1.close).toBeCloseTo(36.5, 2);
			expect(d2r1.askVolume).toBe(200);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("handles manual date rollover via rotateDate", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "scid-sink-manual-rollover-"),
		);

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							sessionDate: "2026-10-05",
							partitionMode: "daily",
							flushInterval: "1 hour",
						});

						yield* sink.writeLine(
							"V:WINV26:A:17:55:00.000:130000:1:2:5:101:0:A:0",
						);

						// Explicitly rotate date to next day
						yield* sink.rotateDate("2026-10-06");

						yield* sink.writeLine(
							"V:WINV26:A:09:05:00.000:130200:1:2:10:201:0:V:0",
						);
						yield* sink.flush();
					}),
				),
			);

			const day1File = path.join(tmpDir, "WINV26", "WINV26-2026-10-05.scid");
			const day1Buf = await fs.readFile(day1File);
			expect(day1Buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE);

			const day2File = path.join(tmpDir, "WINV26", "WINV26-2026-10-06.scid");
			const day2Buf = await fs.readFile(day2File);
			expect(day2Buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE);

			const rec2 = deserializeScidRecord(day2Buf, SCID_HEADER_SIZE);
			expect(rec2.close).toBe(130200);
			expect(rec2.bidVolume).toBe(10);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("monolithic mode appends across date rollovers into a single file", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "scid-sink-mono-rollover-"),
		);
		const petrFile = path.join(tmpDir, "PETR4.scid");
		let mockDate = "2026-10-05";

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							getCurrentDate: () => mockDate,
							partitionMode: "monolithic",
							flushInterval: "1 hour",
						});

						// Day 1 trade
						yield* sink.writeLine(
							"V:PETR4:A:17:59:00.000:36.00:1:2:100:101:0:A:0",
						);

						// Advance date
						mockDate = "2026-10-06";

						// Day 2 trade
						yield* sink.writeLine(
							"V:PETR4:A:10:00:00.000:36.20:1:2:150:201:0:A:0",
						);
						yield* sink.flush();
					}),
				),
			);

			// Assert single file directly in baseDir
			const buf = await fs.readFile(petrFile);
			expect(buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE * 2);

			const r1 = deserializeScidRecord(buf, SCID_HEADER_SIZE);
			const r2 = deserializeScidRecord(
				buf,
				SCID_HEADER_SIZE + SCID_RECORD_SIZE,
			);

			expect(r1.close).toBeCloseTo(36.0, 2);
			expect(r2.close).toBeCloseTo(36.2, 2);
			expect(r2.dateTime).toBeGreaterThan(r1.dateTime);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("processes real Cedro compact wire format trades without colon separators", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "scid-sink-compact-"),
		);
		const winFile = path.join(tmpDir, "WINV26", "WINV26-2026-10-07.scid");

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							sessionDate: "2026-10-07",
							partitionMode: "daily",
							flushInterval: "1 hour",
						});

						// Real wire format trade from datafeedcd3.cedrotech.com
						yield* sink.writeLine(
							"V:WINV26:A:100154306:206395:3:3:1:16942040:2:I:RL",
						);
						yield* sink.flush();
					}),
				),
			);

			const buf = await fs.readFile(winFile);
			expect(buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE);

			const record = deserializeScidRecord(buf, SCID_HEADER_SIZE);
			expect(record.close).toBe(206395);
			expect(record.totalVolume).toBe(1);
			expect(record.numTrades).toBe(1);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("rotates file during flushAllInternal when date rolls over before next trade", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "scid-sink-flush-rollover-"),
		);
		let mockDate = "2026-10-06";

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const sink = yield* makeCedroScidSink({
							baseDir: tmpDir,
							getCurrentDate: () => mockDate,
							partitionMode: "daily",
							flushInterval: "1 hour",
						});

						// Day 1 trade buffered
						yield* sink.writeLine(
							"V:WINV26:A:235959000:206000:1:2:5:1001:0:A:0",
						);

						// Midnight passes before next trade arrives
						mockDate = "2026-10-07";

						// Periodic or manual flush executes
						yield* sink.flush();

						// Day 2 trade arrives after flush
						yield* sink.writeLine(
							"V:WINV26:A:090001000:206100:1:2:10:1002:0:A:0",
						);
						yield* sink.flush();
					}),
				),
			);

			const day1File = path.join(tmpDir, "WINV26", "WINV26-2026-10-06.scid");
			const day2File = path.join(tmpDir, "WINV26", "WINV26-2026-10-07.scid");

			const d1Buf = await fs.readFile(day1File);
			const d2Buf = await fs.readFile(day2File);

			expect(d1Buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE);
			expect(d2Buf.byteLength).toBe(SCID_HEADER_SIZE + SCID_RECORD_SIZE);

			const r1 = deserializeScidRecord(d1Buf, SCID_HEADER_SIZE);
			const r2 = deserializeScidRecord(d2Buf, SCID_HEADER_SIZE);
			expect(r1.close).toBe(206000);
			expect(r2.close).toBe(206100);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
