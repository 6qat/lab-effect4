import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
import { ScidReader, ScidReaderLive } from "../reader/scid-reader.js";
import { renderSkeletonRows } from "./record-render.js";
import {
	CHUNK_SIZE,
	calculatePrefetchChunkIndices,
	calculateSpacerHeights,
	calculateVirtualScrollMetrics,
	FOLLOW_THRESHOLD_PX,
	formatUnreadPillText,
	handleFollowAppend,
	handleFollowScroll,
	indexToScrollTop,
	isScrolledToBottom,
	LruChunkCache,
	MAX_CACHED_CHUNKS,
	MAX_CONTAINER_HEIGHT,
	OVERSCAN_ROWS,
	PREFETCH_MARGIN,
	ROW_HEIGHT,
	resumeFollow,
	scrollTopToIndex,
} from "./virtual-scroll.js";
import { renderWebviewHtml } from "./webview-html.js";

describe("Virtual Scroll Engine", () => {
	describe("Virtual Scrolling & Coordinate Scaling Engine", () => {
		it("defines default layout constants matching the specification", () => {
			expect(ROW_HEIGHT).toBe(28);
			expect(MAX_CONTAINER_HEIGHT).toBe(5_000_000);
			expect(OVERSCAN_ROWS).toBe(15);
		});

		it("calculates unscaled virtual height for normal files under 5M px", () => {
			const metrics = calculateVirtualScrollMetrics(
				1000,
				ROW_HEIGHT,
				MAX_CONTAINER_HEIGHT,
			);
			expect(metrics.totalVirtualHeight).toBe(28000);
			expect(metrics.isScaled).toBe(false);
			expect(metrics.scaleRatio).toBe(1);
		});

		it("caps virtual height at 5M px and calculates scaling ratio for massive files (5M+ rows)", () => {
			const totalRecords = 5_166_909;
			const metrics = calculateVirtualScrollMetrics(
				totalRecords,
				ROW_HEIGHT,
				MAX_CONTAINER_HEIGHT,
			);
			expect(metrics.totalVirtualHeight).toBe(MAX_CONTAINER_HEIGHT);
			expect(metrics.isScaled).toBe(true);
			expect(metrics.scaleRatio).toBeCloseTo(
				MAX_CONTAINER_HEIGHT / (totalRecords * ROW_HEIGHT),
				5,
			);
		});

		it("maps scrollTop to continuous record indices accurately without scaling", () => {
			const viewportHeight = 560; // 20 visible rows
			const totalRecords = 1000;
			expect(scrollTopToIndex(0, viewportHeight, totalRecords)).toBe(0);
			expect(scrollTopToIndex(280, viewportHeight, totalRecords)).toBe(10);
			const maxScroll = 1000 * ROW_HEIGHT - viewportHeight;
			expect(scrollTopToIndex(maxScroll, viewportHeight, totalRecords)).toBe(
				1000 - 20,
			);
		});

		it("maps scrollTop to record indices with virtual ratio for scaled massive files", () => {
			const viewportHeight = 700; // 25 visible rows
			const totalRecords = 5_000_000;
			expect(scrollTopToIndex(0, viewportHeight, totalRecords)).toBe(0);
			const maxScroll = MAX_CONTAINER_HEIGHT - viewportHeight;
			// At half scroll, should map to approximately half total records
			const midIndex = scrollTopToIndex(
				maxScroll / 2,
				viewportHeight,
				totalRecords,
			);
			expect(midIndex).toBeGreaterThan(2_400_000);
			expect(midIndex).toBeLessThan(2_600_000);
			// At max scroll, maps to end
			expect(scrollTopToIndex(maxScroll, viewportHeight, totalRecords)).toBe(
				totalRecords - 25,
			);
		});

		it("maps index to scrollTop bidirectionally", () => {
			const viewportHeight = 560;
			const totalRecords = 1000;
			const scroll = indexToScrollTop(100, viewportHeight, totalRecords);
			expect(scroll).toBe(100 * ROW_HEIGHT);
			expect(scrollTopToIndex(scroll, viewportHeight, totalRecords)).toBe(100);
		});

		it("calculates top and bottom spacer heights correctly", () => {
			const totalRecords = 1000;
			const startIndex = 100;
			const renderedCount = 50;
			const spacers = calculateSpacerHeights(
				startIndex,
				renderedCount,
				totalRecords,
			);
			expect(spacers.topSpacerHeight).toBe(100 * ROW_HEIGHT);
			expect(spacers.bottomSpacerHeight).toBe((1000 - 150) * ROW_HEIGHT);
		});

		it("renders skeleton placeholder rows for unloaded ranges", () => {
			const html = renderSkeletonRows(1000, 3);
			expect(html).toContain('col-index">#1,000</td>');
			expect(html).toContain('col-index">#1,001</td>');
			expect(html).toContain('col-index">#1,002</td>');
			expect(html).toContain("skeleton-cell");
		});

		it("streamlines toolbar by including Top and Tail buttons and excluding page buttons", () => {
			const html = renderWebviewHtml(
				"test.scid",
				undefined,
				"vscode-resource://dist/webview.js",
			);
			expect(html).toContain('id="btnTop"');
			expect(html).toContain('id="btnTail"');
			expect(html).not.toContain('id="btnFirst"');
			expect(html).not.toContain('id="btnPrev"');
			expect(html).not.toContain('id="btnNext"');
			expect(html).not.toContain('id="btnLast"');
			expect(html).not.toContain('id="pageSizeSelect"');
		});
	});

	describe("LRU Chunk Cache & Scroll Prefetch Engine", () => {
		it("defines default cache and prefetch parameters", () => {
			expect(CHUNK_SIZE).toBe(500);
			expect(MAX_CACHED_CHUNKS).toBe(20);
			expect(PREFETCH_MARGIN).toBe(250);
		});

		it("stores and retrieves chunks by chunkIndex", () => {
			const cache = new LruChunkCache<string>(5, 10);
			cache.put(0, ["a", "b"]);
			expect(cache.has(0)).toBe(true);
			expect(cache.has(1)).toBe(false);
			expect(cache.get(0)).toEqual(["a", "b"]);
			expect(cache.size).toBe(1);
		});

		it("evicts least recently used chunk when capacity exceeds maxChunks", () => {
			const cache = new LruChunkCache<number>(3, 10);
			cache.put(0, [0]);
			cache.put(1, [1]);
			cache.put(2, [2]);
			expect(cache.size).toBe(3);

			// Access chunk 0 to make it most recently used (order becomes: 1, 2, 0)
			expect(cache.get(0)).toEqual([0]);

			// Insert chunk 3 -> should evict chunk 1
			cache.put(3, [3]);
			expect(cache.size).toBe(3);
			expect(cache.has(1)).toBe(false);
			expect(cache.has(0)).toBe(true);
			expect(cache.has(2)).toBe(true);
			expect(cache.has(3)).toBe(true);
		});

		it("retrieves individual records by global record index", () => {
			const cache = new LruChunkCache<string>(5, 100);
			cache.put(
				0,
				Array.from({ length: 100 }, (_, i) => `rec_${i}`),
			);
			cache.put(
				1,
				Array.from({ length: 100 }, (_, i) => `rec_${100 + i}`),
			);

			expect(cache.getRecord(5)).toBe("rec_5");
			expect(cache.getRecord(150)).toBe("rec_150");
			expect(cache.getRecord(250)).toBeUndefined();
		});

		it("retrieves sliced records and identifies missing chunk indices", () => {
			const cache = new LruChunkCache<number>(5, 10);
			cache.put(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			cache.put(2, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);

			const slice = cache.getSlice(5, 20); // records 5..24: chunk 0 (5..9), chunk 1 (10..19 missing), chunk 2 (20..24)
			expect(slice.missingChunkIndices).toEqual([1]);
			expect(slice.records.length).toBe(20);
			expect(slice.records[0]).toBe(5);
			expect(slice.records[4]).toBe(9);
			expect(slice.records[5]).toBeUndefined();
			expect(slice.records[14]).toBeUndefined();
			expect(slice.records[15]).toBe(20);
			expect(slice.records[19]).toBe(24);
		});

		it("populates multiple chunks cleanly across chunk boundaries using putRecords", () => {
			const cache = new LruChunkCache<{ index: number; val: string }>(10, 500);
			// 500 records starting at unaligned offset 52,249 through 52,748
			const records = Array.from({ length: 500 }, (_, i) => ({
				index: 52249 + i,
				val: `rec_${52249 + i}`,
			}));
			cache.putRecords(records);

			// Should have populated both Chunk 104 and Chunk 105
			expect(cache.has(104)).toBe(true);
			expect(cache.has(105)).toBe(true);

			// Chunk 104 covers 52,000..52,499. Record 52,249 should be at offset 249
			expect(cache.getRecord(52249)?.val).toBe("rec_52249");
			expect(cache.getRecord(52499)?.val).toBe("rec_52499");
			// Record 52,248 was NOT in the array -> undefined
			expect(cache.getRecord(52248)).toBeUndefined();

			// Chunk 105 covers 52,500..52,999. Record 52,500 should be at offset 0
			expect(cache.getRecord(52500)?.val).toBe("rec_52500");
			expect(cache.getRecord(52748)?.val).toBe("rec_52748");

			// Viewport slice at the tail (52,712 to 52,748 - 37 rows) must have 0 missing records
			const tailSlice = cache.getSlice(52712, 37);
			expect(tailSlice.missingChunkIndices).toEqual([]);
			expect(tailSlice.records.every((r) => r !== undefined)).toBe(true);
			expect(tailSlice.records.length).toBe(37);
		});

		it("correctly identifies chunk completeness using isComplete", () => {
			const cache = new LruChunkCache<{ index: number; val: string }>(10, 500);
			const totalRecords = 52749;

			// Put records 52,249 to 52,748
			const records = Array.from({ length: 500 }, (_, i) => ({
				index: 52249 + i,
				val: `rec_${52249 + i}`,
			}));
			cache.putRecords(records);

			// Chunk 104 has records 52,249..52,499 but lacks 52,000..52,248 -> incomplete
			expect(cache.isComplete(104, totalRecords)).toBe(false);

			// Chunk 105 covers 52,500..52,999, but totalRecords is 52,749.
			// Records 52,500..52,748 all exist -> complete!
			expect(cache.isComplete(105, totalRecords)).toBe(true);

			// Uncached chunk 100 -> incomplete
			expect(cache.isComplete(100, totalRecords)).toBe(false);
		});

		it("calculates forward prefetch chunks when within 250 records of forward boundary", () => {
			// Window [300, 349] within total 10,000 records. Forward +250 is 599 -> chunk 1
			const result = calculatePrefetchChunkIndices(300, 50, 10000, 500, 250);
			expect(result.visibleChunkIndices).toEqual([0]);
			expect(result.prefetchChunkIndices).toEqual([1]);
		});

		it("calculates backward prefetch chunks when within 250 records of backward boundary", () => {
			// Window [600, 649]. Backward -250 is 350 -> chunk 0
			const result = calculatePrefetchChunkIndices(600, 50, 10000, 500, 250);
			expect(result.visibleChunkIndices).toEqual([1]);
			expect(result.prefetchChunkIndices).toEqual([0]);
		});

		it("does not prefetch beyond file boundaries", () => {
			// At file start [0, 49]
			const startResult = calculatePrefetchChunkIndices(0, 50, 10000, 500, 250);
			expect(startResult.visibleChunkIndices).toEqual([0]);
			expect(startResult.prefetchChunkIndices).toEqual([]);

			// At file end [9950, 9999]
			const endResult = calculatePrefetchChunkIndices(
				9950,
				50,
				10000,
				500,
				250,
			);
			expect(endResult.visibleChunkIndices).toEqual([19]);
			expect(endResult.prefetchChunkIndices).toEqual([]);
		});

		it("clears cached chunks cleanly on clear()", () => {
			const cache = new LruChunkCache<number>(5, 10);
			cache.put(0, [1, 2, 3]);
			expect(cache.size).toBe(1);
			cache.clear();
			expect(cache.size).toBe(0);
			expect(cache.has(0)).toBe(false);
		});
	});

	describe("Smart Live Tail Follow Mode & Floating Pill", () => {
		it("defines default follow threshold matching 50px", () => {
			expect(FOLLOW_THRESHOLD_PX).toBe(50);
		});

		it("detects whether viewport is scrolled to bottom edge", () => {
			const viewportHeight = 500;
			const totalVirtualHeight = 1500; // maxScroll = 1000

			// Exactly at bottom
			expect(
				isScrolledToBottom(1000, viewportHeight, totalVirtualHeight, 50),
			).toBe(true);

			// Within 50px threshold (at 960px -> 40px away)
			expect(
				isScrolledToBottom(960, viewportHeight, totalVirtualHeight, 50),
			).toBe(true);

			// Scrolled up beyond 50px threshold (at 940px -> 60px away)
			expect(
				isScrolledToBottom(940, viewportHeight, totalVirtualHeight, 50),
			).toBe(false);
		});

		it("detaches follow mode when user scrolls up >50px away without turning Live Tail OFF", () => {
			const initialState = {
				liveTail: true,
				isFollowing: true,
				unreadCount: 0,
			};
			const nextState = handleFollowScroll(
				initialState,
				900, // 100px away from bottom
				500,
				1500,
				50,
			);

			expect(nextState.liveTail).toBe(true);
			expect(nextState.isFollowing).toBe(false);
			expect(nextState.unreadCount).toBe(0);
		});

		it("re-engages follow mode when user scrolls back down within 50px of bottom and clears unread count", () => {
			const detachedState = {
				liveTail: true,
				isFollowing: false,
				unreadCount: 25,
			};
			const nextState = handleFollowScroll(
				detachedState,
				980, // 20px away from bottom
				500,
				1500,
				50,
			);

			expect(nextState.liveTail).toBe(true);
			expect(nextState.isFollowing).toBe(true);
			expect(nextState.unreadCount).toBe(0);
		});

		it("accumulates unread count and suppresses snap-to-bottom on APPEND_RECORDS when detached", () => {
			const detachedState = {
				liveTail: true,
				isFollowing: false,
				unreadCount: 5,
			};
			const result = handleFollowAppend(detachedState, 15);

			expect(result.shouldSnapToBottom).toBe(false);
			expect(result.nextState.liveTail).toBe(true);
			expect(result.nextState.isFollowing).toBe(false);
			expect(result.nextState.unreadCount).toBe(20);
		});

		it("snaps to bottom and keeps unread count 0 on APPEND_RECORDS when actively following", () => {
			const followingState = {
				liveTail: true,
				isFollowing: true,
				unreadCount: 0,
			};
			const result = handleFollowAppend(followingState, 15);

			expect(result.shouldSnapToBottom).toBe(true);
			expect(result.nextState.liveTail).toBe(true);
			expect(result.nextState.isFollowing).toBe(true);
			expect(result.nextState.unreadCount).toBe(0);
		});

		it("resumes follow mode and clears unread count on resumeFollow()", () => {
			const detachedState = {
				liveTail: true,
				isFollowing: false,
				unreadCount: 42,
			};
			const resumed = resumeFollow(detachedState);

			expect(resumed.liveTail).toBe(true);
			expect(resumed.isFollowing).toBe(true);
			expect(resumed.unreadCount).toBe(0);
		});

		it("formats floating pill badge text correctly", () => {
			expect(formatUnreadPillText(1240)).toBe(
				"↓ 1,240 new trades — Resume Live Tail",
			);
			expect(formatUnreadPillText(1)).toBe("↓ 1 new trades — Resume Live Tail");
		});

		it("renders floating follow pill in webview HTML markup and defaults Live Tail to OFF", () => {
			const html = renderWebviewHtml(
				"test.scid",
				undefined,
				"vscode-resource://dist/webview.js",
			);
			expect(html).toContain('id="floatingFollowPill"');
			expect(html).toContain('id="pillText"');
			expect(html).toContain("Live Tail: OFF");
		});
	});

	describe("Instant Teleportation & Jump Navigation", () => {
		it("snaps to index 0 on Top navigation", () => {
			const totalRecords = 5_166_909;
			const viewportHeight = 600;
			const targetScroll = indexToScrollTop(0, viewportHeight, totalRecords);
			expect(targetScroll).toBe(0);
			expect(scrollTopToIndex(targetScroll, viewportHeight, totalRecords)).toBe(
				0,
			);
		});

		it("snaps to maximum scroll offset on Tail navigation", () => {
			const totalRecords = 5_166_909;
			const viewportHeight = 600;
			const metrics = calculateVirtualScrollMetrics(totalRecords);
			const maxScrollTop = Math.max(
				0,
				metrics.totalVirtualHeight - viewportHeight,
			);
			const targetIndex = scrollTopToIndex(
				maxScrollTop,
				viewportHeight,
				totalRecords,
			);
			const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
			expect(targetIndex).toBe(totalRecords - visibleRows);
		});

		it("teleports to arbitrary jump indices with coordinate clamping", () => {
			const totalRecords = 5_166_909;
			const viewportHeight = 600;

			// Negative target clamps to 0
			expect(indexToScrollTop(-100, viewportHeight, totalRecords)).toBe(0);

			// Target beyond total records clamps to max index
			const maxScrollTop =
				calculateVirtualScrollMetrics(totalRecords).totalVirtualHeight -
				viewportHeight;
			expect(indexToScrollTop(10_000_000, viewportHeight, totalRecords)).toBe(
				maxScrollTop,
			);

			// Middle jump (e.g. index 2,500,000) calculates scaled offset
			const midScroll = indexToScrollTop(
				2_500_000,
				viewportHeight,
				totalRecords,
			);
			expect(midScroll).toBeGreaterThan(0);
			expect(midScroll).toBeLessThan(maxScrollTop);
			const roundTripIndex = scrollTopToIndex(
				midScroll,
				viewportHeight,
				totalRecords,
			);
			expect(Math.abs(roundTripIndex - 2_500_000)).toBeLessThan(5);
		});
	});

	describe("5M+ Real SCID Fixture Verification (WINV26-2026-10-06.scid)", () => {
		const fixturePath = path.resolve(
			process.cwd(),
			"data/scid/WINV26/WINV26-2026-10-06.scid",
		);
		const fixtureExists = fs.existsSync(fixturePath);

		it("loads 5M+ fixture summary in under 500ms", async () => {
			if (!fixtureExists) return;

			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				const t0 = performance.now();
				const summary = yield* reader.getSummary(fixturePath);
				const duration = performance.now() - t0;

				expect(duration).toBeLessThan(500);
				expect(summary.totalRecords).toBeGreaterThan(5_000_000);
				expect(summary.fileSize).toBeGreaterThan(200_000_000);
				expect(summary.header.fileType).toBe("SCID");
				expect(summary.firstRecordIsoUtc).toContain("2026-10-06");
				expect(summary.lastRecordIsoUtc).toContain("2026-10-06");
			}).pipe(Effect.provide(ScidReaderLive));

			await Effect.runPromise(program);
		});

		it("verifies virtual metrics and coordinate scaling for 5M+ records", async () => {
			if (!fixtureExists) return;

			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				const summary = yield* reader.getSummary(fixturePath);
				const metrics = calculateVirtualScrollMetrics(summary.totalRecords);

				expect(metrics.isScaled).toBe(true);
				expect(metrics.totalVirtualHeight).toBe(MAX_CONTAINER_HEIGHT);
				expect(metrics.scaleRatio).toBeLessThan(1);
			}).pipe(Effect.provide(ScidReaderLive));

			await Effect.runPromise(program);
		});

		it("executes random seeks to head, middle (2.5M), and tail instantaneously", async () => {
			if (!fixtureExists) return;

			const program = Effect.gen(function* () {
				const reader = yield* ScidReader;
				const summary = yield* reader.getSummary(fixturePath);

				// Head slice
				const t0 = performance.now();
				const headSlice = (yield* reader.readSlice(fixturePath, 0, 50)).records;
				const headDur = performance.now() - t0;
				expect(headDur).toBeLessThan(1000);
				expect(headSlice.length).toBe(50);
				expect(headSlice[0]?.index).toBe(0);

				// Middle slice
				const midIdx = Math.floor(summary.totalRecords / 2);
				const t1 = performance.now();
				const midSlice = (yield* reader.readSlice(fixturePath, midIdx, 50))
					.records;
				const midDur = performance.now() - t1;
				expect(midDur).toBeLessThan(1000);
				expect(midSlice.length).toBe(50);
				expect(midSlice[0]?.index).toBe(midIdx);

				// Tail slice
				const tailIdx = summary.totalRecords - 50;
				const t2 = performance.now();
				const { records: tailSlice } = yield* reader.readSlice(
					fixturePath,
					tailIdx,
					50,
				);
				const tailDur = performance.now() - t2;
				expect(tailDur).toBeLessThan(1000);
				expect(tailSlice.length).toBe(50);
				expect(tailSlice[tailSlice.length - 1]?.index).toBe(
					summary.totalRecords - 1,
				);
			}).pipe(Effect.provide(ScidReaderLive));

			await Effect.runPromise(program);
		});
	});
});
