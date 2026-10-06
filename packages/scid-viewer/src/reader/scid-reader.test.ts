import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import {
	SC_EPOCH_DIFF_MICROSECONDS,
	SCID_HEADER_SIZE,
	SCID_MAGIC,
	SCID_RECORD_SIZE,
	SCID_VERSION,
	type ScidRecord,
	serializeScidHeader,
	serializeScidRecord,
} from "tcp/scid-format";
import { InvalidScidHeaderError, ScidFileNotFoundError } from "./errors.js";
import {
	determineAggressorSide,
	ScidReader,
	ScidReaderLive,
	scDateTimeMSToIsoUtc,
	scDateTimeMSToLocal,
} from "./scid-reader.js";

const createTempScidFile = async (
	recordCount: number,
	options?: {
		magic?: string;
		headerSize?: number;
		recordSize?: number;
		corruptSize?: boolean;
	},
): Promise<string> => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scid-reader-test-"));
	const filePath = path.join(dir, "test.scid");

	if (options?.corruptSize) {
		await fs.writeFile(filePath, Buffer.alloc(20)); // smaller than 56 bytes
		return filePath;
	}

	const headerBuf = serializeScidHeader({
		fileType: options?.magic ?? SCID_MAGIC,
		headerSize: options?.headerSize ?? SCID_HEADER_SIZE,
		recordSize: options?.recordSize ?? SCID_RECORD_SIZE,
		version: SCID_VERSION,
	});

	const records: ScidRecord[] = [];
	const baseTime = SC_EPOCH_DIFF_MICROSECONDS + 1728211200000000n; // 2024-10-06 10:40:00 UTC

	for (let i = 0; i < recordCount; i++) {
		const isBuy = i % 3 === 0;
		const isSell = i % 3 === 1;
		const qty = 5 + i;
		records.push({
			dateTime: baseTime + BigInt(i * 1000), // 1ms intervals
			open: 125000 + i * 5,
			high: 125000 + i * 5,
			low: 125000 + i * 5,
			close: 125000 + i * 5,
			numTrades: 1,
			totalVolume: qty,
			bidVolume: isSell ? qty : 0,
			askVolume: isBuy ? qty : 0,
		});
	}

	const recordBuffers = Buffer.concat(records.map(serializeScidRecord));
	await fs.writeFile(filePath, Buffer.concat([headerBuf, recordBuffers]));
	return filePath;
};

describe("ScidReader Effect Service", () => {
	describe("Header & Record Counting", () => {
		it("extracts valid SCID header metadata correctly", async () => {
			const filePath = await createTempScidFile(10);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.getHeader(filePath);
			}).pipe(Effect.provide(ScidReaderLive));

			const header = await Effect.runPromise(program);
			expect(header.fileType).toBe("SCID");
			expect(header.headerSize).toBe(56);
			expect(header.recordSize).toBe(40);
			expect(header.version).toBe(1);
		});

		it("fails with ScidFileNotFoundError for non-existent file", async () => {
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.getHeader("/tmp/does-not-exist-12345.scid");
			}).pipe(Effect.provide(ScidReaderLive));

			const err = await Effect.runPromise(Effect.flip(program));
			expect(err).toBeInstanceOf(ScidFileNotFoundError);
		});

		it("fails with InvalidScidHeaderError when file is truncated under 56 bytes", async () => {
			const filePath = await createTempScidFile(0, { corruptSize: true });
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.getHeader(filePath);
			}).pipe(Effect.provide(ScidReaderLive));

			const err = await Effect.runPromise(Effect.flip(program));
			expect(err).toBeInstanceOf(InvalidScidHeaderError);
		});

		it("fails with InvalidScidHeaderError on invalid magic identifier", async () => {
			const filePath = await createTempScidFile(0, { magic: "BAD!" });
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.getHeader(filePath);
			}).pipe(Effect.provide(ScidReaderLive));

			const err = await Effect.runPromise(Effect.flip(program));
			expect(err).toBeInstanceOf(InvalidScidHeaderError);
		});

		it("counts 0 records for header-only file", async () => {
			const filePath = await createTempScidFile(0);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.getRecordCount(filePath);
			}).pipe(Effect.provide(ScidReaderLive));

			const count = await Effect.runPromise(program);
			expect(count).toBe(0);
		});

		it("counts exact number of records for multi-record file", async () => {
			const filePath = await createTempScidFile(150);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.getRecordCount(filePath);
			}).pipe(Effect.provide(ScidReaderLive));

			const count = await Effect.runPromise(program);
			expect(count).toBe(150);
		});
	});

	describe("Summary Extraction", () => {
		it("returns comprehensive file summary including first and last timestamps", async () => {
			const filePath = await createTempScidFile(100);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.getSummary(filePath);
			}).pipe(Effect.provide(ScidReaderLive));

			const summary = await Effect.runPromise(program);
			expect(summary.totalRecords).toBe(100);
			expect(summary.fileSize).toBe(56 + 100 * 40);
			expect(summary.header.fileType).toBe("SCID");
			expect(summary.firstRecordDateTime).toBeDefined();
			expect(summary.lastRecordDateTime).toBeDefined();
			expect(summary.firstRecordIsoUtc).toContain("Z");
			expect(summary.lastRecordIsoUtc).toContain("Z");
			expect(
				(summary.lastRecordDateTime ?? 0n) >
					(summary.firstRecordDateTime ?? 0n),
			).toBe(true);
		});

		it("returns clean summary for empty (header-only) file", async () => {
			const filePath = await createTempScidFile(0);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.getSummary(filePath);
			}).pipe(Effect.provide(ScidReaderLive));

			const summary = await Effect.runPromise(program);
			expect(summary.totalRecords).toBe(0);
			expect(summary.fileSize).toBe(56);
			expect(summary.firstRecordDateTime).toBeUndefined();
			expect(summary.lastRecordDateTime).toBeUndefined();
		});
	});

	describe("O(1) Random Seek Slicing (readSlice)", () => {
		it("slices initial window (page 0) with formatted columns and correct indices", async () => {
			const filePath = await createTempScidFile(50);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.readSlice(filePath, 0, 10);
			}).pipe(Effect.provide(ScidReaderLive));

			const slice = await Effect.runPromise(program);
			expect(slice.length).toBe(10);
			expect(slice[0]?.index).toBe(0);
			expect(slice[0]?.open).toBe(125000);
			expect(slice[0]?.side).toBe("BUY");
			expect(slice[9]?.index).toBe(9);
		});

		it("slices arbitrary middle window instantaneously", async () => {
			const filePath = await createTempScidFile(100);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.readSlice(filePath, 25, 5);
			}).pipe(Effect.provide(ScidReaderLive));

			const slice = await Effect.runPromise(program);
			expect(slice.length).toBe(5);
			expect(slice[0]?.index).toBe(25);
			expect(slice[0]?.open).toBe(125000 + 25 * 5);
			expect(slice[4]?.index).toBe(29);
		});

		it("returns empty array when offset exceeds total records", async () => {
			const filePath = await createTempScidFile(20);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.readSlice(filePath, 50, 10);
			}).pipe(Effect.provide(ScidReaderLive));

			const slice = await Effect.runPromise(program);
			expect(slice).toEqual([]);
		});

		it("clamps limit when slice extends past end of file", async () => {
			const filePath = await createTempScidFile(25);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.readSlice(filePath, 20, 100);
			}).pipe(Effect.provide(ScidReaderLive));

			const slice = await Effect.runPromise(program);
			expect(slice.length).toBe(5); // records 20, 21, 22, 23, 24
			expect(slice[0]?.index).toBe(20);
			expect(slice[4]?.index).toBe(24);
		});
	});

	describe("Append Slicing (readAppends)", () => {
		it("returns empty when fromIndex equals or exceeds totalRecords", async () => {
			const filePath = await createTempScidFile(10);
			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.readAppends(filePath, 10);
			}).pipe(Effect.provide(ScidReaderLive));

			const result = await Effect.runPromise(program);
			expect(result.totalRecords).toBe(10);
			expect(result.records).toEqual([]);
		});

		it("reads newly appended records starting from fromIndex", async () => {
			const filePath = await createTempScidFile(10);
			// Append 3 more records
			const fd = await fs.open(filePath, "a");
			try {
				for (let i = 10; i < 13; i++) {
					const record: ScidRecord = {
						dateTime: BigInt(i * 1000),
						open: 125000 + i * 5,
						high: 125000 + i * 5,
						low: 125000 + i * 5,
						close: 125000 + i * 5,
						numTrades: 1,
						totalVolume: 10,
						bidVolume: 0,
						askVolume: 10,
					};
					const buf = serializeScidRecord(record);
					await fd.write(buf);
				}
			} finally {
				await fd.close();
			}

			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				return yield* reader.readAppends(filePath, 10);
			}).pipe(Effect.provide(ScidReaderLive));

			const result = await Effect.runPromise(program);
			expect(result.totalRecords).toBe(13);
			expect(result.records.length).toBe(3);
			expect(result.records[0]?.index).toBe(10);
			expect(result.records[0]?.open).toBe(125050);
			expect(result.records[2]?.index).toBe(12);
		});
	});

	describe("Epoch & Aggressor Helpers", () => {
		it("converts SCDateTimeMS to valid ISO UTC and local strings", () => {
			// 2026-10-06 12:00:00 UTC
			const unixMs = Date.UTC(2026, 9, 6, 12, 0, 0, 500);
			const scDateTimeMS =
				BigInt(unixMs) * 1000n + SC_EPOCH_DIFF_MICROSECONDS + 250n; // with 250 microseconds

			const iso = scDateTimeMSToIsoUtc(scDateTimeMS);
			expect(iso).toBe("2026-10-06T12:00:00.500250Z");

			const local = scDateTimeMSToLocal(scDateTimeMS);
			expect(local).toContain("2026-10-06");
			expect(local).toContain("500250");
		});

		it("maps trade aggressor sides correctly", () => {
			expect(determineAggressorSide(0, 100)).toBe("BUY");
			expect(determineAggressorSide(100, 0)).toBe("SELL");
			expect(determineAggressorSide(50, 100)).toBe("BUY");
			expect(determineAggressorSide(100, 50)).toBe("SELL");
			expect(determineAggressorSide(0, 0)).toBe("NEUTRAL");
			expect(determineAggressorSide(100, 100)).toBe("NEUTRAL");
		});
	});
});
