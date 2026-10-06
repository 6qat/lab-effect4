import { describe, expect, it } from "bun:test";
import type { FormattedScidRecord } from "../reader/scid-reader.js";
import type {
	AppendRecordsMessage,
	InitMessage,
	PageDataMessage,
	RequestPageMessage,
	ToggleLiveTailMessage,
} from "./protocol.js";
import {
	CHUNK_SIZE,
	calculatePrefetchChunkIndices,
	calculateSpacerHeights,
	calculateVirtualScrollMetrics,
	escapeHtml,
	formatFileSize,
	indexToScrollTop,
	LruChunkCache,
	MAX_CACHED_CHUNKS,
	MAX_CONTAINER_HEIGHT,
	OVERSCAN_ROWS,
	PREFETCH_MARGIN,
	ROW_HEIGHT,
	renderSkeletonRows,
	renderTableRows,
	renderWebviewHtml,
	scrollTopToIndex,
} from "./webview-html.js";

describe("Webview HTML & Messaging Protocol", () => {
	describe("String & Number Formatting Helpers", () => {
		it("escapes HTML special characters", () => {
			expect(escapeHtml("<script>alert('xss')&\"test\"</script>")).toBe(
				"&lt;script&gt;alert(&#039;xss&#039;)&amp;&quot;test&quot;&lt;/script&gt;",
			);
		});

		it("formats file size in human-readable units", () => {
			expect(formatFileSize(56)).toBe("56 B");
			expect(formatFileSize(1024)).toBe("1.0 KB");
			expect(formatFileSize(1024 * 512)).toBe("512.0 KB");
			expect(formatFileSize(1024 * 1024 * 4.5)).toBe("4.50 MB");
			expect(formatFileSize(1024 * 1024 * 1024 * 2.1)).toBe("2.10 GB");
		});
	});

	describe("Table Rows Rendering", () => {
		it("renders empty state placeholder when records array is empty", () => {
			const html = renderTableRows([]);
			expect(html).toContain("No records available");
			expect(html).toContain('colspan="7"');
		});

		it("renders formatted records with color-coded side badges", () => {
			const records: FormattedScidRecord[] = [
				{
					index: 0,
					dateTimeRaw: 1000n,
					isoUtc: "2026-10-06T12:00:00.000000Z",
					localFormatted: "2026-10-06 09:00:00.000000",
					open: 125430,
					high: 125430,
					low: 125430,
					close: 125430,
					price: 125430,
					numTrades: 1,
					totalVolume: 50,
					bidVolume: 0,
					askVolume: 50,
					side: "BUY",
				},
				{
					index: 1,
					dateTimeRaw: 2000n,
					isoUtc: "2026-10-06T12:00:01.000000Z",
					localFormatted: "2026-10-06 09:00:01.000000",
					open: 125425,
					high: 125425,
					low: 125425,
					close: 125425,
					price: 125425,
					numTrades: 1,
					totalVolume: 25,
					bidVolume: 25,
					askVolume: 0,
					side: "SELL",
				},
				{
					index: 2,
					dateTimeRaw: 3000n,
					isoUtc: "2026-10-06T12:00:02.000000Z",
					localFormatted: "2026-10-06 09:00:02.000000",
					open: 125425,
					high: 125425,
					low: 125425,
					close: 125425,
					price: 125425,
					numTrades: 1,
					totalVolume: 10,
					bidVolume: 0,
					askVolume: 0,
					side: "NEUTRAL",
				},
			];

			const html = renderTableRows(records);
			expect(html).toContain("col-index");
			expect(html).toContain("125430.00");
			expect(html).toContain("badge badge-buy");
			expect(html).toContain("badge badge-sell");
			expect(html).toContain("badge badge-neutral");
			expect(html).toContain("BUY");
			expect(html).toContain("SELL");
			expect(html).toContain("NEUTRAL");
		});
	});

	describe("Full Webview HTML Generation", () => {
		it("generates full HTML with summary card and navigation toolbar", () => {
			const initMessage: InitMessage = {
				type: "INIT",
				fileName: "WINV26-2026-10-06.scid",
				summary: {
					fileType: "SCID",
					headerSize: 56,
					recordSize: 40,
					version: 1,
					totalRecords: 124530,
					fileSize: 56 + 124530 * 40,
					firstRecordIsoUtc: "2026-10-06T12:00:00.000000Z",
					lastRecordIsoUtc: "2026-10-06T20:55:00.000000Z",
				},
				offsetIndex: 124030,
				pageSize: 500,
				records: [],
			};

			const html = renderWebviewHtml("WINV26-2026-10-06.scid", initMessage);

			expect(html).toContain("<!DOCTYPE html>");
			expect(html).toContain("WINV26-2026-10-06.scid");
			expect(html).toContain("124,530");
			expect(html).toContain("SCID Binary");
			expect(html).toContain("First Trade");
			expect(html).toContain("Last Trade");
			expect(html).toContain("btnTop");
			expect(html).toContain("btnTail");
			expect(html).toContain("jumpIndexInput");
			expect(html).toContain("acquireVsCodeApi()");
			expect(html).toContain("REQUEST_PAGE");
			expect(html).toContain("PAGE_DATA");
			expect(html).toContain("APPEND_RECORDS");
			expect(html).toContain("TOGGLE_LIVE_TAIL");
			expect(html).toContain("btnLiveTail");
			expect(html).toContain("btnToggleTime");
			expect(html).toContain("filterMinVol");
			expect(html).toContain("filterPrice");
			expect(html).toContain("btnClearFilters");
			expect(html).toContain("thTime");
		});
	});

	describe("Time Mode Switching", () => {
		const sampleRecord: FormattedScidRecord = {
			index: 0,
			dateTimeRaw: 1000n,
			isoUtc: "2026-10-06T12:00:00.000000Z",
			localFormatted: "2026-10-06 09:00:00.000000",
			open: 125430,
			high: 125430,
			low: 125430,
			close: 125430,
			price: 125430,
			numTrades: 1,
			totalVolume: 50,
			bidVolume: 0,
			askVolume: 50,
			side: "BUY",
		};

		it("renders UTC timestamps when timeMode is UTC", () => {
			const html = renderTableRows([sampleRecord], "UTC");
			expect(html).toContain("2026-10-06T12:00:00.000000Z");
			expect(html).not.toContain("2026-10-06 09:00:00.000000");
		});

		it("renders local timestamps when timeMode is LOCAL", () => {
			const html = renderTableRows([sampleRecord], "LOCAL");
			expect(html).toContain("2026-10-06 09:00:00.000000");
			expect(html).not.toContain("2026-10-06T12:00:00.000000Z");
		});
	});

	describe("IPC Protocol Typing", () => {
		it("validates protocol message payloads", () => {
			const req: RequestPageMessage = {
				type: "REQUEST_PAGE",
				offsetIndex: 500,
				pageSize: 250,
			};
			expect(req.type).toBe("REQUEST_PAGE");
			expect(req.offsetIndex).toBe(500);
			expect(req.pageSize).toBe(250);

			const pageData: PageDataMessage = {
				type: "PAGE_DATA",
				offsetIndex: 500,
				pageSize: 250,
				totalRecords: 10000,
				records: [],
			};
			expect(pageData.type).toBe("PAGE_DATA");
			expect(pageData.totalRecords).toBe(10000);

			const appendMsg: AppendRecordsMessage = {
				type: "APPEND_RECORDS",
				records: [],
				totalRecords: 10005,
				fileSize: 56 + 10005 * 40,
				lastRecordIsoUtc: "2026-10-06T12:00:05.000000Z",
			};
			expect(appendMsg.type).toBe("APPEND_RECORDS");
			expect(appendMsg.totalRecords).toBe(10005);
			expect(appendMsg.fileSize).toBe(400256);

			const toggleMsg: ToggleLiveTailMessage = {
				type: "TOGGLE_LIVE_TAIL",
				enabled: true,
			};
			expect(toggleMsg.type).toBe("TOGGLE_LIVE_TAIL");
			expect(toggleMsg.enabled).toBe(true);
		});
	});

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
			const html = renderWebviewHtml("test.scid");
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
});
