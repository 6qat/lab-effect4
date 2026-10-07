import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Option } from "effect";
import {
	cedroTimeToScDateTimeMS,
	deserializeScidHeader,
	deserializeScidRecord,
	parseCedroTradeLine,
	SC_EPOCH_DIFF_MICROSECONDS,
	SCID_HEADER_SIZE,
	SCID_RECORD_SIZE,
	type ScidHeader,
	type ScidRecord,
	serializeScidHeader,
	serializeScidRecord,
	writeOrAppendScidFile,
} from "./scid-format.js";

describe("SCID Binary Serialization & Cedro Trade Parsing", () => {
	it("serializes and deserializes a 56-byte s_IntradayHeader", () => {
		const header: ScidHeader = {
			fileType: "SCID",
			headerSize: SCID_HEADER_SIZE,
			recordSize: SCID_RECORD_SIZE,
			version: 1,
			unused1: 0,
			utcStartIndex: 0,
		};

		const buffer = serializeScidHeader(header);
		expect(buffer.byteLength).toBe(56);

		const deserialized = deserializeScidHeader(buffer);
		expect(deserialized.fileType).toBe("SCID");
		expect(deserialized.headerSize).toBe(56);
		expect(deserialized.recordSize).toBe(40);
		expect(deserialized.version).toBe(1);
		expect(deserialized.utcStartIndex).toBe(0);
	});

	it("serializes and deserializes a 40-byte s_IntradayRecord", () => {
		const record: ScidRecord = {
			dateTime: 2209161600000000n + 3600000000n, // 1 hour after 1970-01-01
			open: 36.5,
			high: 36.5,
			low: 36.5,
			close: 36.5,
			numTrades: 1,
			totalVolume: 500,
			bidVolume: 0,
			askVolume: 500,
		};

		const buffer = serializeScidRecord(record);
		expect(buffer.byteLength).toBe(40);

		const deserialized = deserializeScidRecord(buffer, 0);
		expect(deserialized.dateTime).toBe(record.dateTime);
		expect(deserialized.open).toBeCloseTo(36.5, 4);
		expect(deserialized.high).toBeCloseTo(36.5, 4);
		expect(deserialized.low).toBeCloseTo(36.5, 4);
		expect(deserialized.close).toBeCloseTo(36.5, 4);
		expect(deserialized.numTrades).toBe(1);
		expect(deserialized.totalVolume).toBe(500);
		expect(deserialized.bidVolume).toBe(0);
		expect(deserialized.askVolume).toBe(500);
	});

	it("parses Cedro trade message with colon-separated time and maps buyer aggressor", () => {
		const rawLine = "V:PETR4:A:10:15:32.450:36.50:3:8:100:14589201:0:A:0";
		const maybeTrade = parseCedroTradeLine(rawLine);

		expect(Option.isSome(maybeTrade)).toBe(true);
		const trade = Option.getOrThrow(maybeTrade);

		expect(trade.ticker).toBe("PETR4");
		expect(trade.operation).toBe("A");
		expect(trade.timeStr).toBe("10:15:32.450");
		expect(trade.price).toBeCloseTo(36.5, 4);
		expect(trade.buyerBroker).toBe(3);
		expect(trade.sellerBroker).toBe(8);
		expect(trade.quantity).toBe(100);
		expect(trade.tradeId).toBe("14589201");
		expect(trade.condition).toBe(0);
		expect(trade.aggressor).toBe("A");
		expect(trade.originalCondition).toBe("0");
	});

	it("parses Cedro trade message with seller aggressor", () => {
		const rawLine = "V:WINV26:A:14:30:00.120:131250:88:72:5:991283:1:V:RL";
		const maybeTrade = parseCedroTradeLine(rawLine);

		expect(Option.isSome(maybeTrade)).toBe(true);
		const trade = Option.getOrThrow(maybeTrade);

		expect(trade.ticker).toBe("WINV26");
		expect(trade.price).toBe(131250);
		expect(trade.quantity).toBe(5);
		expect(trade.aggressor).toBe("V");
		expect(trade.originalCondition).toBe("RL");
	});

	it("ignores non-trade lines and deletion frames", () => {
		expect(Option.isNone(parseCedroTradeLine("V:PETR4:D:14589201"))).toBe(true);
		expect(Option.isNone(parseCedroTradeLine("V:PETR4:E"))).toBe(true);
		expect(Option.isNone(parseCedroTradeLine("You are connected"))).toBe(true);
		expect(Option.isNone(parseCedroTradeLine("PING"))).toBe(true);
	});

	it("converts B3 trade time to SCDateTimeMS and prevents microsecond collisions", () => {
		// 2026-10-05 10:15:32.450 UTC
		const sessionDate = "2026-10-05";
		const timeStr = "10:15:32.450";

		const ts1 = cedroTimeToScDateTimeMS(timeStr, sessionDate);
		expect(ts1 > SC_EPOCH_DIFF_MICROSECONDS).toBe(true);

		// Same timestamp consecutively should be incremented by 1 microsecond
		const ts2 = cedroTimeToScDateTimeMS(timeStr, sessionDate, ts1);
		expect(ts2).toBe(ts1 + 1n);

		// Third identical timestamp increments again
		const ts3 = cedroTimeToScDateTimeMS(timeStr, sessionDate, ts2);
		expect(ts3).toBe(ts1 + 2n);

		// A later time should naturally be greater without artificial increment
		const tsLater = cedroTimeToScDateTimeMS("10:15:32.451", sessionDate, ts3);
		expect(tsLater > ts3).toBe(true);
	});

	it("accurately parses compact Cedro trade time without colons (HHmmssSSS and HHmmss)", () => {
		const sessionDate = "2026-10-06";
		// 10:01:54.306 in compact format "100154306"
		const tsCompact = cedroTimeToScDateTimeMS("100154306", sessionDate);
		const tsColon = cedroTimeToScDateTimeMS("10:01:54.306", sessionDate);
		expect(tsCompact).toBe(tsColon);

		// 10:01:54 with 0 ms in compact format "100154"
		const tsCompactNoMs = cedroTimeToScDateTimeMS("100154", sessionDate);
		const tsColonNoMs = cedroTimeToScDateTimeMS("10:01:54", sessionDate);
		expect(tsCompactNoMs).toBe(tsColonNoMs);

		// Parse actual wire line from Cedro
		const rawLine = "V:WINV26:A:100154306:206395:3:3:1:16942040:2:I:RL";
		const opt = parseCedroTradeLine(rawLine);
		expect(Option.isSome(opt)).toBe(true);
		if (Option.isSome(opt)) {
			expect(opt.value.ticker).toBe("WINV26");
			expect(opt.value.timeStr).toBe("100154306");
			expect(opt.value.price).toBe(206395);
			expect(opt.value.quantity).toBe(1);
			expect(opt.value.tradeId).toBe("16942040");
			expect(opt.value.aggressor).toBe("I");
		}
	});

	it("writes 56-byte header on file creation and appends 40-byte records", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scid-test-"));
		const filePath = path.join(tmpDir, "PETR4.scid");

		try {
			const record1: ScidRecord = {
				dateTime: 2209161600000000n + 1000n,
				open: 36.5,
				high: 36.5,
				low: 36.5,
				close: 36.5,
				numTrades: 1,
				totalVolume: 100,
				bidVolume: 0,
				askVolume: 100,
			};

			const record2: ScidRecord = {
				dateTime: 2209161600000000n + 2000n,
				open: 36.55,
				high: 36.55,
				low: 36.55,
				close: 36.55,
				numTrades: 1,
				totalVolume: 200,
				bidVolume: 200,
				askVolume: 0,
			};

			// First write: creates file with 56-byte header + 40-byte record
			await writeOrAppendScidFile(filePath, [record1]);

			const stat1 = await fs.stat(filePath);
			expect(stat1.size).toBe(56 + 40);

			// Second write: appends 40-byte record without duplicating header
			await writeOrAppendScidFile(filePath, [record2]);

			const stat2 = await fs.stat(filePath);
			expect(stat2.size).toBe(56 + 40 * 2);

			// Read back entire file and verify contents
			const fileBuffer = await fs.readFile(filePath);
			const header = deserializeScidHeader(fileBuffer.subarray(0, 56));
			expect(header.fileType).toBe("SCID");
			expect(header.headerSize).toBe(56);
			expect(header.recordSize).toBe(40);

			const r1 = deserializeScidRecord(fileBuffer, 56);
			expect(r1.dateTime).toBe(record1.dateTime);
			expect(r1.close).toBeCloseTo(36.5, 4);
			expect(r1.askVolume).toBe(100);

			const r2 = deserializeScidRecord(fileBuffer, 56 + 40);
			expect(r2.dateTime).toBe(record2.dateTime);
			expect(r2.close).toBeCloseTo(36.55, 4);
			expect(r2.bidVolume).toBe(200);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
