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
	readonly filePath: string;
	lastTimestamp?: bigint | undefined;
	buffer: ScidRecord[];
}

/**
 * Creates a scoped CedroScidSink service instance.
 * Manages multi-ticker routing, batching, periodic flushing, and scoped teardown.
 */
export const makeCedroScidSink = (
	options: CedroScidSinkOptions,
): Effect.Effect<CedroScidSinkShape, never, Scope.Scope> =>
	Effect.gen(function* () {
		const baseDir = options.baseDir;
		const partitionMode = options.partitionMode ?? "monolithic";
		const batchSize = options.batchSize ?? 50;
		const flushInterval = options.flushInterval ?? "500 millis";
		const sessionDate = options.sessionDate;

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

		const writeLine = (line: string): Effect.Effect<void, never> =>
			Effect.gen(function* () {
				const opt = parseCedroTradeLine(line);
				if (Option.isNone(opt)) {
					return;
				}
				const trade = opt.value;

				yield* sem.withPermit(
					Effect.gen(function* () {
						const existingState = tickers.get(trade.ticker);
						let state: TickerState;
						if (existingState) {
							state = existingState;
						} else {
							const filePath = resolvePath(trade.ticker, sessionDate);
							const lastTimestamp = yield* Effect.promise(() =>
								getLastTimestampFromFile(filePath),
							);
							state = {
								filePath,
								lastTimestamp,
								buffer: [],
							};
							tickers.set(trade.ticker, state);
						}

						const scDateTime = cedroTimeToScDateTimeMS(
							trade.timeStr,
							sessionDate,
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
		};
	});

export const CedroScidSinkLive = (
	options: CedroScidSinkOptions,
): Layer.Layer<CedroScidSink> =>
	Layer.effect(CedroScidSink, makeCedroScidSink(options));
