import { describe, expect, it } from "bun:test";
import {
	formatTradeCountBadge,
	groupFilesByTicker,
	type ParsedScidFile,
	parseScidFileInfo,
} from "./tree-model.js";

describe("SCID Explorer Tree View Model", () => {
	describe("Filename Parsing (parseScidFileInfo)", () => {
		it("parses ticker and date session from standard daily partitioned file", () => {
			const parsed = parseScidFileInfo(
				"/workspace/data/WINV26-2026-10-06.scid",
			);

			expect(parsed.fileName).toBe("WINV26-2026-10-06.scid");
			expect(parsed.ticker).toBe("WINV26");
			expect(parsed.session).toBe("2026-10-06");
			expect(parsed.fsPath).toBe("/workspace/data/WINV26-2026-10-06.scid");
		});

		it("parses ticker and date session separated by underscore", () => {
			const parsed = parseScidFileInfo("/workspace/data/PETR4_2026-10-05.scid");

			expect(parsed.fileName).toBe("PETR4_2026-10-05.scid");
			expect(parsed.ticker).toBe("PETR4");
			expect(parsed.session).toBe("2026-10-05");
		});

		it("parses monolithic continuous file without session date", () => {
			const parsed = parseScidFileInfo("/workspace/data/WDOU26.scid");

			expect(parsed.fileName).toBe("WDOU26.scid");
			expect(parsed.ticker).toBe("WDOU26");
			expect(parsed.session).toBe("Continuous");
		});

		it("handles irregular filenames gracefully with fallback", () => {
			const parsed = parseScidFileInfo(
				"/workspace/data/custom_sample_tick.scid",
			);

			expect(parsed.fileName).toBe("custom_sample_tick.scid");
			expect(parsed.ticker).toBe("OTHER");
			expect(parsed.session).toBe("custom_sample_tick");
		});
	});

	describe("File Grouping by Ticker (groupFilesByTicker)", () => {
		it("groups multiple files by ticker and sorts sessions descending", () => {
			const files: ParsedScidFile[] = [
				{
					fsPath: "/data/WINV26-2026-10-05.scid",
					fileName: "WINV26-2026-10-05.scid",
					ticker: "WINV26",
					session: "2026-10-05",
				},
				{
					fsPath: "/data/PETR4-2026-10-06.scid",
					fileName: "PETR4-2026-10-06.scid",
					ticker: "PETR4",
					session: "2026-10-06",
				},
				{
					fsPath: "/data/WINV26-2026-10-06.scid",
					fileName: "WINV26-2026-10-06.scid",
					ticker: "WINV26",
					session: "2026-10-06",
				},
			];

			const grouped = groupFilesByTicker(files);
			expect(grouped.size).toBe(2);
			expect(grouped.has("WINV26")).toBe(true);
			expect(grouped.has("PETR4")).toBe(true);

			const winFiles = grouped.get("WINV26") ?? [];
			expect(winFiles.length).toBe(2);
			// Sorted descending: latest date first
			expect(winFiles[0]?.session).toBe("2026-10-06");
			expect(winFiles[1]?.session).toBe("2026-10-05");

			const petrFiles = grouped.get("PETR4") ?? [];
			expect(petrFiles.length).toBe(1);
			expect(petrFiles[0]?.session).toBe("2026-10-06");
		});
	});

	describe("Badge Formatting (formatTradeCountBadge)", () => {
		it("formats numeric trade counts with locale commas", () => {
			expect(formatTradeCountBadge(124530)).toBe("124,530 trades");
			expect(formatTradeCountBadge(0)).toBe("0 trades");
			expect(formatTradeCountBadge(50)).toBe("50 trades");
		});

		it("handles undefined count gracefully", () => {
			expect(formatTradeCountBadge(undefined)).toBe("0 trades");
		});
	});
});
