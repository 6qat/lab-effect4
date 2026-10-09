import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import {
	deserializeScidHeader,
	deserializeScidRecord,
	SC_EPOCH_DIFF_MICROSECONDS,
	SCID_HEADER_SIZE,
	SCID_MAGIC,
	SCID_RECORD_SIZE,
	type ScidHeader,
	type ScidRecord,
} from "tcp/scid-format";
import {
	InvalidScidHeaderError,
	ScidFileNotFoundError,
	ScidReadCorruptedError,
	type ScidReaderError,
} from "./errors.js";

export interface FormattedScidRecord {
	readonly index: number;
	readonly dateTimeRaw: bigint | string;
	readonly isoUtc: string;
	readonly localFormatted: string;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
	readonly price: number;
	readonly numTrades: number;
	readonly totalVolume: number;
	readonly bidVolume: number;
	readonly askVolume: number;
	readonly side: "BUY" | "SELL" | "NEUTRAL";
}

export interface ScidFileSummary {
	readonly header: ScidHeader;
	readonly totalRecords: number;
	readonly fileSize: number;
	readonly firstRecordDateTime?: bigint | undefined;
	readonly lastRecordDateTime?: bigint | undefined;
	readonly firstRecordIsoUtc?: string | undefined;
	readonly lastRecordIsoUtc?: string | undefined;
}

export const scDateTimeMSToIsoUtc = (scDateTimeMS: bigint): string => {
	const unixMicroseconds = scDateTimeMS - SC_EPOCH_DIFF_MICROSECONDS;
	const unixMs = Number(unixMicroseconds / 1000n);
	const micros = Math.abs(Number(unixMicroseconds % 1000n));
	const date = new Date(unixMs);
	const iso = date.toISOString();
	const dotIndex = iso.lastIndexOf(".");
	if (dotIndex !== -1) {
		const base = iso.slice(0, dotIndex + 1);
		const ms = iso.slice(dotIndex + 1, dotIndex + 4);
		return `${base}${ms}${micros.toString().padStart(3, "0")}Z`;
	}
	return iso;
};

export const scDateTimeMSToLocal = (scDateTimeMS: bigint): string => {
	const unixMicroseconds = scDateTimeMS - SC_EPOCH_DIFF_MICROSECONDS;
	const unixMs = Number(unixMicroseconds / 1000n);
	const micros = Math.abs(Number(unixMicroseconds % 1000n));
	const date = new Date(unixMs);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	const millis = String(date.getMilliseconds()).padStart(3, "0");
	const microStr = String(micros).padStart(3, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}${microStr}`;
};

export const determineAggressorSide = (
	bidVolume: number,
	askVolume: number,
): "BUY" | "SELL" | "NEUTRAL" => {
	if (askVolume > 0 && bidVolume === 0) return "BUY";
	if (bidVolume > 0 && askVolume === 0) return "SELL";
	if (askVolume > bidVolume) return "BUY";
	if (bidVolume > askVolume) return "SELL";
	return "NEUTRAL";
};

export interface ScidReaderShape {
	readonly getHeader: (
		filePath: string,
	) => Effect.Effect<ScidHeader, ScidReaderError>;

	readonly getRecordCount: (
		filePath: string,
	) => Effect.Effect<number, ScidReaderError>;

	readonly getSummary: (
		filePath: string,
	) => Effect.Effect<ScidFileSummary, ScidReaderError>;

	/**
	 * Reads a window of records. Omitting `limit` reads to the end of the file.
	 * Returns the records alongside the file's record count and size.
	 */
	readonly readSlice: (
		filePath: string,
		offsetIndex: number,
		limit?: number,
	) => Effect.Effect<
		{
			readonly records: ReadonlyArray<FormattedScidRecord>;
			readonly totalRecords: number;
			readonly fileSize: number;
		},
		ScidReaderError
	>;
}

export class ScidReader extends Context.Service<ScidReader, ScidReaderShape>()(
	"ScidReader",
) {}

interface RecordWindow {
	readonly records: ReadonlyArray<ScidRecord>;
	readonly totalRecords: number;
	readonly fileSize: number;
}

const withFileHandle = <A, E>(
	filePath: string,
	use: (handle: fs.FileHandle) => Effect.Effect<A, E>,
): Effect.Effect<A, E | ScidFileNotFoundError> =>
	Effect.acquireUseRelease(
		Effect.tryPromise({
			try: () => fs.open(filePath, "r"),
			catch: (err) =>
				new ScidFileNotFoundError({
					filePath,
					message: err instanceof Error ? err.message : String(err),
				}),
		}),
		use,
		(handle) => Effect.promise(() => handle.close().catch(() => {})),
	);

/**
 * Runs a file operation, mapping an unexpected failure to a corrupted-read
 * error anchored at `offset` — the single place file-read failures are wrapped.
 */
const attemptFileOp = <A>(
	filePath: string,
	offset: number,
	op: () => Promise<A>,
): Effect.Effect<A, ScidReadCorruptedError> =>
	Effect.tryPromise({
		try: op,
		catch: (e) =>
			new ScidReadCorruptedError({
				filePath,
				offset,
				reason: e instanceof Error ? e.message : String(e),
			}),
	});

/** Byte offset of the record at `index` in the on-disk layout. */
const recordByteOffset = (index: number): number =>
	SCID_HEADER_SIZE + index * SCID_RECORD_SIZE;

/** The complete record count and size of an open file. */
const countRecords = (
	handle: fs.FileHandle,
	filePath: string,
): Effect.Effect<
	{ readonly totalRecords: number; readonly fileSize: number },
	ScidReadCorruptedError
> =>
	Effect.gen(function* () {
		const stat = yield* attemptFileOp(filePath, 0, () => handle.stat());
		return {
			totalRecords: Math.max(
				0,
				Math.floor((stat.size - SCID_HEADER_SIZE) / SCID_RECORD_SIZE),
			),
			fileSize: stat.size,
		};
	});

/**
 * Reads a window of raw records from an open file. Omitting `limit` reads to the
 * end of the file. Returns the window alongside the file's record count and size.
 */
const readRecordWindow = (
	handle: fs.FileHandle,
	filePath: string,
	fromIndex: number,
	limit?: number,
): Effect.Effect<RecordWindow, ScidReadCorruptedError> =>
	Effect.gen(function* () {
		const { totalRecords, fileSize } = yield* countRecords(handle, filePath);
		const available = totalRecords - fromIndex;
		if (fromIndex < 0 || available <= 0) {
			return { records: [], totalRecords, fileSize };
		}
		const count = limit === undefined ? available : Math.min(limit, available);
		if (count <= 0) {
			return { records: [], totalRecords, fileSize };
		}

		const byteOffset = recordByteOffset(fromIndex);
		const byteLength = count * SCID_RECORD_SIZE;
		const buf = Buffer.alloc(byteLength);
		const { bytesRead } = yield* attemptFileOp(filePath, byteOffset, () =>
			handle.read(buf, 0, byteLength, byteOffset),
		);
		if (bytesRead < byteLength) {
			return yield* Effect.fail(
				new ScidReadCorruptedError({
					filePath,
					offset: byteOffset,
					reason: `Expected ${byteLength} bytes for ${count} records, got ${bytesRead}`,
				}),
			);
		}

		const records: ScidRecord[] = [];
		for (let i = 0; i < count; i++) {
			records.push(deserializeScidRecord(buf, i * SCID_RECORD_SIZE));
		}
		return { records, totalRecords, fileSize };
	});

const formatRecord = (raw: ScidRecord, index: number): FormattedScidRecord => ({
	index,
	dateTimeRaw: raw.dateTime.toString(),
	isoUtc: scDateTimeMSToIsoUtc(raw.dateTime),
	localFormatted: scDateTimeMSToLocal(raw.dateTime),
	open: raw.open,
	high: raw.high,
	low: raw.low,
	close: raw.close,
	price: raw.close,
	numTrades: raw.numTrades,
	totalVolume: raw.totalVolume,
	bidVolume: raw.bidVolume,
	askVolume: raw.askVolume,
	side: determineAggressorSide(raw.bidVolume, raw.askVolume),
});

const formatRecords = (
	records: ReadonlyArray<ScidRecord>,
	fromIndex: number,
): FormattedScidRecord[] =>
	records.map((raw, i) => formatRecord(raw, fromIndex + i));

const readHeaderInternal = (
	handle: fs.FileHandle,
	filePath: string,
): Effect.Effect<ScidHeader, InvalidScidHeaderError | ScidReadCorruptedError> =>
	Effect.gen(function* () {
		const stat = yield* attemptFileOp(filePath, 0, () => handle.stat());
		if (stat.size < SCID_HEADER_SIZE) {
			return yield* Effect.fail(
				new InvalidScidHeaderError({
					filePath,
					reason: `File size (${stat.size} bytes) is smaller than SCID header size (${SCID_HEADER_SIZE} bytes)`,
				}),
			);
		}
		const buf = Buffer.alloc(SCID_HEADER_SIZE);
		const { bytesRead } = yield* attemptFileOp(filePath, 0, () =>
			handle.read(buf, 0, SCID_HEADER_SIZE, 0),
		);
		if (bytesRead < SCID_HEADER_SIZE) {
			return yield* Effect.fail(
				new ScidReadCorruptedError({
					filePath,
					offset: 0,
					reason: `Expected ${SCID_HEADER_SIZE} bytes for header, read only ${bytesRead}`,
				}),
			);
		}
		const header = yield* Effect.try({
			try: () => deserializeScidHeader(buf),
			catch: (e) =>
				new ScidReadCorruptedError({
					filePath,
					offset: 0,
					reason: e instanceof Error ? e.message : String(e),
				}),
		});
		if (header.fileType !== SCID_MAGIC) {
			return yield* Effect.fail(
				new InvalidScidHeaderError({
					filePath,
					reason: `Invalid SCID magic identifier: expected '${SCID_MAGIC}', got '${header.fileType}'`,
				}),
			);
		}
		if (
			header.headerSize !== SCID_HEADER_SIZE ||
			header.recordSize !== SCID_RECORD_SIZE
		) {
			return yield* Effect.fail(
				new InvalidScidHeaderError({
					filePath,
					reason: `Invalid header metadata: HeaderSize=${header.headerSize} (expected ${SCID_HEADER_SIZE}), RecordSize=${header.recordSize} (expected ${SCID_RECORD_SIZE})`,
				}),
			);
		}
		return header;
	});

export const makeScidReader = (): ScidReaderShape => ({
	getHeader: (filePath: string) =>
		withFileHandle(filePath, (handle) => readHeaderInternal(handle, filePath)),

	getRecordCount: (filePath: string) =>
		withFileHandle(filePath, (handle) =>
			Effect.gen(function* () {
				yield* readHeaderInternal(handle, filePath);
				const { totalRecords } = yield* countRecords(handle, filePath);
				return totalRecords;
			}),
		),

	getSummary: (filePath: string) =>
		withFileHandle(filePath, (handle) =>
			Effect.gen(function* () {
				const header = yield* readHeaderInternal(handle, filePath);
				const { totalRecords, fileSize } = yield* countRecords(
					handle,
					filePath,
				);

				let firstRecordDateTime: bigint | undefined;
				let lastRecordDateTime: bigint | undefined;
				let firstRecordIsoUtc: string | undefined;
				let lastRecordIsoUtc: string | undefined;

				if (totalRecords > 0) {
					const head = yield* readRecordWindow(handle, filePath, 0, 1);
					const tail = yield* readRecordWindow(
						handle,
						filePath,
						totalRecords - 1,
						1,
					);
					const firstRecord = head.records[0];
					const lastRecord = tail.records[0];
					if (firstRecord) {
						firstRecordDateTime = firstRecord.dateTime;
						firstRecordIsoUtc = scDateTimeMSToIsoUtc(firstRecord.dateTime);
					}
					if (lastRecord) {
						lastRecordDateTime = lastRecord.dateTime;
						lastRecordIsoUtc = scDateTimeMSToIsoUtc(lastRecord.dateTime);
					}
				}

				return {
					header,
					totalRecords,
					fileSize,
					firstRecordDateTime,
					lastRecordDateTime,
					firstRecordIsoUtc,
					lastRecordIsoUtc,
				};
			}),
		),

	readSlice: (filePath: string, offsetIndex: number, limit?: number) =>
		withFileHandle(filePath, (handle) =>
			Effect.gen(function* () {
				yield* readHeaderInternal(handle, filePath);
				const { records, totalRecords, fileSize } = yield* readRecordWindow(
					handle,
					filePath,
					offsetIndex,
					limit,
				);
				return {
					records: formatRecords(records, offsetIndex),
					totalRecords,
					fileSize,
				};
			}),
		),
});

export const ScidReaderLive: Layer.Layer<ScidReader> = Layer.succeed(
	ScidReader,
	ScidReader.of(makeScidReader()),
);
