import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Option } from "effect";

export const SCID_HEADER_SIZE = 56;
export const SCID_RECORD_SIZE = 40;
export const SCID_MAGIC = "SCID";
export const SCID_VERSION = 1;

/**
 * Microseconds between Microsoft/Sierra Chart epoch (December 30, 1899, 00:00:00 UTC)
 * and Unix epoch (January 1, 1970, 00:00:00 UTC).
 * 25,569 days * 86,400 seconds * 1,000,000 microseconds = 2,209,161,600,000,000 µs.
 */
export const SC_EPOCH_DIFF_MICROSECONDS = 2209161600000000n;

export interface ScidHeader {
	readonly fileType: string;
	readonly headerSize: number;
	readonly recordSize: number;
	readonly version: number;
	readonly unused1: number;
	readonly utcStartIndex: number;
}

export interface ScidRecord {
	/** Microseconds since 1899-12-30 00:00:00 UTC */
	readonly dateTime: bigint;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
	readonly numTrades: number;
	readonly totalVolume: number;
	readonly bidVolume: number;
	readonly askVolume: number;
}

export interface CedroTrade {
	readonly ticker: string;
	readonly operation: string;
	readonly timeStr: string;
	readonly price: number;
	readonly buyerBroker: number;
	readonly sellerBroker: number;
	readonly quantity: number;
	readonly tradeId: string;
	readonly condition: number;
	readonly aggressor: "A" | "V" | "I";
	readonly originalCondition: string;
}

/**
 * Serializes an s_IntradayHeader (56 bytes, Little-Endian).
 */
export const serializeScidHeader = (header?: Partial<ScidHeader>): Buffer => {
	const buf = Buffer.alloc(SCID_HEADER_SIZE, 0);
	buf.write(header?.fileType ?? SCID_MAGIC, 0, 4, "ascii");
	buf.writeUInt32LE(header?.headerSize ?? SCID_HEADER_SIZE, 4);
	buf.writeUInt32LE(header?.recordSize ?? SCID_RECORD_SIZE, 8);
	buf.writeUInt16LE(header?.version ?? SCID_VERSION, 12);
	buf.writeUInt16LE(header?.unused1 ?? 0, 14);
	buf.writeUInt32LE(header?.utcStartIndex ?? 0, 16);
	// Bytes 20..55 remain zeroed as reserved
	return buf;
};

/**
 * Deserializes an s_IntradayHeader from a 56-byte buffer.
 */
export const deserializeScidHeader = (buffer: Uint8Array): ScidHeader => {
	if (buffer.byteLength < SCID_HEADER_SIZE) {
		throw new Error(
			`Invalid SCID header buffer size: expected ${SCID_HEADER_SIZE}, got ${buffer.byteLength}`,
		);
	}
	const view = Buffer.isBuffer(buffer)
		? buffer
		: Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const fileType = view.toString("ascii", 0, 4);
	const headerSize = view.readUInt32LE(4);
	const recordSize = view.readUInt32LE(8);
	const version = view.readUInt16LE(12);
	const unused1 = view.readUInt16LE(14);
	const utcStartIndex = view.readUInt32LE(16);

	return {
		fileType,
		headerSize,
		recordSize,
		version,
		unused1,
		utcStartIndex,
	};
};

/**
 * Serializes an s_IntradayRecord (40 bytes, Little-Endian, 8-byte aligned).
 */
export const serializeScidRecord = (record: ScidRecord): Buffer => {
	const buf = Buffer.alloc(SCID_RECORD_SIZE, 0);
	buf.writeBigInt64LE(record.dateTime, 0);
	buf.writeFloatLE(record.open, 8);
	buf.writeFloatLE(record.high, 12);
	buf.writeFloatLE(record.low, 16);
	buf.writeFloatLE(record.close, 20);
	buf.writeUInt32LE(record.numTrades, 24);
	buf.writeUInt32LE(record.totalVolume, 28);
	buf.writeUInt32LE(record.bidVolume, 32);
	buf.writeUInt32LE(record.askVolume, 36);
	return buf;
};

/**
 * Deserializes an s_IntradayRecord from a 40-byte buffer at specified offset.
 */
export const deserializeScidRecord = (
	buffer: Uint8Array,
	offset = 0,
): ScidRecord => {
	if (offset + SCID_RECORD_SIZE > buffer.byteLength) {
		throw new Error(
			`Buffer overrun reading SCID record: offset ${offset} + ${SCID_RECORD_SIZE} > ${buffer.byteLength}`,
		);
	}
	const view = Buffer.isBuffer(buffer)
		? buffer
		: Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	return {
		dateTime: view.readBigInt64LE(offset),
		open: view.readFloatLE(offset + 8),
		high: view.readFloatLE(offset + 12),
		low: view.readFloatLE(offset + 16),
		close: view.readFloatLE(offset + 20),
		numTrades: view.readUInt32LE(offset + 24),
		totalVolume: view.readUInt32LE(offset + 28),
		bidVolume: view.readUInt32LE(offset + 32),
		askVolume: view.readUInt32LE(offset + 36),
	};
};

/**
 * Parses an incoming Cedro trade line:
 * V:<ativo>:<operação>:<horário>:<preço>:<corretora_compra>:<corretora_venda>:<quantidade>:<id_negócio>:<condição>:<agressor>:<condição_original>
 *
 * Uses tail-anchored parsing so time strings containing internal colons (e.g. 10:15:32.450)
 * are cleanly handled without field misalignment.
 */
export const parseCedroTradeLine = (
	line: string,
): Option.Option<CedroTrade> => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("V:")) {
		return Option.none();
	}

	const tokens = trimmed.split(":");
	// Minimum: "V", <ticker>, <op>, <time...>, <price>, <buy>, <sell>, <qty>, <id>, <cond>, <aggr>, <origCond>
	// 3 prefix tokens + at least 1 time token + 8 suffix tokens = 12 tokens minimum
	if (tokens.length < 12) {
		return Option.none();
	}

	const prefix = tokens[0];
	const ticker = tokens[1];
	const operation = tokens[2];

	if (prefix !== "V" || !ticker || operation !== "A") {
		return Option.none();
	}

	const tailLen = 8;
	const tail = tokens.slice(tokens.length - tailLen);
	const timeTokens = tokens.slice(3, tokens.length - tailLen);

	const timeStr = timeTokens.join(":");
	const price = parseFloat(tail[0] ?? "");
	const buyerBroker = parseInt(tail[1] ?? "", 10);
	const sellerBroker = parseInt(tail[2] ?? "", 10);
	const quantity = parseInt(tail[3] ?? "", 10);
	const tradeId = tail[4] ?? "";
	const condition = parseInt(tail[5] ?? "", 10);
	const rawAggressor = tail[6]?.toUpperCase();
	const originalCondition = tail[7] ?? "0";

	if (Number.isNaN(price) || Number.isNaN(quantity) || !tradeId) {
		return Option.none();
	}

	const aggressor: "A" | "V" | "I" =
		rawAggressor === "A" || rawAggressor === "V" ? rawAggressor : "I";

	return Option.some({
		ticker,
		operation,
		timeStr,
		price,
		buyerBroker: Number.isNaN(buyerBroker) ? 0 : buyerBroker,
		sellerBroker: Number.isNaN(sellerBroker) ? 0 : sellerBroker,
		quantity,
		tradeId,
		condition: Number.isNaN(condition) ? 0 : condition,
		aggressor,
		originalCondition,
	});
};

/**
 * Converts a Cedro time string (e.g. "10:15:32.450") and date string ("YYYY-MM-DD")
 * into SCDateTimeMS (microseconds since 1899-12-30 00:00:00 UTC).
 *
 * If `lastTimestamp` is provided and the calculated timestamp is <= lastTimestamp,
 * it increments by 1 microsecond to guarantee strict monotonicity on disk.
 */
export const cedroTimeToScDateTimeMS = (
	timeStr: string,
	sessionDate?: string,
	lastTimestamp?: bigint,
): bigint => {
	const now = new Date();
	let year = now.getUTCFullYear();
	let month = now.getUTCMonth();
	let day = now.getUTCDate();

	if (sessionDate) {
		const parts = sessionDate.split("-");
		if (parts.length === 3) {
			year = parseInt(parts[0] ?? "", 10);
			month = parseInt(parts[1] ?? "", 10) - 1;
			day = parseInt(parts[2] ?? "", 10);
		}
	}

	// Parse time string:
	// Format 1: Colon-separated "HH:mm:ss.SSS" or "HH:mm:ss"
	// Format 2: Compact digit string "HHmmssSSS" (e.g. 100154306) or "HHmmss" (e.g. 100154)
	let hours = 0;
	let minutes = 0;
	let seconds = 0;
	let millis = 0;

	if (timeStr.includes(":")) {
		const [hms, msPart] = timeStr.split(/[.,]/);
		if (hms) {
			const hmsTokens = hms.split(":");
			if (hmsTokens.length >= 3) {
				hours = parseInt(hmsTokens[0] ?? "", 10);
				minutes = parseInt(hmsTokens[1] ?? "", 10);
				seconds = parseInt(hmsTokens[2] ?? "", 10);
			}
		}
		if (msPart) {
			millis = parseInt(msPart.padEnd(3, "0").slice(0, 3), 10);
		}
	} else if (/^\d{6,9}$/.test(timeStr)) {
		hours = parseInt(timeStr.slice(0, 2), 10);
		minutes = parseInt(timeStr.slice(2, 4), 10);
		seconds = parseInt(timeStr.slice(4, 6), 10);
		if (timeStr.length > 6) {
			millis = parseInt(timeStr.slice(6, 9).padEnd(3, "0"), 10);
		}
	}

	const unixMs = Date.UTC(year, month, day, hours, minutes, seconds, millis);
	const unixMicroseconds = BigInt(unixMs) * 1000n;
	let scDateTimeMS = unixMicroseconds + SC_EPOCH_DIFF_MICROSECONDS;

	if (lastTimestamp !== undefined && scDateTimeMS <= lastTimestamp) {
		scDateTimeMS = lastTimestamp + 1n;
	}

	return scDateTimeMS;
};

/**
 * Maps a parsed Cedro trade and its calculated SCDateTimeMS into an s_IntradayRecord.
 */
export const tradeToScidRecord = (
	trade: CedroTrade,
	dateTime: bigint,
): ScidRecord => ({
	dateTime,
	open: trade.price,
	high: trade.price,
	low: trade.price,
	close: trade.price,
	numTrades: 1,
	totalVolume: trade.quantity,
	bidVolume: trade.aggressor === "V" ? trade.quantity : 0,
	askVolume: trade.aggressor === "A" ? trade.quantity : 0,
});

/**
 * Writes or appends SCID records to disk.
 * If the file does not exist, it creates parent directories, writes the 56-byte header,
 * and appends the 40-byte records.
 * If the file already exists, it appends the records directly.
 */
export const writeOrAppendScidFile = async (
	filePath: string,
	records: ReadonlyArray<ScidRecord>,
): Promise<void> => {
	if (records.length === 0) return;

	await fs.mkdir(path.dirname(filePath), { recursive: true });

	let fileExists = false;
	try {
		const stat = await fs.stat(filePath);
		if (stat.size >= SCID_HEADER_SIZE) {
			fileExists = true;
		}
	} catch {
		fileExists = false;
	}

	const recordBuffers = records.map(serializeScidRecord);
	const recordsTotal = Buffer.concat(recordBuffers);

	if (!fileExists) {
		const headerBuf = serializeScidHeader();
		const combined = Buffer.concat([headerBuf, recordsTotal]);
		await fs.writeFile(filePath, combined);
	} else {
		await fs.appendFile(filePath, recordsTotal);
	}
};
