import { Virtualizer } from "@tanstack/virtual-core";
import type { FormattedScidRecord } from "../../reader/scid-reader.js";
import type {
	ExtensionToWebviewMessage,
	InitMessage,
	RequestPageMessage,
	ToggleLiveTailMessage,
} from "../protocol.js";
import {
	CHUNK_SIZE,
	calculatePrefetchChunkIndices,
	calculateSpacerHeights,
	calculateVirtualScrollMetrics,
	escapeHtml,
	FOLLOW_THRESHOLD_PX,
	formatFileSize,
	formatFilteredRangeIndicator,
	formatRangeIndicator,
	formatUnreadPillText,
	MAX_CACHED_CHUNKS,
	matchesRecordFilter,
	OVERSCAN_ROWS,
	type PriceFilter,
	parsePriceFilter,
	ROW_HEIGHT,
} from "../webview-html.js";

declare function acquireVsCodeApi(): {
	postMessage(msg: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
};

interface WebviewState {
	totalRecords: number;
	timeMode: "UTC" | "LOCAL";
	liveTail: boolean;
	isFollowing: boolean;
	unreadCount: number;
	minVolume: number;
	priceFilter: PriceFilter | null;
}

class WebviewChunkCache {
	private readonly chunks = new Map<
		number,
		(FormattedScidRecord | undefined)[]
	>();
	constructor(
		private readonly maxChunks = MAX_CACHED_CHUNKS,
		private readonly chunkSize = CHUNK_SIZE,
	) {}

	get size(): number {
		return this.chunks.size;
	}

	has(chunkIndex: number): boolean {
		return this.chunks.has(chunkIndex);
	}

	get(chunkIndex: number): (FormattedScidRecord | undefined)[] | undefined {
		const chunk = this.chunks.get(chunkIndex);
		if (chunk === undefined) return undefined;
		this.chunks.delete(chunkIndex);
		this.chunks.set(chunkIndex, chunk);
		return chunk;
	}

	put(chunkIndex: number, records: (FormattedScidRecord | undefined)[]): void {
		if (this.chunks.has(chunkIndex)) {
			this.chunks.delete(chunkIndex);
		} else if (this.chunks.size >= this.maxChunks) {
			const oldestKey = this.chunks.keys().next().value;
			if (oldestKey !== undefined) this.chunks.delete(oldestKey);
		}
		this.chunks.set(chunkIndex, records);
	}

	putRecords(records: ReadonlyArray<FormattedScidRecord>): void {
		for (let i = 0; i < records.length; i++) {
			const rec = records[i];
			if (!rec) continue;
			const cIdx = Math.floor(rec.index / this.chunkSize);
			let chunk = this.chunks.get(cIdx);
			if (!chunk) {
				if (this.chunks.size >= this.maxChunks) {
					const oldestKey = this.chunks.keys().next().value;
					if (oldestKey !== undefined) this.chunks.delete(oldestKey);
				}
				chunk = new Array(this.chunkSize);
				this.chunks.set(cIdx, chunk);
			}
			const offset = rec.index - cIdx * this.chunkSize;
			chunk[offset] = rec;
		}
	}

	isComplete(chunkIndex: number, totalRecords: number): boolean {
		const chunk = this.chunks.get(chunkIndex);
		if (!chunk) return false;
		const startIdx = chunkIndex * this.chunkSize;
		if (startIdx >= totalRecords) return true;
		const endIdx = Math.min(totalRecords, startIdx + this.chunkSize);
		for (let idx = startIdx; idx < endIdx; idx++) {
			const offset = idx - startIdx;
			if (chunk[offset] === undefined) return false;
		}
		return true;
	}

	getSlice(
		startIndex: number,
		count: number,
	): {
		records: (FormattedScidRecord | undefined)[];
		missingChunkIndices: number[];
	} {
		const records: (FormattedScidRecord | undefined)[] = [];
		const missing = new Set<number>();
		for (let i = 0; i < count; i++) {
			const idx = startIndex + i;
			const cIdx = Math.floor(idx / this.chunkSize);
			const chunk = this.get(cIdx);
			if (!chunk) {
				missing.add(cIdx);
				records.push(undefined);
			} else {
				const offset = idx - cIdx * this.chunkSize;
				const rec = chunk[offset];
				if (rec === undefined) {
					missing.add(cIdx);
				}
				records.push(rec);
			}
		}
		return { records, missingChunkIndices: Array.from(missing) };
	}

	clear(): void {
		this.chunks.clear();
	}
}

// Bootstrap Webview
(() => {
	const vscode = acquireVsCodeApi();

	window.addEventListener("error", (event) => {
		try {
			console.error(
				"[scid-viewer webview error]",
				event.error || event.message,
			);
			vscode.postMessage({
				type: "WEBVIEW_ERROR",
				message: event.message,
				filename: event.filename,
				lineno: event.lineno,
			});
		} catch (_) {}
	});

	// DOM Elements
	const btnTop = document.getElementById("btnTop") as HTMLButtonElement | null;
	const btnTail = document.getElementById(
		"btnTail",
	) as HTMLButtonElement | null;
	const btnGo = document.getElementById("btnGo") as HTMLButtonElement | null;
	const btnLiveTail = document.getElementById(
		"btnLiveTail",
	) as HTMLButtonElement | null;
	const btnToggleTime = document.getElementById(
		"btnToggleTime",
	) as HTMLButtonElement | null;
	const jumpIndexInput = document.getElementById(
		"jumpIndexInput",
	) as HTMLInputElement | null;
	const rangeIndicator = document.getElementById("rangeIndicator");
	const filterMinVol = document.getElementById(
		"filterMinVol",
	) as HTMLInputElement | null;
	const filterPrice = document.getElementById(
		"filterPrice",
	) as HTMLInputElement | null;
	const btnClearFilters = document.getElementById(
		"btnClearFilters",
	) as HTMLButtonElement | null;
	const tableBody = document.getElementById("tableBody");
	const tableWrapper = document.getElementById("tableWrapper");
	const spacerTop = document.getElementById("spacerTop");
	const spacerBottom = document.getElementById("spacerBottom");
	const thTime = document.getElementById("thTime");
	const statTotalRecords = document.getElementById("statTotalRecords");
	const statFileSize = document.getElementById("statFileSize");
	const statLastTime = document.getElementById("statLastTime");
	const floatingFollowPill = document.getElementById("floatingFollowPill");
	const pillText = document.getElementById("pillText");

	if (!tableWrapper || !tableBody) {
		return;
	}

	// Parse initial data embedded in HTML
	const initialScript = document.getElementById("scid-initial-data");
	const initial: InitMessage | null = initialScript?.textContent
		? JSON.parse(initialScript.textContent)
		: null;

	const state: WebviewState = {
		totalRecords: initial?.summary ? initial.summary.totalRecords : 0,
		timeMode: "UTC",
		liveTail: false,
		isFollowing: false,
		unreadCount: 0,
		minVolume: 0,
		priceFilter: null,
	};

	const cache = new WebviewChunkCache();
	const inFlightChunks = new Set<number>();

	function requestChunk(chunkIndex: number) {
		if (inFlightChunks.has(chunkIndex)) return;
		if (cache.isComplete(chunkIndex, state.totalRecords)) return;
		inFlightChunks.add(chunkIndex);
		const req: RequestPageMessage = {
			type: "REQUEST_PAGE",
			offsetIndex: chunkIndex * CHUNK_SIZE,
			pageSize: CHUNK_SIZE,
		};
		vscode.postMessage(req);
	}

	function updateLiveTailButton() {
		if (!btnLiveTail) return;
		if (state.liveTail) {
			btnLiveTail.classList.add("btn-live-active");
			btnLiveTail.innerHTML = '<span class="pulse-dot"></span>Live Tail: ON';
		} else {
			btnLiveTail.classList.remove("btn-live-active");
			btnLiveTail.textContent = "Live Tail: OFF";
		}
	}

	function updateFollowPill() {
		if (!floatingFollowPill || !pillText) return;
		if (state.liveTail && !state.isFollowing && state.unreadCount > 0) {
			pillText.textContent = formatUnreadPillText(state.unreadCount);
			floatingFollowPill.classList.add("visible");
		} else {
			floatingFollowPill.classList.remove("visible");
		}
	}

	function checkFollowScroll() {
		if (!state.liveTail || !tableWrapper) return;
		const metrics = calculateVirtualScrollMetrics(state.totalRecords);
		const maxScroll = Math.max(
			0,
			metrics.totalVirtualHeight - tableWrapper.clientHeight,
		);
		if (maxScroll <= 0) {
			if (!state.isFollowing || state.unreadCount > 0) {
				state.isFollowing = true;
				state.unreadCount = 0;
				updateFollowPill();
			}
			return;
		}
		const distanceFromBottom = Math.max(0, maxScroll - tableWrapper.scrollTop);
		const atBottom = distanceFromBottom <= FOLLOW_THRESHOLD_PX;

		if (atBottom) {
			if (!state.isFollowing || state.unreadCount > 0) {
				state.isFollowing = true;
				state.unreadCount = 0;
				updateFollowPill();
			}
		} else {
			if (state.isFollowing) {
				state.isFollowing = false;
				updateFollowPill();
			}
		}
	}

	function matchesFilter(rec: FormattedScidRecord): boolean {
		return matchesRecordFilter(rec, state.minVolume, state.priceFilter);
	}

	const initialViewportHeight = tableWrapper.clientHeight || 600;
	const initialUnscaledTailOffset = Math.max(
		0,
		state.totalRecords * ROW_HEIGHT - initialViewportHeight,
	);

	// Virtual Scroll Element Proxy:
	// Maps `scrollHeight` to `state.totalRecords * ROW_HEIGHT` so TanStack Virtual
	// computes true unscaled offsets without clamping to the downscaled DOM height.
	// Binds native DOM methods to target element to prevent "Illegal invocation" errors in V8.
	const virtualScrollElement = new Proxy(tableWrapper, {
		get(target, prop) {
			if (prop === "scrollHeight") {
				return state.totalRecords * ROW_HEIGHT;
			}
			const val = Reflect.get(target, prop, target);
			if (typeof val === "function") {
				return val.bind(target);
			}
			return val;
		},
	});

	// Initialize TanStack Virtual with Coordinate Downscaling Wrapper
	const virtualizer = new Virtualizer({
		count: state.totalRecords,
		getScrollElement: () => virtualScrollElement,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN_ROWS,
		initialOffset: initialUnscaledTailOffset,
		initialRect: {
			width: tableWrapper.clientWidth || 800,
			height: initialViewportHeight,
		},
		scrollToFn: (unscaledOffset: number) => {
			if (!tableWrapper) return;
			const metrics = calculateVirtualScrollMetrics(state.totalRecords);
			const viewportHeight = tableWrapper.clientHeight || 600;
			const maxDomScroll = Math.max(
				1,
				metrics.totalVirtualHeight - viewportHeight,
			);
			const maxUnscaledScroll = Math.max(
				1,
				state.totalRecords * ROW_HEIGHT - viewportHeight,
			);
			const targetDomScroll = metrics.isScaled
				? Math.round((unscaledOffset / maxUnscaledScroll) * maxDomScroll)
				: unscaledOffset;
			tableWrapper.scrollTop = targetDomScroll;
		},
		observeElementOffset: (_instance, cb) => {
			const onScroll = () => {
				checkFollowScroll();
				if (!tableWrapper) return;
				const metrics = calculateVirtualScrollMetrics(state.totalRecords);
				const viewportHeight = tableWrapper.clientHeight || 600;
				const maxDomScroll = Math.max(
					1,
					metrics.totalVirtualHeight - viewportHeight,
				);
				const maxUnscaledScroll = Math.max(
					1,
					state.totalRecords * ROW_HEIGHT - viewportHeight,
				);
				const domScroll = tableWrapper.scrollTop;
				const unscaled = metrics.isScaled
					? (domScroll / maxDomScroll) * maxUnscaledScroll
					: domScroll;
				cb(unscaled, true);
			};
			tableWrapper.addEventListener("scroll", onScroll, { passive: true });
			return () => tableWrapper.removeEventListener("scroll", onScroll);
		},
		observeElementRect: (_instance, cb) => {
			const handler = () => {
				if (!tableWrapper) return;
				cb({
					width: tableWrapper.clientWidth || 800,
					height: tableWrapper.clientHeight || 600,
				});
			};
			handler();
			const ro = new ResizeObserver(handler);
			ro.observe(tableWrapper);
			return () => ro.disconnect();
		},
		onChange: () => {
			renderVirtualWindow();
		},
	});

	// Explicitly attach the scroll element and bind observers in vanilla JS
	virtualizer._willUpdate();

	function renderVirtualWindow() {
		if (!tableWrapper || !tableBody) return;
		if (state.totalRecords === 0) {
			if (spacerTop) spacerTop.style.height = "0px";
			if (spacerBottom) spacerBottom.style.height = "0px";
			tableBody.innerHTML =
				'<div class="table-row empty-row" role="row"><div class="table-cell empty-cell" role="cell">No records available</div></div>';
			if (rangeIndicator) rangeIndicator.textContent = "Showing 0 of 0";
			return;
		}

		const virtualItems = virtualizer.getVirtualItems();
		if (virtualItems.length === 0) return;

		const firstItem = virtualItems[0];
		const lastItem = virtualItems[virtualItems.length - 1];
		if (!firstItem || !lastItem) return;

		const startIndex = firstItem.index;
		const endIndex = lastItem.index + 1;
		const renderedCount = Math.max(0, endIndex - startIndex);

		const spacers = calculateSpacerHeights(
			startIndex,
			renderedCount,
			state.totalRecords,
		);
		if (spacerTop) spacerTop.style.height = `${spacers.topSpacerHeight}px`;
		if (spacerBottom)
			spacerBottom.style.height = `${spacers.bottomSpacerHeight}px`;

		// Retrieve visible slice from LRU cache
		const slice = cache.getSlice(startIndex, renderedCount);

		// Dispatch immediate request for missing visible chunks
		for (let i = 0; i < slice.missingChunkIndices.length; i++) {
			const missingIdx = slice.missingChunkIndices[i];
			if (missingIdx !== undefined) {
				requestChunk(missingIdx);
			}
		}

		// Dispatch predictive prefetch requests within 250 records
		const prefetch = calculatePrefetchChunkIndices(
			startIndex,
			renderedCount,
			state.totalRecords,
		);
		for (let i = 0; i < prefetch.prefetchChunkIndices.length; i++) {
			const pIdx = prefetch.prefetchChunkIndices[i];
			if (pIdx !== undefined) {
				requestChunk(pIdx);
			}
		}

		let rowsHtml = "";
		const isFiltered = state.minVolume > 0 || state.priceFilter !== null;
		let matchCount = 0;

		for (let i = 0; i < slice.records.length; i++) {
			const rec = slice.records[i];
			const rowIdx = startIndex + i;
			if (rec === undefined) {
				rowsHtml += renderSkeletonRowHtml(rowIdx);
			} else if (!isFiltered || matchesFilter(rec)) {
				rowsHtml += renderRowHtml(rec);
				matchCount++;
			}
		}

		if (rowsHtml === "" && isFiltered) {
			rowsHtml =
				'<div class="table-row empty-row" role="row"><div class="table-cell empty-cell" role="cell">No matching records</div></div>';
		}

		tableBody.innerHTML = rowsHtml;

		const dispStart = state.totalRecords === 0 ? 0 : startIndex + 1;
		if (rangeIndicator) {
			if (isFiltered) {
				rangeIndicator.textContent = formatFilteredRangeIndicator(
					matchCount,
					renderedCount,
				);
			} else {
				rangeIndicator.textContent = formatRangeIndicator(
					dispStart,
					endIndex,
					state.totalRecords,
				);
			}
		}
	}

	function renderSkeletonRowHtml(rowIdx: number): string {
		return (
			'<div class="table-row skeleton-row" role="row">' +
			`<div class="table-cell col-index" role="cell">#${rowIdx.toLocaleString()}</div>` +
			'<div class="table-cell col-time skeleton-cell" role="cell"><span class="skeleton-bar" style="width: 140px;"></span></div>' +
			'<div class="table-cell col-price skeleton-cell" role="cell"><span class="skeleton-bar" style="width: 60px;"></span></div>' +
			'<div class="table-cell col-qty skeleton-cell" role="cell"><span class="skeleton-bar" style="width: 40px;"></span></div>' +
			'<div class="table-cell col-side skeleton-cell" role="cell"><span class="skeleton-bar" style="width: 30px;"></span></div>' +
			'<div class="table-cell col-volume skeleton-cell" role="cell"><span class="skeleton-bar" style="width: 50px;"></span></div>' +
			'<div class="table-cell col-volume skeleton-cell" role="cell"><span class="skeleton-bar" style="width: 50px;"></span></div>' +
			"</div>"
		);
	}

	function renderRowHtml(rec: FormattedScidRecord): string {
		const sideClass =
			rec.side === "BUY"
				? "badge-buy"
				: rec.side === "SELL"
					? "badge-sell"
					: "badge-neutral";
		const isLocal = state.timeMode === "LOCAL";
		const timeStr = isLocal ? rec.localFormatted || rec.isoUtc : rec.isoUtc;
		const priceVal = typeof rec.price === "number" ? rec.price : rec.close || 0;

		return (
			'<div class="table-row" role="row">' +
			`<div class="table-cell col-index" role="cell">${rec.index.toLocaleString()}</div>` +
			`<div class="table-cell col-time" role="cell">${escapeHtml(timeStr)}</div>` +
			`<div class="table-cell col-price" role="cell">${priceVal.toFixed(2)}</div>` +
			`<div class="table-cell col-qty" role="cell">${rec.totalVolume.toLocaleString()}</div>` +
			`<div class="table-cell col-side" role="cell"><span class="badge ${sideClass}">${rec.side}</span></div>` +
			`<div class="table-cell col-volume" role="cell">${rec.bidVolume.toLocaleString()}</div>` +
			`<div class="table-cell col-volume" role="cell">${rec.askVolume.toLocaleString()}</div>` +
			"</div>"
		);
	}

	function scrollToBottom() {
		if (state.totalRecords === 0 || !tableWrapper) return;
		virtualizer.scrollToIndex(state.totalRecords - 1, { align: "end" });
		const metrics = calculateVirtualScrollMetrics(state.totalRecords);
		const viewportHeight = tableWrapper.clientHeight || 600;
		const maxDomScroll = Math.max(
			0,
			metrics.totalVirtualHeight - viewportHeight,
		);
		tableWrapper.scrollTop = maxDomScroll;
		renderVirtualWindow();
	}

	function disableLiveTailIfActive() {
		if (state.liveTail) {
			state.liveTail = false;
			state.isFollowing = false;
			state.unreadCount = 0;
			updateLiveTailButton();
			updateFollowPill();
			const msg: ToggleLiveTailMessage = {
				type: "TOGGLE_LIVE_TAIL",
				enabled: false,
			};
			vscode.postMessage(msg);
		}
	}

	// UI Event Listeners
	btnTop?.addEventListener("click", () => {
		disableLiveTailIfActive();
		virtualizer.scrollToIndex(0, { align: "start" });
		if (tableWrapper) tableWrapper.scrollTop = 0;
		renderVirtualWindow();
	});

	btnTail?.addEventListener("click", () => {
		if (state.liveTail) {
			state.isFollowing = true;
			state.unreadCount = 0;
			updateFollowPill();
		}
		scrollToBottom();
	});

	btnLiveTail?.addEventListener("click", () => {
		state.liveTail = !state.liveTail;
		state.isFollowing = state.liveTail;
		state.unreadCount = 0;
		updateLiveTailButton();
		updateFollowPill();
		const msg: ToggleLiveTailMessage = {
			type: "TOGGLE_LIVE_TAIL",
			enabled: state.liveTail,
		};
		vscode.postMessage(msg);
		if (state.liveTail) {
			scrollToBottom();
		}
	});

	floatingFollowPill?.addEventListener("click", () => {
		state.isFollowing = true;
		state.unreadCount = 0;
		updateFollowPill();
		scrollToBottom();
	});

	btnToggleTime?.addEventListener("click", () => {
		state.timeMode = state.timeMode === "UTC" ? "LOCAL" : "UTC";
		btnToggleTime.textContent = `Time: ${state.timeMode}`;
		if (thTime)
			thTime.textContent =
				state.timeMode === "UTC" ? "Time (UTC)" : "Time (Local)";
		renderVirtualWindow();
	});

	filterMinVol?.addEventListener("input", () => {
		state.minVolume = Number.parseInt(filterMinVol.value, 10) || 0;
		renderVirtualWindow();
	});

	filterPrice?.addEventListener("input", () => {
		if (!filterPrice) return;
		state.priceFilter = parsePriceFilter(filterPrice.value);
		renderVirtualWindow();
	});

	btnClearFilters?.addEventListener("click", () => {
		if (filterMinVol) filterMinVol.value = "";
		if (filterPrice) filterPrice.value = "";
		state.minVolume = 0;
		state.priceFilter = null;
		renderVirtualWindow();
	});

	btnGo?.addEventListener("click", () => {
		if (!jumpIndexInput) return;
		disableLiveTailIfActive();
		const target = Number.parseInt(jumpIndexInput.value, 10);
		if (!Number.isNaN(target) && target >= 0) {
			const clamped = Math.min(state.totalRecords - 1, target);
			virtualizer.scrollToIndex(clamped, { align: "start" });
			renderVirtualWindow();
		}
	});

	jumpIndexInput?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			btnGo?.click();
		}
	});

	// Message Listener from Extension Host
	window.addEventListener(
		"message",
		(event: MessageEvent<ExtensionToWebviewMessage>) => {
			const msg = event.data;
			if (!msg) return;

			if (msg.type === "PAGE_DATA") {
				state.totalRecords = msg.totalRecords;
				if (msg.records && msg.records.length > 0) {
					cache.putRecords(msg.records);
					for (let i = 0; i < msg.records.length; i++) {
						const rec = msg.records[i];
						if (rec) {
							inFlightChunks.delete(Math.floor(rec.index / CHUNK_SIZE));
						}
					}
				}
				inFlightChunks.delete(Math.floor(msg.offsetIndex / CHUNK_SIZE));
				virtualizer.setOptions({
					...virtualizer.options,
					count: state.totalRecords,
				});
				virtualizer._willUpdate();
				renderVirtualWindow();
			} else if (msg.type === "INIT") {
				state.totalRecords = msg.summary.totalRecords;
				if (msg.records && msg.records.length > 0) {
					cache.putRecords(msg.records);
					for (let i = 0; i < msg.records.length; i++) {
						const rec = msg.records[i];
						if (rec) {
							inFlightChunks.delete(Math.floor(rec.index / CHUNK_SIZE));
						}
					}
				}
				inFlightChunks.delete(Math.floor(msg.offsetIndex / CHUNK_SIZE));
				virtualizer.setOptions({
					...virtualizer.options,
					count: state.totalRecords,
				});
				virtualizer._willUpdate();
				renderVirtualWindow();
			} else if (msg.type === "APPEND_RECORDS") {
				state.totalRecords = msg.totalRecords;
				if (statTotalRecords)
					statTotalRecords.textContent = msg.totalRecords.toLocaleString();
				if (msg.fileSize && statFileSize)
					statFileSize.textContent = formatFileSize(msg.fileSize);
				if (msg.lastRecordIsoUtc && statLastTime)
					statLastTime.textContent = msg.lastRecordIsoUtc;

				if (msg.records && msg.records.length > 0) {
					cache.putRecords(msg.records);
				}

				virtualizer.setOptions({
					...virtualizer.options,
					count: state.totalRecords,
				});
				virtualizer._willUpdate();

				if (state.liveTail) {
					if (state.isFollowing) {
						scrollToBottom();
					} else {
						const incomingCount = msg.records ? msg.records.length : 0;
						const isFiltered =
							state.minVolume > 0 || state.priceFilter !== null;
						let matchingIncoming = incomingCount;
						if (isFiltered && msg.records && msg.records.length > 0) {
							matchingIncoming = msg.records.filter(matchesFilter).length;
						}
						if (matchingIncoming > 0) {
							state.unreadCount += matchingIncoming;
							updateFollowPill();
						}
						renderVirtualWindow();
					}
				} else {
					renderVirtualWindow();
				}
			}
		},
	);

	// Initial hydration from embedded script tag
	if (initial) {
		if (initial.records && initial.records.length > 0) {
			cache.putRecords(initial.records);
		}
		virtualizer.setOptions({
			...virtualizer.options,
			count: state.totalRecords,
		});
		virtualizer._willUpdate();
		if (state.totalRecords > 0) {
			scrollToBottom();
		} else {
			renderVirtualWindow();
		}
	} else {
		renderVirtualWindow();
	}
})();
