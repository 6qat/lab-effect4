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
	readonly dateTimeRaw: bigint;
	readonly isoUtc: string;
	readonly localFormatted: string;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
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

	readonly readSlice: (
		filePath: string,
		offsetIndex: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<FormattedScidRecord>, ScidReaderError>;
}

export class ScidReader extends Context.Service<ScidReader, ScidReaderShape>()(
	"ScidReader",
) {}

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

const readHeaderInternal = (
	handle: fs.FileHandle,
	filePath: string,
): Effect.Effect<ScidHeader, InvalidScidHeaderError | ScidReadCorruptedError> =>
	Effect.tryPromise({
		try: async () => {
			const stat = await handle.stat();
			if (stat.size < SCID_HEADER_SIZE) {
				throw new InvalidScidHeaderError({
					filePath,
					reason: `File size (${stat.size} bytes) is smaller than SCID header size (${SCID_HEADER_SIZE} bytes)`,
				});
			}
			const buf = Buffer.alloc(SCID_HEADER_SIZE);
			const { bytesRead } = await handle.read(buf, 0, SCID_HEADER_SIZE, 0);
			if (bytesRead < SCID_HEADER_SIZE) {
				throw new ScidReadCorruptedError({
					filePath,
					offset: 0,
					reason: `Expected ${SCID_HEADER_SIZE} bytes for header, read only ${bytesRead}`,
				});
			}
			const header = deserializeScidHeader(buf);
			if (header.fileType !== SCID_MAGIC) {
				throw new InvalidScidHeaderError({
					filePath,
					reason: `Invalid SCID magic identifier: expected '${SCID_MAGIC}', got '${header.fileType}'`,
				});
			}
			if (
				header.headerSize !== SCID_HEADER_SIZE ||
				header.recordSize !== SCID_RECORD_SIZE
			) {
				throw new InvalidScidHeaderError({
					filePath,
					reason: `Invalid header metadata: HeaderSize=${header.headerSize} (expected ${SCID_HEADER_SIZE}), RecordSize=${header.recordSize} (expected ${SCID_RECORD_SIZE})`,
				});
			}
			return header;
		},
		catch: (e) => {
			if (
				e instanceof InvalidScidHeaderError ||
				e instanceof ScidReadCorruptedError
			) {
				return e;
			}
			return new ScidReadCorruptedError({
				filePath,
				offset: 0,
				reason: e instanceof Error ? e.message : String(e),
			});
		},
	});

export const makeScidReader = (): ScidReaderShape => ({
	getHeader: (filePath: string) =>
		withFileHandle(filePath, (handle) => readHeaderInternal(handle, filePath)),

	getRecordCount: (filePath: string) =>
		withFileHandle(filePath, (handle) =>
			Effect.gen(function* () {
				yield* readHeaderInternal(handle, filePath);
				const stat = yield* Effect.tryPromise({
					try: () => handle.stat(),
					catch: (e) =>
						new ScidReadCorruptedError({
							filePath,
							offset: 0,
							reason: e instanceof Error ? e.message : String(e),
						}),
				});
				return Math.max(
					0,
					Math.floor((stat.size - SCID_HEADER_SIZE) / SCID_RECORD_SIZE),
				);
			}),
		),

	getSummary: (filePath: string) =>
		withFileHandle(filePath, (handle) =>
			Effect.gen(function* () {
				const header = yield* readHeaderInternal(handle, filePath);
				const stat = yield* Effect.tryPromise({
					try: () => handle.stat(),
					catch: (e) =>
						new ScidReadCorruptedError({
							filePath,
							offset: 0,
							reason: e instanceof Error ? e.message : String(e),
						}),
				});
				const totalRecords = Math.max(
					0,
					Math.floor((stat.size - SCID_HEADER_SIZE) / SCID_RECORD_SIZE),
				);

				let firstRecordDateTime: bigint | undefined;
				let lastRecordDateTime: bigint | undefined;
				let firstRecordIsoUtc: string | undefined;
				let lastRecordIsoUtc: string | undefined;

				if (totalRecords > 0) {
					// Read first record
					const firstBuf = Buffer.alloc(SCID_RECORD_SIZE);
					yield* Effect.tryPromise({
						try: () =>
							handle.read(firstBuf, 0, SCID_RECORD_SIZE, SCID_HEADER_SIZE),
						catch: (e) =>
							new ScidReadCorruptedError({
								filePath,
								offset: SCID_HEADER_SIZE,
								reason: e instanceof Error ? e.message : String(e),
							}),
					});
					const firstRecord = deserializeScidRecord(firstBuf, 0);
					firstRecordDateTime = firstRecord.dateTime;
					firstRecordIsoUtc = scDateTimeMSToIsoUtc(firstRecord.dateTime);

					// Read last record
					const lastOffset =
						SCID_HEADER_SIZE + (totalRecords - 1) * SCID_RECORD_SIZE;
					const lastBuf = Buffer.alloc(SCID_RECORD_SIZE);
					yield* Effect.tryPromise({
						try: () => handle.read(lastBuf, 0, SCID_RECORD_SIZE, lastOffset),
						catch: (e) =>
							new ScidReadCorruptedError({
								filePath,
								offset: lastOffset,
								reason: e instanceof Error ? e.message : String(e),
							}),
					});
					const lastRecord = deserializeScidRecord(lastBuf, 0);
					lastRecordDateTime = lastRecord.dateTime;
					lastRecordIsoUtc = scDateTimeMSToIsoUtc(lastRecord.dateTime);
				}

				return {
					header,
					totalRecords,
					fileSize: stat.size,
					firstRecordDateTime,
					lastRecordDateTime,
					firstRecordIsoUtc,
					lastRecordIsoUtc,
				};
			}),
		),

	readSlice: (filePath: string, offsetIndex: number, limit: number) =>
		withFileHandle(filePath, (handle) =>
			Effect.gen(function* () {
				yield* readHeaderInternal(handle, filePath);
				const stat = yield* Effect.tryPromise({
					try: () => handle.stat(),
					catch: (e) =>
						new ScidReadCorruptedError({
							filePath,
							offset: 0,
							reason: e instanceof Error ? e.message : String(e),
						}),
				});

				const totalRecords = Math.max(
					0,
					Math.floor((stat.size - SCID_HEADER_SIZE) / SCID_RECORD_SIZE),
				);

				if (offsetIndex < 0 || offsetIndex >= totalRecords || limit <= 0) {
					return [];
				}

				const actualCount = Math.min(limit, totalRecords - offsetIndex);
				const byteOffset = SCID_HEADER_SIZE + offsetIndex * SCID_RECORD_SIZE;
				const byteLength = actualCount * SCID_RECORD_SIZE;
				const buf = Buffer.alloc(byteLength);

				const { bytesRead } = yield* Effect.tryPromise({
					try: () => handle.read(buf, 0, byteLength, byteOffset),
					catch: (e) =>
						new ScidReadCorruptedError({
							filePath,
							offset: byteOffset,
							reason: e instanceof Error ? e.message : String(e),
						}),
				});

				if (bytesRead < byteLength) {
					yield* Effect.fail(
						new ScidReadCorruptedError({
							filePath,
							offset: byteOffset,
							reason: `Expected ${byteLength} bytes for ${actualCount} records, got ${bytesRead}`,
						}),
					);
				}

				const records: FormattedScidRecord[] = [];
				for (let i = 0; i < actualCount; i++) {
					const recordOffset = i * SCID_RECORD_SIZE;
					const rawRecord: ScidRecord = deserializeScidRecord(
						buf,
						recordOffset,
					);
					const currentIndex = offsetIndex + i;
					records.push({
						index: currentIndex,
						dateTimeRaw: rawRecord.dateTime,
						isoUtc: scDateTimeMSToIsoUtc(rawRecord.dateTime),
						localFormatted: scDateTimeMSToLocal(rawRecord.dateTime),
						open: rawRecord.open,
						high: rawRecord.high,
						low: rawRecord.low,
						close: rawRecord.close,
						numTrades: rawRecord.numTrades,
						totalVolume: rawRecord.totalVolume,
						bidVolume: rawRecord.bidVolume,
						askVolume: rawRecord.askVolume,
						side: determineAggressorSide(
							rawRecord.bidVolume,
							rawRecord.askVolume,
						),
					});
				}

				return records;
			}),
		),
});

export const ScidReaderLive: Layer.Layer<ScidReader> = Layer.succeed(
	ScidReader,
	ScidReader.of(makeScidReader()),
);
