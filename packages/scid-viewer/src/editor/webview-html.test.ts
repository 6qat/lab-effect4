import { describe, expect, it } from "bun:test";
import type {
	AppendRecordsMessage,
	InitMessage,
	PageDataMessage,
	RequestPageMessage,
	ToggleLiveTailMessage,
} from "./protocol.js";
import { calculateVirtualScrollMetrics, ROW_HEIGHT } from "./virtual-scroll.js";
import { renderWebviewHtml } from "./webview-html.js";

describe("Webview HTML & Messaging Protocol", () => {
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

			const html = renderWebviewHtml(
				"WINV26-2026-10-06.scid",
				initMessage,
				"vscode-resource://dist/webview.js",
			);

			expect(html).toContain("<!DOCTYPE html>");
			expect(html).toContain("WINV26-2026-10-06.scid");
			expect(html).toContain("124,530");
			expect(html).toContain("SCID Binary");
			expect(html).toContain("First Trade");
			expect(html).toContain("Last Trade");
			expect(html).toContain("btnTop");
			expect(html).toContain("btnTail");
			expect(html).toContain("jumpIndexInput");
			expect(html).toContain(
				'<script src="vscode-resource://dist/webview.js">',
			);
			expect(html).not.toContain("acquireVsCodeApi()");
			expect(html).not.toContain("REQUEST_PAGE");
			expect(html).not.toContain("PAGE_DATA");
			expect(html).not.toContain("APPEND_RECORDS");
			expect(html).not.toContain("TOGGLE_LIVE_TAIL");
			expect(html).toContain("btnLiveTail");
			expect(html).toContain("btnToggleTime");
			expect(html).toContain("filterMinVol");
			expect(html).toContain("filterPrice");
			expect(html).toContain("btnClearFilters");
			expect(html).toContain("thTime");
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

	describe("TanStack Virtual Dual-Bundle Architecture & CSP", () => {
		it("renders webview HTML with external scriptUri, initial data script, and strict CSP", () => {
			const initMessage: InitMessage = {
				type: "INIT",
				fileName: "WINV26-2026-10-06.scid",
				summary: {
					fileType: "SCID",
					headerSize: 56,
					recordSize: 40,
					version: 1,
					totalRecords: 50000,
					fileSize: 56 + 50000 * 40,
				},
				offsetIndex: 49500,
				pageSize: 500,
				records: [],
			};

			const scriptUri = "vscode-resource://dist/webview.js";
			const cspSource = "vscode-resource:";
			const html = renderWebviewHtml(
				"WINV26-2026-10-06.scid",
				initMessage,
				scriptUri,
				cspSource,
			);

			expect(html).toContain("content=\"default-src 'none';");
			expect(html).toContain('id="scid-initial-data"');
			expect(html).toContain(
				'<script src="vscode-resource://dist/webview.js">',
			);
			expect(html).toContain('class="scid-table" role="table"');
			expect(html).toContain('class="table-header-row" role="row"');
			expect(html).toContain('role="columnheader"');
			expect(html).toContain('id="spacerTop" class="spacer"');
			expect(html).toContain('id="spacerBottom" class="spacer"');
			expect(html).toContain("w.scrollTop = w.scrollHeight;");
			expect(html).not.toContain("acquireVsCodeApi()");
		});

		it("emits exactly one executable external script and no inline engine", () => {
			const scriptUri = "vscode-resource://dist/webview.js";
			const html = renderWebviewHtml(
				"WINV26-2026-10-06.scid",
				undefined,
				scriptUri,
			);

			const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
			const withSrc = scriptTags.filter((tag) => tag.includes("src="));
			// The only engine shipped is the external bundle.
			expect(withSrc).toHaveLength(1);
			expect(withSrc[0]).toContain(`src="${scriptUri}"`);

			// The lone remaining executable inline script is the pin-to-bottom bootstrap.
			const inlineExecutable = scriptTags.filter(
				(tag) =>
					!tag.includes("src=") && !tag.includes('type="application/json"'),
			);
			expect(inlineExecutable).toHaveLength(1);

			// No inline engine survived the deletion.
			expect(html).not.toContain("acquireVsCodeApi()");
			expect(html).not.toContain("WebviewChunkCache");
			expect(html).not.toContain("REQUEST_PAGE");
		});

		it("verifies TanStack Virtual lifecycle, scroll proxy, and coordinate downscaling", async () => {
			const { Virtualizer } = await import("@tanstack/virtual-core");
			const totalRecords = 6_681_289;
			const viewportHeight = 600;
			const metrics = calculateVirtualScrollMetrics(totalRecords);
			let domScrollTop = 0;

			const realDomEl = {
				clientWidth: 800,
				clientHeight: viewportHeight,
				get scrollHeight() {
					return metrics.totalVirtualHeight;
				},
				get scrollTop() {
					return domScrollTop;
				},
				set scrollTop(v: number) {
					domScrollTop = v;
				},
			};

			const proxyEl = new Proxy(realDomEl, {
				get(target, prop) {
					if (prop === "scrollHeight") {
						return totalRecords * ROW_HEIGHT;
					}
					const v = Reflect.get(target, prop, target);
					return typeof v === "function" ? v.bind(target) : v;
				},
			});

			const unscaledTailOffset = Math.max(
				0,
				totalRecords * ROW_HEIGHT - viewportHeight,
			);
			const maxDomScroll = Math.max(
				1,
				metrics.totalVirtualHeight - viewportHeight,
			);
			const maxUnscaledScroll = Math.max(
				1,
				totalRecords * ROW_HEIGHT - viewportHeight,
			);

			type OffsetCallback = (offset: number, isScrolling: boolean) => void;
			let registeredCallback: OffsetCallback | null = null;

			const v = new Virtualizer({
				count: totalRecords,
				getScrollElement: () => proxyEl as unknown as Element,
				estimateSize: () => ROW_HEIGHT,
				overscan: 15,
				initialOffset: unscaledTailOffset,
				initialRect: { width: 800, height: viewportHeight },
				scrollToFn: (unscaledOffset) => {
					const targetDom = metrics.isScaled
						? Math.round((unscaledOffset / maxUnscaledScroll) * maxDomScroll)
						: unscaledOffset;
					realDomEl.scrollTop = targetDom;
					if (registeredCallback) {
						const unscaled = metrics.isScaled
							? (realDomEl.scrollTop / maxDomScroll) * maxUnscaledScroll
							: realDomEl.scrollTop;
						registeredCallback(unscaled, true);
					}
				},
				observeElementOffset: (_inst, cb) => {
					registeredCallback = cb;
					return () => {};
				},
				observeElementRect: () => () => {},
			});

			// Verify lifecycle attachment
			expect(v.scrollElement).toBeNull();
			v._willUpdate();
			expect(v.scrollElement).not.toBeNull();

			// Verify initial tail calculation
			const initialItems = v.getVirtualItems();
			expect(initialItems.length).toBeGreaterThan(0);
			expect(initialItems[initialItems.length - 1]?.index).toBe(
				totalRecords - 1,
			);
			expect(realDomEl.scrollTop).toBe(maxDomScroll);

			// Verify seek to top
			v.scrollToIndex(0, { align: "start" });
			const topItems = v.getVirtualItems();
			expect(topItems[0]?.index).toBe(0);
			expect(realDomEl.scrollTop).toBe(0);

			// Verify seek back to tail
			v.scrollToIndex(totalRecords - 1, { align: "end" });
			const tailItems = v.getVirtualItems();
			expect(tailItems[tailItems.length - 1]?.index).toBe(totalRecords - 1);
			expect(realDomEl.scrollTop).toBe(maxDomScroll);
		});
	});
});
