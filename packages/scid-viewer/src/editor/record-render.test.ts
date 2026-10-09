import { describe, expect, it } from "bun:test";
import type { FormattedScidRecord } from "../reader/scid-reader.js";
import {
	escapeHtml,
	formatFileSize,
	formatFilteredRangeIndicator,
	formatRangeIndicator,
	matchesRecordFilter,
	parsePriceFilter,
	renderTableRows,
} from "./record-render.js";

describe("Record Rendering & Formatting", () => {
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

	describe("Viewport Filtering Engine (Volume & Price)", () => {
		it("parses price filter expressions correctly", () => {
			expect(parsePriceFilter("125000")).toEqual({ op: "=", val: 125000 });
			expect(parsePriceFilter("  125000.50  ")).toEqual({
				op: "=",
				val: 125000.5,
			});
			expect(parsePriceFilter(">= 125000")).toEqual({
				op: ">=",
				val: 125000,
			});
			expect(parsePriceFilter("<=125000.25")).toEqual({
				op: "<=",
				val: 125000.25,
			});
			expect(parsePriceFilter("> 125000")).toEqual({ op: ">", val: 125000 });
			expect(parsePriceFilter("<125000")).toEqual({ op: "<", val: 125000 });
			expect(parsePriceFilter("= 125000")).toEqual({ op: "=", val: 125000 });

			expect(parsePriceFilter("")).toBeNull();
			expect(parsePriceFilter("   ")).toBeNull();
			expect(parsePriceFilter("invalid-price")).toBeNull();
		});

		it("evaluates min volume filtering against trade records", () => {
			const recLowVol = { totalVolume: 10, price: 125000 };
			const recHighVol = { totalVolume: 100, price: 125000 };

			expect(matchesRecordFilter(recLowVol, 50, null)).toBe(false);
			expect(matchesRecordFilter(recHighVol, 50, null)).toBe(true);
			expect(matchesRecordFilter(recLowVol, 0, null)).toBe(true);
		});

		it("evaluates price comparison operators correctly", () => {
			const rec = { totalVolume: 10, price: 125000 };

			expect(matchesRecordFilter(rec, 0, { op: "=", val: 125000 })).toBe(true);
			expect(matchesRecordFilter(rec, 0, { op: "=", val: 125005 })).toBe(false);

			expect(matchesRecordFilter(rec, 0, { op: ">=", val: 125000 })).toBe(true);
			expect(matchesRecordFilter(rec, 0, { op: ">=", val: 124995 })).toBe(true);
			expect(matchesRecordFilter(rec, 0, { op: ">=", val: 125005 })).toBe(
				false,
			);

			expect(matchesRecordFilter(rec, 0, { op: "<=", val: 125000 })).toBe(true);
			expect(matchesRecordFilter(rec, 0, { op: "<=", val: 125005 })).toBe(true);
			expect(matchesRecordFilter(rec, 0, { op: "<=", val: 124995 })).toBe(
				false,
			);

			expect(matchesRecordFilter(rec, 0, { op: ">", val: 124995 })).toBe(true);
			expect(matchesRecordFilter(rec, 0, { op: ">", val: 125000 })).toBe(false);

			expect(matchesRecordFilter(rec, 0, { op: "<", val: 125005 })).toBe(true);
			expect(matchesRecordFilter(rec, 0, { op: "<", val: 125000 })).toBe(false);
		});

		it("evaluates combined volume and price filtering", () => {
			const rec1 = { totalVolume: 10, price: 125000 };
			const rec2 = { totalVolume: 100, price: 125000 };
			const rec3 = { totalVolume: 100, price: 124000 };

			const filter = { op: ">=" as const, val: 125000 };
			expect(matchesRecordFilter(rec1, 50, filter)).toBe(false); // fails volume
			expect(matchesRecordFilter(rec2, 50, filter)).toBe(true); // passes both
			expect(matchesRecordFilter(rec3, 50, filter)).toBe(false); // fails price
		});

		it("formats filtered range indicator matching task specification", () => {
			expect(formatFilteredRangeIndicator(12, 40)).toBe(
				"Filtered: 12 matching of 40 visible in window",
			);
			expect(formatFilteredRangeIndicator(0, 0)).toBe(
				"Filtered: 0 matching of 0 visible in window",
			);
			expect(formatRangeIndicator(1, 40, 5166909)).toBe(
				"Showing 1 - 40 of 5,166,909",
			);
		});
	});
});
