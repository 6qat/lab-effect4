import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	Context,
	type Duration,
	Effect,
	Layer,
	Option,
	type Scope,
	Semaphore,
} from "effect";
import {
	cedroTimeToScDateTimeMS,
	parseCedroTradeLine,
	SCID_HEADER_SIZE,
	SCID_RECORD_SIZE,
	type ScidRecord,
	tradeToScidRecord,
	writeOrAppendScidFile,
} from "./scid-format.js";

export type ScidPartitionMode = "monolithic" | "daily";

export interface CedroScidSinkOptions {
	/** Base directory where .scid files are stored */
	readonly baseDir: string;
	/** Session date formatted as "YYYY-MM-DD". Defaults to current UTC date. */
	readonly sessionDate?: string;
	/** Dynamic date resolver function. Used if sessionDate is omitted or to detect date rollovers. */
	readonly getCurrentDate?: () => string;
	/** Number of records to buffer before triggering an immediate disk flush. Defaults to 50. */
	readonly batchSize?: number;
	/** Periodic background flush interval. Defaults to "500 millis". */
	readonly flushInterval?: Duration.Input;
	/** Partitioning strategy: "monolithic" (<ticker>.scid) or "daily" (<ticker>/<ticker>-<date>.scid). Defaults to "monolithic". */
	readonly partitionMode?: ScidPartitionMode;
	/** Optional custom path resolver function. */
	readonly resolveFilePath?: (ticker: string, sessionDate?: string) => string;
}

export interface CedroScidSinkShape {
	/**
	 * Ingests a raw line from Cedro. If the line is a trade ("V:<ticker>:A:..."),
	 * it is parsed, buffered, and flushed if batchSize is reached.
	 * Non-trade lines and deletion messages are cleanly ignored.
	 */
	readonly writeLine: (line: string) => Effect.Effect<void, never>;

	/**
	 * Manually flushes all currently buffered records across all tickers to disk.
	 */
	readonly flush: () => Effect.Effect<void, never>;

	/**
	 * Manually triggers a session date rollover:
	 * flushes existing records, rotates active file paths in daily mode,
	 * and initializes fresh 56-byte SCID headers for subsequent writes.
	 */
	readonly rotateDate: (newDate: string) => Effect.Effect<void, never>;

	/**
	 * Returns the currently active session date (YYYY-MM-DD).
	 */
	readonly getCurrentDate: () => string;
}

export class CedroScidSink extends Context.Service<
	CedroScidSink,
	CedroScidSinkShape
>()("CedroScidSink") {}

/**
 * Reads the last record's dateTime (SCDateTimeMS) from an existing SCID file.
 * Returns undefined if the file does not exist, is empty, or has no complete records.
 */
export const getLastTimestampFromFile = async (
	filePath: string,
): Promise<bigint | undefined> => {
	try {
		const stat = await fs.stat(filePath);
		const recordCount = Math.floor(
			(stat.size - SCID_HEADER_SIZE) / SCID_RECORD_SIZE,
		);
		if (recordCount > 0) {
			const fd = await fs.open(filePath, "r");
			try {
				const buf = Buffer.alloc(8);
				const offset = SCID_HEADER_SIZE + (recordCount - 1) * SCID_RECORD_SIZE;
				await fd.read(buf, 0, 8, offset);
				return buf.readBigInt64LE(0);
			} finally {
				await fd.close();
			}
		}
	} catch {
		// File does not exist or cannot be read
	}
	return undefined;
};

export const defaultResolveFilePath = (
	baseDir: string,
	partitionMode: ScidPartitionMode,
	ticker: string,
	sessionDate?: string,
): string => {
	if (partitionMode === "daily") {
		const dateStr = sessionDate ?? new Date().toISOString().slice(0, 10);
		return path.join(baseDir, ticker, `${ticker}-${dateStr}.scid`);
	}
	return path.join(baseDir, `${ticker}.scid`);
};

interface TickerState {
	filePath: string;
	currentDate: string;
	lastTimestamp?: bigint | undefined;
	buffer: ScidRecord[];
}

/**
 * Creates a scoped CedroScidSink service instance.
 * Manages multi-ticker routing, batching, periodic flushing, date rollover, and scoped teardown.
 */
export const makeCedroScidSink = (
	options: CedroScidSinkOptions,
): Effect.Effect<CedroScidSinkShape, never, Scope.Scope> =>
	Effect.gen(function* () {
		const baseDir = options.baseDir;
		const partitionMode = options.partitionMode ?? "monolithic";
		const batchSize = options.batchSize ?? 50;
		const flushInterval = options.flushInterval ?? "500 millis";

		let activeDate =
			options.sessionDate ??
			options.getCurrentDate?.() ??
			new Date().toISOString().slice(0, 10);

		const resolvePath =
			options.resolveFilePath ??
			((ticker: string, sDate?: string) =>
				defaultResolveFilePath(baseDir, partitionMode, ticker, sDate));

		const tickers = new Map<string, TickerState>();
		const sem = yield* Semaphore.make(1);

		const flushTickerInternal = (
			state: TickerState,
		): Effect.Effect<void, never> =>
			Effect.gen(function* () {
				if (state.buffer.length === 0) return;
				const recordsToFlush = [...state.buffer];
				state.buffer = [];

				yield* Effect.promise(() =>
					writeOrAppendScidFile(state.filePath, recordsToFlush),
				).pipe(
					Effect.catch((err) =>
						Effect.sync(() => {
							state.buffer.unshift(...recordsToFlush);
							console.error(
								`[CedroScidSink] Failed to flush records to ${state.filePath}:`,
								err,
							);
						}),
					),
					Effect.uninterruptible,
				);
			});

		const flushAllInternal = Effect.gen(function* () {
			for (const state of tickers.values()) {
				yield* flushTickerInternal(state);
			}
		});

		const flush = (): Effect.Effect<void, never> =>
			sem.withPermit(flushAllInternal).pipe(Effect.uninterruptible);

		const rotateDate = (newDate: string): Effect.Effect<void, never> =>
			sem
				.withPermit(
					Effect.gen(function* () {
						activeDate = newDate;
						if (partitionMode === "daily") {
							for (const [ticker, state] of tickers.entries()) {
								if (state.currentDate !== newDate) {
									yield* flushTickerInternal(state);
									const newFilePath = resolvePath(ticker, newDate);
									state.filePath = newFilePath;
									state.currentDate = newDate;
									state.lastTimestamp = yield* Effect.promise(() =>
										getLastTimestampFromFile(newFilePath),
									);
								}
							}
						} else {
							// In monolithic mode, flush existing records and keep appending
							yield* flushAllInternal;
						}
					}),
				)
				.pipe(Effect.uninterruptible);

		const getCurrentDate = (): string =>
			options.getCurrentDate?.() ?? activeDate;

		const writeLine = (line: string): Effect.Effect<void, never> =>
			Effect.gen(function* () {
				const opt = parseCedroTradeLine(line);
				if (Option.isNone(opt)) {
					return;
				}
				const trade = opt.value;

				yield* sem.withPermit(
					Effect.gen(function* () {
						const currentDate = getCurrentDate();
						const existingState = tickers.get(trade.ticker);
						let state: TickerState;

						if (existingState) {
							state = existingState;
							if (
								partitionMode === "daily" &&
								state.currentDate !== currentDate
							) {
								// Date rollover detected: flush previous day's buffer and rotate path
								yield* flushTickerInternal(state);
								const newFilePath = resolvePath(trade.ticker, currentDate);
								state.filePath = newFilePath;
								state.currentDate = currentDate;
								state.lastTimestamp = yield* Effect.promise(() =>
									getLastTimestampFromFile(newFilePath),
								);
							}
						} else {
							const filePath = resolvePath(trade.ticker, currentDate);
							const lastTimestamp = yield* Effect.promise(() =>
								getLastTimestampFromFile(filePath),
							);
							state = {
								filePath,
								currentDate,
								lastTimestamp,
								buffer: [],
							};
							tickers.set(trade.ticker, state);
						}

						const scDateTime = cedroTimeToScDateTimeMS(
							trade.timeStr,
							state.currentDate,
							state.lastTimestamp,
						);
						state.lastTimestamp = scDateTime;
						const record = tradeToScidRecord(trade, scDateTime);
						state.buffer.push(record);

						if (state.buffer.length >= batchSize) {
							yield* flushTickerInternal(state);
						}
					}),
				);
			});

		// 1. Register finalizer on scope to flush all remaining records on exit or interruption
		yield* Effect.addFinalizer(() => flush());

		// 2. Fork periodic flush fiber in scope
		yield* Effect.forkScoped(
			Effect.gen(function* () {
				while (true) {
					yield* Effect.sleep(flushInterval);
					yield* flush();
				}
			}),
		);

		return {
			writeLine,
			flush,
			rotateDate,
			getCurrentDate,
		};
	});

export const CedroScidSinkLive = (
	options: CedroScidSinkOptions,
): Layer.Layer<CedroScidSink> =>
	Layer.effect(CedroScidSink, makeCedroScidSink(options));
