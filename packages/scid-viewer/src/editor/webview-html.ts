import type { FormattedScidRecord } from "../reader/scid-reader.js";
import type { InitMessage } from "./protocol.js";

export const formatFileSize = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const ROW_HEIGHT = 28;
export const MAX_CONTAINER_HEIGHT = 5_000_000;
export const OVERSCAN_ROWS = 15;
export const CHUNK_SIZE = 500;
export const MAX_CACHED_CHUNKS = 20;
export const PREFETCH_MARGIN = 250;
export const FOLLOW_THRESHOLD_PX = 50;

export interface VirtualScrollMetrics {
	readonly totalVirtualHeight: number;
	readonly isScaled: boolean;
	readonly scaleRatio: number;
}

export const calculateVirtualScrollMetrics = (
	totalRecords: number,
	rowHeight = ROW_HEIGHT,
	maxContainerHeight = MAX_CONTAINER_HEIGHT,
): VirtualScrollMetrics => {
	const rawHeight = totalRecords * rowHeight;
	if (rawHeight <= maxContainerHeight) {
		return {
			totalVirtualHeight: rawHeight,
			isScaled: false,
			scaleRatio: 1,
		};
	}
	return {
		totalVirtualHeight: maxContainerHeight,
		isScaled: true,
		scaleRatio: maxContainerHeight / rawHeight,
	};
};

export const scrollTopToIndex = (
	scrollTop: number,
	viewportHeight: number,
	totalRecords: number,
	rowHeight = ROW_HEIGHT,
	maxContainerHeight = MAX_CONTAINER_HEIGHT,
): number => {
	if (totalRecords <= 0) return 0;
	const visibleRows = Math.ceil(viewportHeight / rowHeight);
	const maxStartIndex = Math.max(0, totalRecords - visibleRows);
	const metrics = calculateVirtualScrollMetrics(
		totalRecords,
		rowHeight,
		maxContainerHeight,
	);
	const maxScrollTop = Math.max(1, metrics.totalVirtualHeight - viewportHeight);
	const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop));

	if (!metrics.isScaled) {
		return Math.min(maxStartIndex, Math.floor(clampedScrollTop / rowHeight));
	}
	return Math.min(
		maxStartIndex,
		Math.round((clampedScrollTop / maxScrollTop) * maxStartIndex),
	);
};

export const indexToScrollTop = (
	index: number,
	viewportHeight: number,
	totalRecords: number,
	rowHeight = ROW_HEIGHT,
	maxContainerHeight = MAX_CONTAINER_HEIGHT,
): number => {
	if (totalRecords <= 0) return 0;
	const visibleRows = Math.ceil(viewportHeight / rowHeight);
	const maxStartIndex = Math.max(0, totalRecords - visibleRows);
	const clampedIndex = Math.max(0, Math.min(maxStartIndex, index));
	const metrics = calculateVirtualScrollMetrics(
		totalRecords,
		rowHeight,
		maxContainerHeight,
	);
	const maxScrollTop = Math.max(0, metrics.totalVirtualHeight - viewportHeight);

	if (!metrics.isScaled) {
		return clampedIndex * rowHeight;
	}
	return maxStartIndex === 0
		? 0
		: Math.round((clampedIndex / maxStartIndex) * maxScrollTop);
};

export const calculateSpacerHeights = (
	startIndex: number,
	renderedCount: number,
	totalRecords: number,
	rowHeight = ROW_HEIGHT,
	maxContainerHeight = MAX_CONTAINER_HEIGHT,
): { topSpacerHeight: number; bottomSpacerHeight: number } => {
	const metrics = calculateVirtualScrollMetrics(
		totalRecords,
		rowHeight,
		maxContainerHeight,
	);
	if (!metrics.isScaled) {
		const topSpacerHeight = startIndex * rowHeight;
		const remaining = Math.max(0, totalRecords - (startIndex + renderedCount));
		const bottomSpacerHeight = remaining * rowHeight;
		return { topSpacerHeight, bottomSpacerHeight };
	}
	const topSpacerHeight = Math.round(
		startIndex * rowHeight * metrics.scaleRatio,
	);
	const remaining = Math.max(0, totalRecords - (startIndex + renderedCount));
	const bottomSpacerHeight = Math.max(
		0,
		Math.round(remaining * rowHeight * metrics.scaleRatio),
	);
	return { topSpacerHeight, bottomSpacerHeight };
};

export const renderSkeletonRows = (
	startIndex: number,
	count: number,
): string => {
	const rows: string[] = [];
	for (let i = 0; i < count; i++) {
		const idx = startIndex + i;
		rows.push(`<tr>
			<td class="col-index">#${idx.toLocaleString()}</td>
			<td class="col-time skeleton-cell"><span class="skeleton-bar" style="width: 140px;"></span></td>
			<td class="col-price skeleton-cell"><span class="skeleton-bar" style="width: 60px;"></span></td>
			<td class="col-qty skeleton-cell"><span class="skeleton-bar" style="width: 40px;"></span></td>
			<td class="col-side skeleton-cell"><span class="skeleton-bar" style="width: 30px;"></span></td>
			<td class="col-volume skeleton-cell"><span class="skeleton-bar" style="width: 50px;"></span></td>
			<td class="col-volume skeleton-cell"><span class="skeleton-bar" style="width: 50px;"></span></td>
		</tr>`);
	}
	return rows.join("\n");
};

export interface ChunkSliceResult<T> {
	readonly records: ReadonlyArray<T | undefined>;
	readonly missingChunkIndices: ReadonlyArray<number>;
}

export class LruChunkCache<T> {
	private readonly chunks = new Map<number, ReadonlyArray<T>>();

	constructor(
		public readonly maxChunks: number = MAX_CACHED_CHUNKS,
		public readonly chunkSize: number = CHUNK_SIZE,
	) {}

	get size(): number {
		return this.chunks.size;
	}

	has(chunkIndex: number): boolean {
		return this.chunks.has(chunkIndex);
	}

	get(chunkIndex: number): ReadonlyArray<T> | undefined {
		const chunk = this.chunks.get(chunkIndex);
		if (chunk === undefined) {
			return undefined;
		}
		// Refresh recency
		this.chunks.delete(chunkIndex);
		this.chunks.set(chunkIndex, chunk);
		return chunk;
	}

	put(chunkIndex: number, records: ReadonlyArray<T>): void {
		if (this.chunks.has(chunkIndex)) {
			this.chunks.delete(chunkIndex);
		} else if (this.chunks.size >= this.maxChunks) {
			const oldestKey = this.chunks.keys().next().value;
			if (oldestKey !== undefined) {
				this.chunks.delete(oldestKey);
			}
		}
		this.chunks.set(chunkIndex, records);
	}

	getRecord(recordIndex: number): T | undefined {
		const chunkIndex = Math.floor(recordIndex / this.chunkSize);
		const chunk = this.get(chunkIndex);
		if (!chunk) return undefined;
		const offsetInChunk = recordIndex - chunkIndex * this.chunkSize;
		return chunk[offsetInChunk];
	}

	getSlice(startIndex: number, count: number): ChunkSliceResult<T> {
		const records: (T | undefined)[] = [];
		const missingChunks = new Set<number>();

		for (let i = 0; i < count; i++) {
			const recIdx = startIndex + i;
			const chunkIdx = Math.floor(recIdx / this.chunkSize);
			const chunk = this.get(chunkIdx);
			if (!chunk) {
				missingChunks.add(chunkIdx);
				records.push(undefined);
			} else {
				const offsetInChunk = recIdx - chunkIdx * this.chunkSize;
				records.push(chunk[offsetInChunk]);
			}
		}

		return {
			records,
			missingChunkIndices: Array.from(missingChunks),
		};
	}

	getCachedChunkIndices(): number[] {
		return Array.from(this.chunks.keys());
	}

	clear(): void {
		this.chunks.clear();
	}
}

export const calculatePrefetchChunkIndices = (
	startIndex: number,
	count: number,
	totalRecords: number,
	chunkSize = CHUNK_SIZE,
	prefetchMargin = PREFETCH_MARGIN,
): { visibleChunkIndices: number[]; prefetchChunkIndices: number[] } => {
	if (totalRecords <= 0 || count <= 0) {
		return { visibleChunkIndices: [], prefetchChunkIndices: [] };
	}

	const maxIndex = totalRecords - 1;
	const clampedStart = Math.max(0, Math.min(maxIndex, startIndex));
	const clampedEnd = Math.max(0, Math.min(maxIndex, startIndex + count - 1));

	const startChunk = Math.floor(clampedStart / chunkSize);
	const endChunk = Math.floor(clampedEnd / chunkSize);

	const visibleChunkIndices: number[] = [];
	for (let c = startChunk; c <= endChunk; c++) {
		visibleChunkIndices.push(c);
	}

	const prefetchChunkIndices: number[] = [];
	if (clampedStart > 0) {
		const backwardIndex = Math.max(0, clampedStart - prefetchMargin);
		const backwardChunk = Math.floor(backwardIndex / chunkSize);
		if (backwardChunk < startChunk) {
			prefetchChunkIndices.push(backwardChunk);
		}
	}

	if (clampedEnd < maxIndex) {
		const forwardIndex = Math.min(maxIndex, clampedEnd + prefetchMargin);
		const forwardChunk = Math.floor(forwardIndex / chunkSize);
		if (forwardChunk > endChunk) {
			prefetchChunkIndices.push(forwardChunk);
		}
	}

	return { visibleChunkIndices, prefetchChunkIndices };
};

export const isScrolledToBottom = (
	scrollTop: number,
	viewportHeight: number,
	totalVirtualHeight: number,
	thresholdPx = FOLLOW_THRESHOLD_PX,
): boolean => {
	const maxScroll = Math.max(0, totalVirtualHeight - viewportHeight);
	return maxScroll - scrollTop <= thresholdPx;
};

export interface FollowScrollState {
	readonly liveTail: boolean;
	readonly isFollowing: boolean;
	readonly unreadCount: number;
}

export const handleFollowScroll = (
	currentState: FollowScrollState,
	scrollTop: number,
	viewportHeight: number,
	totalVirtualHeight: number,
	thresholdPx = FOLLOW_THRESHOLD_PX,
): FollowScrollState => {
	if (!currentState.liveTail) {
		return currentState;
	}

	const atBottom = isScrolledToBottom(
		scrollTop,
		viewportHeight,
		totalVirtualHeight,
		thresholdPx,
	);

	if (atBottom) {
		return {
			liveTail: true,
			isFollowing: true,
			unreadCount: 0,
		};
	}

	return {
		liveTail: true,
		isFollowing: false,
		unreadCount: currentState.unreadCount,
	};
};

export interface AppendFollowResult {
	readonly nextState: FollowScrollState;
	readonly shouldSnapToBottom: boolean;
}

export const handleFollowAppend = (
	currentState: FollowScrollState,
	newRecordCount: number,
): AppendFollowResult => {
	if (!currentState.liveTail) {
		return {
			nextState: currentState,
			shouldSnapToBottom: false,
		};
	}

	if (currentState.isFollowing) {
		return {
			nextState: {
				liveTail: true,
				isFollowing: true,
				unreadCount: 0,
			},
			shouldSnapToBottom: true,
		};
	}

	return {
		nextState: {
			liveTail: true,
			isFollowing: false,
			unreadCount: currentState.unreadCount + newRecordCount,
		},
		shouldSnapToBottom: false,
	};
};

export const resumeFollow = (
	_currentState: FollowScrollState,
): FollowScrollState => ({
	liveTail: true,
	isFollowing: true,
	unreadCount: 0,
});

export const formatUnreadPillText = (unreadCount: number): string =>
	`↓ ${unreadCount.toLocaleString()} new trades — Resume Live Tail`;

export interface PriceFilter {
	readonly op: ">=" | "<=" | ">" | "<" | "=";
	readonly val: number;
}

export const parsePriceFilter = (raw: string): PriceFilter | null => {
	if (!raw?.trim()) return null;
	const trimmed = raw.trim();
	const match = trimmed.match(/^([><]=?|=)?\s*([0-9]+(?:\.[0-9]+)?)$/);
	if (!match) return null;
	const op = (match[1] as PriceFilter["op"]) || "=";
	const val = Number.parseFloat(match[2] as string);
	if (Number.isNaN(val)) return null;
	return { op, val };
};

export const matchesRecordFilter = (
	record: {
		readonly price?: number;
		readonly close?: number;
		readonly totalVolume: number;
	},
	minVolume = 0,
	priceFilter: PriceFilter | null = null,
): boolean => {
	if (minVolume > 0 && record.totalVolume < minVolume) {
		return false;
	}
	if (priceFilter !== null) {
		const price =
			typeof record.price === "number" ? record.price : (record.close ?? 0);
		const target = priceFilter.val;
		switch (priceFilter.op) {
			case ">=":
				if (!(price >= target)) return false;
				break;
			case "<=":
				if (!(price <= target)) return false;
				break;
			case ">":
				if (!(price > target)) return false;
				break;
			case "<":
				if (!(price < target)) return false;
				break;
			default:
				if (Math.abs(price - target) > 0.001) return false;
				break;
		}
	}
	return true;
};

export const formatFilteredRangeIndicator = (
	matchCount: number,
	renderedCount: number,
): string =>
	`Filtered: ${matchCount.toLocaleString()} matching of ${renderedCount.toLocaleString()} visible in window`;

export const formatRangeIndicator = (
	dispStart: number,
	endIndex: number,
	totalRecords: number,
): string =>
	`Showing ${dispStart.toLocaleString()} - ${endIndex.toLocaleString()} of ${totalRecords.toLocaleString()}`;

export const escapeHtml = (str: string): string =>
	str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

export const renderTableRows = (
	records: ReadonlyArray<FormattedScidRecord>,
	timeMode: "UTC" | "LOCAL" = "UTC",
): string => {
	if (records.length === 0) {
		return `<tr><td colspan="7" class="empty-cell">No records available</td></tr>`;
	}

	const isLocal = timeMode === "LOCAL";

	return records
		.map((rec) => {
			const sideClass =
				rec.side === "BUY"
					? "badge-buy"
					: rec.side === "SELL"
						? "badge-sell"
						: "badge-neutral";
			const priceVal =
				typeof rec.price === "number" ? rec.price : (rec.close ?? 0);
			const timeStr = isLocal ? rec.localFormatted || rec.isoUtc : rec.isoUtc;
			return `<tr>
				<td class="col-index">${rec.index.toLocaleString()}</td>
				<td class="col-time">${escapeHtml(timeStr)}</td>
				<td class="col-price">${priceVal.toFixed(2)}</td>
				<td class="col-qty">${rec.totalVolume.toLocaleString()}</td>
				<td class="col-side"><span class="badge ${sideClass}">${rec.side}</span></td>
				<td class="col-volume">${rec.bidVolume.toLocaleString()}</td>
				<td class="col-volume">${rec.askVolume.toLocaleString()}</td>
			</tr>`;
		})
		.join("\n");
};

export const renderWebviewHtml = (
	fileName: string,
	initialData?: InitMessage,
): string => {
	const summary = initialData?.summary;
	const totalRecords = summary?.totalRecords ?? 0;
	const fileSize = summary?.fileSize ?? 0;
	const firstTime = summary?.firstRecordIsoUtc ?? "N/A";
	const lastTime = summary?.lastRecordIsoUtc ?? "N/A";
	const offsetIndex = initialData?.offsetIndex ?? 0;
	const records = initialData?.records ?? [];
	const rowsHtml = renderTableRows(records, "UTC");
	const initialSpacers = calculateSpacerHeights(
		offsetIndex,
		records.length,
		totalRecords,
	);

	const initialJson = initialData
		? JSON.stringify(initialData, (_key, value) =>
				typeof value === "bigint" ? value.toString() : value,
			)
		: "null";

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(fileName)} - SCID Data Viewer</title>
	<style>
		:root {
			--bg-color: var(--vscode-editor-background, #1e1e1e);
			--fg-color: var(--vscode-editor-foreground, #d4d4d4);
			--border-color: var(--vscode-panel-border, #333333);
			--header-bg: var(--vscode-sideBar-background, #252526);
			--card-bg: var(--vscode-editorWidget-background, #2d2d2d);
			--row-alt-bg: rgba(255, 255, 255, 0.02);
			--row-hover-bg: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
			--badge-buy-bg: rgba(78, 201, 176, 0.2);
			--badge-buy-fg: #4ec9b0;
			--badge-sell-bg: rgba(244, 71, 71, 0.2);
			--badge-sell-fg: #f44747;
			--badge-neutral-bg: rgba(150, 150, 150, 0.2);
			--badge-neutral-fg: #969696;
			--font-mono: var(--vscode-editor-font-family, monospace);
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			background-color: var(--bg-color);
			color: var(--fg-color);
			font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
			font-size: 13px;
			display: flex;
			flex-direction: column;
			height: 100vh;
			overflow: hidden;
		}

		/* Pinned Header */
		.header-container {
			background-color: var(--header-bg);
			border-bottom: 1px solid var(--border-color);
			padding: 12px 16px;
			flex-shrink: 0;
			display: flex;
			flex-direction: column;
			gap: 10px;
		}

		.title-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
		}

		.title-row h1 {
			font-size: 15px;
			font-weight: 600;
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.title-row .format-tag {
			font-size: 11px;
			background: var(--vscode-badge-background, #4d4d4d);
			color: var(--vscode-badge-foreground, #ffffff);
			padding: 2px 6px;
			border-radius: 3px;
			font-weight: normal;
		}

		.stats-cards {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
			gap: 8px;
		}

		.stat-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 4px;
			padding: 6px 10px;
			display: flex;
			flex-direction: column;
		}

		.stat-label {
			font-size: 10px;
			text-transform: uppercase;
			color: var(--vscode-descriptionForeground, #888888);
			letter-spacing: 0.5px;
		}

		.stat-value {
			font-size: 13px;
			font-weight: 600;
			font-family: var(--font-mono);
			margin-top: 2px;
		}

		/* Toolbar & Pagination */
		.toolbar {
			background-color: var(--header-bg);
			border-bottom: 1px solid var(--border-color);
			padding: 8px 16px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			flex-shrink: 0;
			gap: 12px;
			flex-wrap: wrap;
		}

		.pagination-group {
			display: flex;
			align-items: center;
			gap: 6px;
		}

		button {
			background-color: var(--vscode-button-secondaryBackground, #3a3d41);
			color: var(--vscode-button-secondaryForeground, #ffffff);
			border: 1px solid var(--border-color);
			border-radius: 3px;
			padding: 4px 8px;
			font-size: 12px;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			transition: background 0.15s, border-color 0.15s, color 0.15s;
		}

		button:hover:not(:disabled) {
			background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
		}

		button:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}

		button.btn-primary {
			background-color: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #ffffff);
		}

		button.btn-primary:hover:not(:disabled) {
			background-color: var(--vscode-button-hoverBackground, #1177bb);
		}

		button.btn-live-active {
			background-color: rgba(78, 201, 176, 0.25);
			color: #4ec9b0;
			border-color: #4ec9b0;
			font-weight: 600;
		}

		.pulse-dot {
			display: inline-block;
			width: 7px;
			height: 7px;
			background-color: #4ec9b0;
			border-radius: 50%;
			margin-right: 5px;
			animation: pulse 1.5s infinite;
		}

		@keyframes pulse {
			0% { opacity: 1; transform: scale(1); }
			50% { opacity: 0.3; transform: scale(0.85); }
			100% { opacity: 1; transform: scale(1); }
		}

		.range-indicator {
			font-size: 12px;
			color: var(--vscode-descriptionForeground, #999999);
			margin: 0 4px;
			font-family: var(--font-mono);
		}

		.jump-group {
			display: flex;
			align-items: center;
			gap: 6px;
		}

		.filter-group {
			display: flex;
			align-items: center;
			gap: 6px;
		}

		input[type="text"], input[type="number"], select {
			background-color: var(--vscode-input-background, #3c3c3c);
			color: var(--vscode-input-foreground, #cccccc);
			border: 1px solid var(--vscode-input-border, #555555);
			border-radius: 3px;
			padding: 4px 6px;
			font-size: 12px;
			font-family: var(--font-mono);
		}

		input[type="number"] {
			width: 80px;
		}

		/* Data Table */
		.table-wrapper {
			flex: 1;
			overflow: auto;
			position: relative;
		}

		table {
			width: 100%;
			border-collapse: collapse;
			font-family: var(--font-mono);
			font-size: 12px;
			text-align: left;
		}

		thead {
			position: sticky;
			top: 0;
			background-color: var(--header-bg);
			z-index: 2;
			border-bottom: 2px solid var(--border-color);
		}

		th {
			padding: 8px 12px;
			font-weight: 600;
			color: var(--vscode-editorHeader-foreground, #bbbbbb);
			white-space: nowrap;
			border-bottom: 1px solid var(--border-color);
		}

		tbody tr {
			height: 28px;
			box-sizing: border-box;
		}

		td {
			padding: 4px 12px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.05);
			white-space: nowrap;
			height: 28px;
			box-sizing: border-box;
		}

		tbody tr:nth-child(even) {
			background-color: var(--row-alt-bg);
		}

		tbody tr:hover {
			background-color: var(--row-hover-bg);
		}

		.col-index { width: 70px; color: var(--vscode-descriptionForeground, #888); }
		.col-time { width: 220px; }
		.col-price { width: 100px; font-weight: 600; }
		.col-qty { width: 90px; }
		.col-side { width: 80px; text-align: center; }
		.col-volume { width: 90px; text-align: right; }

		.badge {
			display: inline-block;
			padding: 2px 6px;
			border-radius: 3px;
			font-size: 10px;
			font-weight: bold;
			text-align: center;
			letter-spacing: 0.5px;
		}

		.badge-buy {
			background-color: var(--badge-buy-bg);
			color: var(--badge-buy-fg);
			border: 1px solid var(--badge-buy-fg);
		}

		.badge-sell {
			background-color: var(--badge-sell-bg);
			color: var(--badge-sell-fg);
			border: 1px solid var(--badge-sell-fg);
		}

		.badge-neutral {
			background-color: var(--badge-neutral-bg);
			color: var(--badge-neutral-fg);
			border: 1px solid var(--badge-neutral-fg);
		}

		.empty-cell {
			text-align: center;
			padding: 40px;
			color: var(--vscode-descriptionForeground, #888888);
			font-style: italic;
		}

		#spacerTop td, #spacerBottom td {
			padding: 0 !important;
			border: none !important;
			background: transparent !important;
			height: inherit;
		}

		.skeleton-cell {
			background: linear-gradient(90deg, rgba(255, 255, 255, 0.03) 25%, rgba(255, 255, 255, 0.08) 50%, rgba(255, 255, 255, 0.03) 75%);
			background-size: 200% 100%;
			animation: shimmer 1.5s infinite;
			color: rgba(255, 255, 255, 0.2);
		}

		.skeleton-bar {
			display: inline-block;
			height: 12px;
			background-color: rgba(255, 255, 255, 0.08);
			border-radius: 2px;
		}

		@keyframes shimmer {
			0% { background-position: -200% 0; }
			100% { background-position: 200% 0; }
		}

		/* Floating Follow Pill */
		.floating-follow-pill {
			position: fixed;
			bottom: 24px;
			right: 24px;
			z-index: 100;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 16px;
			border-radius: 20px;
			background-color: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #ffffff);
			border: 1px solid var(--vscode-button-border, rgba(255, 255, 255, 0.2));
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
			cursor: pointer;
			font-size: 12px;
			font-weight: 600;
			transition: transform 0.15s ease, background-color 0.15s ease, opacity 0.2s ease;
			animation: pillSlideUp 0.25s ease-out;
		}

		.floating-follow-pill:hover {
			background-color: var(--vscode-button-hoverBackground, #1177bb);
			transform: translateY(-2px);
			box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
		}

		.floating-follow-pill:active {
			transform: translateY(0);
		}

		.floating-follow-pill .pill-icon {
			font-size: 14px;
			animation: bounceDown 1.5s infinite;
		}

		@keyframes pillSlideUp {
			from { opacity: 0; transform: translateY(16px); }
			to { opacity: 1; transform: translateY(0); }
		}

		@keyframes bounceDown {
			0%, 100% { transform: translateY(0); }
			50% { transform: translateY(3px); }
		}
	</style>
</head>
<body>
	<div class="header-container">
		<div class="title-row">
			<h1>
				<span>📄</span>
				<span id="headerFileName">${escapeHtml(fileName)}</span>
				<span class="format-tag">SCID Binary</span>
			</h1>
		</div>
		<div class="stats-cards">
			<div class="stat-card">
				<span class="stat-label">Total Trades</span>
				<span class="stat-value" id="statTotalRecords">${totalRecords.toLocaleString()}</span>
			</div>
			<div class="stat-card">
				<span class="stat-label">File Size</span>
				<span class="stat-value" id="statFileSize">${formatFileSize(fileSize)}</span>
			</div>
			<div class="stat-card">
				<span class="stat-label">First Trade</span>
				<span class="stat-value" id="statFirstTime">${escapeHtml(firstTime)}</span>
			</div>
			<div class="stat-card">
				<span class="stat-label">Last Trade</span>
				<span class="stat-value" id="statLastTime">${escapeHtml(lastTime)}</span>
			</div>
		</div>
	</div>

	<div class="toolbar">
		<div class="pagination-group">
			<button id="btnTop" title="Go to beginning of file">⏮ Top</button>
			<button id="btnTail" class="btn-primary" title="Jump to most recent trades">Latest (Tail) ⏭</button>
			<span class="range-indicator" id="rangeIndicator">Loading...</span>
		</div>

		<div class="jump-group">
			<button id="btnLiveTail" title="Toggle real-time live follow mode">Live Tail: OFF</button>
			<button id="btnToggleTime" title="Toggle UTC vs Local Time">Time: UTC</button>
			<label for="jumpIndexInput" style="font-size: 11px; color: var(--vscode-descriptionForeground);">Jump #:</label>
			<input type="number" id="jumpIndexInput" min="0" placeholder="Index">
			<button id="btnGo">Go</button>
		</div>

		<div class="filter-group">
			<label for="filterMinVol" style="font-size: 11px; color: var(--vscode-descriptionForeground);">Min Vol:</label>
			<input type="number" id="filterMinVol" min="0" placeholder="0" style="width: 65px;" title="Filter trades with minimum volume threshold">
			<label for="filterPrice" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 4px;">Price:</label>
			<input type="text" id="filterPrice" placeholder="e.g. 125000, >=125000" style="width: 140px;" title="Filter by price (number, >=, <=, >, <)">
			<button id="btnClearFilters" title="Clear search and volume filters">Clear</button>
		</div>
	</div>

	<div class="table-wrapper" id="tableWrapper">
		<table>
			<thead>
				<tr>
					<th class="col-index">#</th>
					<th class="col-time" id="thTime">Time (UTC)</th>
					<th class="col-price">Price</th>
					<th class="col-qty">Quantity</th>
					<th class="col-side">Side</th>
					<th class="col-volume">Bid Vol</th>
					<th class="col-volume">Ask Vol</th>
				</tr>
			</thead>
			<tbody id="tableBody">
				<tr id="spacerTop" style="height: ${initialSpacers.topSpacerHeight}px;"><td colspan="7"></td></tr>
				${rowsHtml}
				<tr id="spacerBottom" style="height: ${initialSpacers.bottomSpacerHeight}px;"><td colspan="7"></td></tr>
			</tbody>
		</table>
		<button id="floatingFollowPill" class="floating-follow-pill" style="display: none;" title="Resume Live Tail follow mode">
			<span class="pill-icon">↓</span>
			<span id="pillText">0 new trades — Resume Live Tail</span>
		</button>
	</div>

	<script>
		(function() {
			const vscode = acquireVsCodeApi();
			const ROW_HEIGHT = 28;
			const MAX_CONTAINER_HEIGHT = 5000000;
			const OVERSCAN_ROWS = 15;
			const CHUNK_SIZE = 500;
			const MAX_CACHED_CHUNKS = 20;
			const PREFETCH_MARGIN = 250;

			let state = {
				totalRecords: ${totalRecords},
				timeMode: 'UTC',
				liveTail: false,
				isFollowing: false,
				unreadCount: 0,
				minVolume: 0,
				priceFilterOp: null,
				priceFilterVal: null
			};

			class WebviewChunkCache {
				constructor(maxChunks = MAX_CACHED_CHUNKS, chunkSize = CHUNK_SIZE) {
					this.maxChunks = maxChunks;
					this.chunkSize = chunkSize;
					this.chunks = new Map();
				}
				get size() { return this.chunks.size; }
				has(chunkIndex) { return this.chunks.has(chunkIndex); }
				get(chunkIndex) {
					const chunk = this.chunks.get(chunkIndex);
					if (chunk === undefined) return undefined;
					this.chunks.delete(chunkIndex);
					this.chunks.set(chunkIndex, chunk);
					return chunk;
				}
				put(chunkIndex, records) {
					if (this.chunks.has(chunkIndex)) {
						this.chunks.delete(chunkIndex);
					} else if (this.chunks.size >= this.maxChunks) {
						const oldestKey = this.chunks.keys().next().value;
						if (oldestKey !== undefined) this.chunks.delete(oldestKey);
					}
					this.chunks.set(chunkIndex, records);
				}
				getSlice(startIndex, count) {
					const records = [];
					const missing = new Set();
					for (let i = 0; i < count; i++) {
						const idx = startIndex + i;
						const cIdx = Math.floor(idx / this.chunkSize);
						const chunk = this.get(cIdx);
						if (!chunk) {
							missing.add(cIdx);
							records.push(undefined);
						} else {
							const offset = idx - cIdx * this.chunkSize;
							records.push(chunk[offset]);
						}
					}
					return { records, missingChunkIndices: Array.from(missing) };
				}
				clear() { this.chunks.clear(); }
			}

			function calculatePrefetchChunkIndices(startIndex, count, totalRecords) {
				if (totalRecords <= 0 || count <= 0) return { visibleChunkIndices: [], prefetchChunkIndices: [] };
				const maxIndex = totalRecords - 1;
				const clampedStart = Math.max(0, Math.min(maxIndex, startIndex));
				const clampedEnd = Math.max(0, Math.min(maxIndex, startIndex + count - 1));
				const startChunk = Math.floor(clampedStart / CHUNK_SIZE);
				const endChunk = Math.floor(clampedEnd / CHUNK_SIZE);
				const visibleChunkIndices = [];
				for (let c = startChunk; c <= endChunk; c++) visibleChunkIndices.push(c);
				const prefetchChunkIndices = [];
				if (clampedStart > 0) {
					const backwardIndex = Math.max(0, clampedStart - PREFETCH_MARGIN);
					const backwardChunk = Math.floor(backwardIndex / CHUNK_SIZE);
					if (backwardChunk < startChunk) prefetchChunkIndices.push(backwardChunk);
				}
				if (clampedEnd < maxIndex) {
					const forwardIndex = Math.min(maxIndex, clampedEnd + PREFETCH_MARGIN);
					const forwardChunk = Math.floor(forwardIndex / CHUNK_SIZE);
					if (forwardChunk > endChunk) prefetchChunkIndices.push(forwardChunk);
				}
				return { visibleChunkIndices, prefetchChunkIndices };
			}

			const cache = new WebviewChunkCache();
			const inFlightChunks = new Set();

			function requestChunk(chunkIndex) {
				if (cache.has(chunkIndex) || inFlightChunks.has(chunkIndex)) return;
				inFlightChunks.add(chunkIndex);
				vscode.postMessage({
					type: 'REQUEST_PAGE',
					offsetIndex: chunkIndex * CHUNK_SIZE,
					pageSize: CHUNK_SIZE
				});
			}

			// DOM Elements
			const btnTop = document.getElementById('btnTop');
			const btnTail = document.getElementById('btnTail');
			const btnGo = document.getElementById('btnGo');
			const btnLiveTail = document.getElementById('btnLiveTail');
			const btnToggleTime = document.getElementById('btnToggleTime');
			const jumpIndexInput = document.getElementById('jumpIndexInput');
			const rangeIndicator = document.getElementById('rangeIndicator');
			const filterMinVol = document.getElementById('filterMinVol');
			const filterPrice = document.getElementById('filterPrice');
			const btnClearFilters = document.getElementById('btnClearFilters');
			const tableBody = document.getElementById('tableBody');
			const tableWrapper = document.getElementById('tableWrapper');
			const thTime = document.getElementById('thTime');
			const statTotalRecords = document.getElementById('statTotalRecords');
			const statFileSize = document.getElementById('statFileSize');
			const statLastTime = document.getElementById('statLastTime');
			const floatingFollowPill = document.getElementById('floatingFollowPill');
			const pillText = document.getElementById('pillText');

			function formatBytes(bytes) {
				if (bytes < 1024) return bytes + ' B';
				if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
				if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
				return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
			}

			function updateLiveTailButton() {
				if (state.liveTail) {
					btnLiveTail.classList.add('btn-live-active');
					btnLiveTail.innerHTML = '<span class="pulse-dot"></span>Live Tail: ON';
				} else {
					btnLiveTail.classList.remove('btn-live-active');
					btnLiveTail.textContent = 'Live Tail: OFF';
				}
			}

			const FOLLOW_THRESHOLD_PX = 50;

			function updateFollowPill() {
				if (!floatingFollowPill || !pillText) return;
				if (state.liveTail && !state.isFollowing && state.unreadCount > 0) {
					pillText.textContent = '↓ ' + state.unreadCount.toLocaleString() + ' new trades — Resume Live Tail';
					floatingFollowPill.style.display = 'flex';
				} else {
					floatingFollowPill.style.display = 'none';
				}
			}

			function checkFollowScroll() {
				if (!state.liveTail) return;
				const maxScroll = tableWrapper.scrollHeight - tableWrapper.clientHeight;
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

			function scrollToBottom() {
				const viewportHeight = tableWrapper.clientHeight || 600;
				const metrics = calculateVirtualMetrics(state.totalRecords);
				tableWrapper.scrollTop = Math.max(0, metrics.totalVirtualHeight - viewportHeight);
				renderVirtualWindow();
				tableWrapper.scrollTop = tableWrapper.scrollHeight;
				requestAnimationFrame(() => {
					tableWrapper.scrollTop = tableWrapper.scrollHeight;
				});
			}

			function disableLiveTailIfActive() {
				if (state.liveTail) {
					state.liveTail = false;
					state.isFollowing = false;
					state.unreadCount = 0;
					updateLiveTailButton();
					updateFollowPill();
					vscode.postMessage({
						type: 'TOGGLE_LIVE_TAIL',
						enabled: false
					});
				}
			}

			function calculateVirtualMetrics(totalRecords) {
				const rawHeight = totalRecords * ROW_HEIGHT;
				if (rawHeight <= MAX_CONTAINER_HEIGHT) {
					return { totalVirtualHeight: rawHeight, isScaled: false, scaleRatio: 1 };
				}
				return {
					totalVirtualHeight: MAX_CONTAINER_HEIGHT,
					isScaled: true,
					scaleRatio: MAX_CONTAINER_HEIGHT / rawHeight
				};
			}

			function scrollTopToIndex(scrollTop, viewportHeight, totalRecords) {
				if (totalRecords <= 0) return 0;
				const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
				const maxStartIndex = Math.max(0, totalRecords - visibleRows);
				const metrics = calculateVirtualMetrics(totalRecords);
				const maxScrollTop = Math.max(1, metrics.totalVirtualHeight - viewportHeight);
				const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop));
				if (!metrics.isScaled) {
					return Math.min(maxStartIndex, Math.floor(clampedScrollTop / ROW_HEIGHT));
				}
				return Math.min(maxStartIndex, Math.round((clampedScrollTop / maxScrollTop) * maxStartIndex));
			}

			function indexToScrollTop(index, viewportHeight, totalRecords) {
				if (totalRecords <= 0) return 0;
				const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
				const maxStartIndex = Math.max(0, totalRecords - visibleRows);
				const clampedIndex = Math.max(0, Math.min(maxStartIndex, index));
				const metrics = calculateVirtualMetrics(totalRecords);
				const maxScrollTop = Math.max(0, metrics.totalVirtualHeight - viewportHeight);
				if (!metrics.isScaled) {
					return clampedIndex * ROW_HEIGHT;
				}
				return maxStartIndex === 0 ? 0 : Math.round((clampedIndex / maxStartIndex) * maxScrollTop);
			}

			function calculateSpacerHeights(startIndex, renderedCount, totalRecords) {
				const metrics = calculateVirtualMetrics(totalRecords);
				if (!metrics.isScaled) {
					const topSpacerHeight = startIndex * ROW_HEIGHT;
					const remaining = Math.max(0, totalRecords - (startIndex + renderedCount));
					const bottomSpacerHeight = remaining * ROW_HEIGHT;
					return { topSpacerHeight, bottomSpacerHeight };
				}
				const topSpacerHeight = Math.round(startIndex * ROW_HEIGHT * metrics.scaleRatio);
				const remaining = Math.max(0, totalRecords - (startIndex + renderedCount));
				const bottomSpacerHeight = Math.max(0, Math.round(remaining * ROW_HEIGHT * metrics.scaleRatio));
				return { topSpacerHeight, bottomSpacerHeight };
			}

			function renderSkeletonRows(startIndex, count) {
				let rows = '';
				for (let i = 0; i < count; i++) {
					const idx = startIndex + i;
					rows += '<tr>' +
						'<td class="col-index">#' + idx.toLocaleString() + '</td>' +
						'<td class="col-time skeleton-cell"><span class="skeleton-bar" style="width: 140px;"></span></td>' +
						'<td class="col-price skeleton-cell"><span class="skeleton-bar" style="width: 60px;"></span></td>' +
						'<td class="col-qty skeleton-cell"><span class="skeleton-bar" style="width: 40px;"></span></td>' +
						'<td class="col-side skeleton-cell"><span class="skeleton-bar" style="width: 30px;"></span></td>' +
						'<td class="col-volume skeleton-cell"><span class="skeleton-bar" style="width: 50px;"></span></td>' +
						'<td class="col-volume skeleton-cell"><span class="skeleton-bar" style="width: 50px;"></span></td>' +
					'</tr>';
				}
				return rows;
			}

			function parsePriceFilter(raw) {
				if (!raw || !raw.trim()) {
					state.priceFilterOp = null;
					state.priceFilterVal = null;
					return;
				}
				const trimmed = raw.trim();
				const match = trimmed.match(/^([><]=?|=)?\\s*([0-9]+(?:\\.[0-9]+)?)$/);
				if (match) {
					state.priceFilterOp = match[1] || '=';
					state.priceFilterVal = parseFloat(match[2]);
				} else {
					state.priceFilterOp = null;
					state.priceFilterVal = null;
				}
			}

			function matchesFilter(rec) {
				if (state.minVolume > 0 && rec.totalVolume < state.minVolume) {
					return false;
				}
				if (state.priceFilterVal !== null) {
					const price = typeof rec.price === 'number' ? rec.price : (rec.close || 0);
					const target = state.priceFilterVal;
					switch (state.priceFilterOp) {
						case '>=': if (!(price >= target)) return false; break;
						case '<=': if (!(price <= target)) return false; break;
						case '>':  if (!(price > target)) return false; break;
						case '<':  if (!(price < target)) return false; break;
						case '=':
						default:
							if (Math.abs(price - target) > 0.001) return false;
							break;
					}
				}
				return true;
			}

			function renderRecordRow(rec) {
				const sideClass = rec.side === 'BUY' ? 'badge-buy' : rec.side === 'SELL' ? 'badge-sell' : 'badge-neutral';
				const isLocal = state.timeMode === 'LOCAL';
				const timeStr = isLocal ? (rec.localFormatted || rec.isoUtc) : rec.isoUtc;
				const priceVal = typeof rec.price === 'number' ? rec.price : (rec.close || 0);
				return '<tr>' +
					'<td class="col-index">' + rec.index.toLocaleString() + '</td>' +
					'<td class="col-time">' + escapeHtml(timeStr) + '</td>' +
					'<td class="col-price">' + priceVal.toFixed(2) + '</td>' +
					'<td class="col-qty">' + rec.totalVolume.toLocaleString() + '</td>' +
					'<td class="col-side"><span class="badge ' + sideClass + '">' + rec.side + '</span></td>' +
					'<td class="col-volume">' + rec.bidVolume.toLocaleString() + '</td>' +
					'<td class="col-volume">' + rec.askVolume.toLocaleString() + '</td>' +
				'</tr>';
			}

			function renderVirtualWindow() {
				if (state.totalRecords === 0) {
					tableBody.innerHTML =
						'<tr id="spacerTop" style="height: 0px;"><td colspan="7"></td></tr>' +
						'<tr><td colspan="7" class="empty-cell">No records available</td></tr>' +
						'<tr id="spacerBottom" style="height: 0px;"><td colspan="7"></td></tr>';
					rangeIndicator.textContent = 'Showing 0 of 0';
					return;
				}

				const viewportHeight = tableWrapper.clientHeight || 600;
				let scrollTop = tableWrapper.scrollTop;
				if (state.liveTail && state.isFollowing) {
					const metrics = calculateVirtualMetrics(state.totalRecords);
					scrollTop = Math.max(0, metrics.totalVirtualHeight - viewportHeight);
				}
				const firstVisible = scrollTopToIndex(scrollTop, viewportHeight, state.totalRecords);
				const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);
				const startIndex = Math.max(0, firstVisible - OVERSCAN_ROWS);
				const endIndex = Math.min(state.totalRecords, firstVisible + visibleCount + OVERSCAN_ROWS);
				const renderedCount = Math.max(0, endIndex - startIndex);

				const spacers = calculateSpacerHeights(startIndex, renderedCount, state.totalRecords);

				// Retrieve visible slice from LRU cache
				const slice = cache.getSlice(startIndex, renderedCount);

				// Dispatch immediate request for missing visible chunks
				for (let i = 0; i < slice.missingChunkIndices.length; i++) {
					requestChunk(slice.missingChunkIndices[i]);
				}

				// Dispatch predictive prefetch requests within 250 records
				const prefetch = calculatePrefetchChunkIndices(startIndex, renderedCount, state.totalRecords);
				for (let i = 0; i < prefetch.prefetchChunkIndices.length; i++) {
					requestChunk(prefetch.prefetchChunkIndices[i]);
				}

				let rowsHtml = '';
				const isFiltered = state.minVolume > 0 || state.priceFilterVal !== null;
				let matchCount = 0;

				for (let i = 0; i < slice.records.length; i++) {
					const rec = slice.records[i];
					const rowIdx = startIndex + i;
					if (rec === undefined) {
						rowsHtml += renderSkeletonRows(rowIdx, 1);
					} else if (!isFiltered || matchesFilter(rec)) {
						rowsHtml += renderRecordRow(rec);
						matchCount++;
					}
				}

				if (rowsHtml === '' && isFiltered) {
					rowsHtml = '<tr><td colspan="7" class="empty-cell">No matching records</td></tr>';
				}

				tableBody.innerHTML =
					'<tr id="spacerTop" style="height: ' + spacers.topSpacerHeight + 'px;"><td colspan="7"></td></tr>' +
					rowsHtml +
					'<tr id="spacerBottom" style="height: ' + spacers.bottomSpacerHeight + 'px;"><td colspan="7"></td></tr>';

				if (state.liveTail && state.isFollowing) {
					tableWrapper.scrollTop = tableWrapper.scrollHeight;
				}

				const dispStart = state.totalRecords === 0 ? 0 : startIndex + 1;
				if (isFiltered) {
					rangeIndicator.textContent =
						'Filtered: ' + matchCount.toLocaleString() + ' matching of ' + renderedCount.toLocaleString() + ' visible in window';
				} else {
					rangeIndicator.textContent =
						'Showing ' + dispStart.toLocaleString() + ' - ' + endIndex.toLocaleString() + ' of ' + state.totalRecords.toLocaleString();
				}
			}

			let scrollRafId = null;
			tableWrapper.addEventListener('scroll', () => {
				checkFollowScroll();
				if (scrollRafId !== null) return;
				scrollRafId = requestAnimationFrame(() => {
					scrollRafId = null;
					renderVirtualWindow();
				});
			});

			btnTop.addEventListener('click', () => {
				disableLiveTailIfActive();
				tableWrapper.scrollTop = 0;
				renderVirtualWindow();
			});

			btnTail.addEventListener('click', () => {
				if (state.liveTail) {
					state.isFollowing = true;
					state.unreadCount = 0;
					updateFollowPill();
				}
				scrollToBottom();
			});

			btnLiveTail.addEventListener('click', () => {
				state.liveTail = !state.liveTail;
				state.isFollowing = state.liveTail;
				state.unreadCount = 0;
				updateLiveTailButton();
				updateFollowPill();
				vscode.postMessage({
					type: 'TOGGLE_LIVE_TAIL',
					enabled: state.liveTail
				});
				if (state.liveTail) {
					scrollToBottom();
				}
			});

			if (floatingFollowPill) {
				floatingFollowPill.addEventListener('click', () => {
					state.isFollowing = true;
					state.unreadCount = 0;
					updateFollowPill();
					scrollToBottom();
				});
			}

			btnToggleTime.addEventListener('click', () => {
				state.timeMode = state.timeMode === 'UTC' ? 'LOCAL' : 'UTC';
				btnToggleTime.textContent = 'Time: ' + state.timeMode;
				thTime.textContent = state.timeMode === 'UTC' ? 'Time (UTC)' : 'Time (Local)';
				renderVirtualWindow();
			});

			filterMinVol.addEventListener('input', () => {
				state.minVolume = parseInt(filterMinVol.value, 10) || 0;
				renderVirtualWindow();
			});

			filterPrice.addEventListener('input', () => {
				parsePriceFilter(filterPrice.value);
				renderVirtualWindow();
			});

			btnClearFilters.addEventListener('click', () => {
				filterMinVol.value = '';
				filterPrice.value = '';
				state.minVolume = 0;
				state.priceFilterOp = null;
				state.priceFilterVal = null;
				renderVirtualWindow();
			});

			btnGo.addEventListener('click', () => {
				disableLiveTailIfActive();
				const target = parseInt(jumpIndexInput.value, 10);
				if (!isNaN(target)) {
					const viewportHeight = tableWrapper.clientHeight || 600;
					const targetScroll = indexToScrollTop(target, viewportHeight, state.totalRecords);
					tableWrapper.scrollTop = targetScroll;
					renderVirtualWindow();
				}
			});

			jumpIndexInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					btnGo.click();
				}
			});

			window.addEventListener('message', (event) => {
				const msg = event.data;
				if (!msg) return;

				if (msg.type === 'PAGE_DATA' || msg.type === 'INIT') {
					if (msg.totalRecords !== undefined) {
						state.totalRecords = msg.totalRecords;
					} else if (msg.summary && msg.summary.totalRecords !== undefined) {
						state.totalRecords = msg.summary.totalRecords;
					}

					if (msg.records && msg.records.length > 0) {
						const baseOffset = msg.offsetIndex;
						let currentOffset = baseOffset;
						while (currentOffset < baseOffset + msg.records.length) {
							const chunkIdx = Math.floor(currentOffset / CHUNK_SIZE);
							const chunkStartInRecords = currentOffset - baseOffset;
							const chunkEndInRecords = Math.min(msg.records.length, chunkStartInRecords + CHUNK_SIZE);
							const chunkRecords = msg.records.slice(chunkStartInRecords, chunkEndInRecords);
							cache.put(chunkIdx, chunkRecords);
							inFlightChunks.delete(chunkIdx);
							currentOffset += CHUNK_SIZE;
						}
					}
					renderVirtualWindow();
				} else if (msg.type === 'APPEND_RECORDS') {
					state.totalRecords = msg.totalRecords;
					if (statTotalRecords) statTotalRecords.textContent = msg.totalRecords.toLocaleString();
					if (msg.fileSize && statFileSize) statFileSize.textContent = formatBytes(msg.fileSize);
					if (msg.lastRecordIsoUtc && statLastTime) statLastTime.textContent = msg.lastRecordIsoUtc;

					if (msg.records && msg.records.length > 0) {
						for (let i = 0; i < msg.records.length; i++) {
							const rec = msg.records[i];
							const cIdx = Math.floor(rec.index / CHUNK_SIZE);
							const existing = cache.get(cIdx);
							if (existing) {
								const updated = existing.slice();
								const offsetInChunk = rec.index - cIdx * CHUNK_SIZE;
								updated[offsetInChunk] = rec;
								cache.put(cIdx, updated);
							} else {
								cache.put(cIdx, [rec]);
							}
						}
					}

					if (state.liveTail) {
						if (state.isFollowing) {
							scrollToBottom();
						} else {
							const incomingCount = msg.records ? msg.records.length : 0;
							const isFiltered = state.minVolume > 0 || state.priceFilterVal !== null;
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
			});

			function escapeHtml(s) {
				return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
			}

			// Initial state hydration & render
			const initial = ${initialJson};
			if (initial) {
				state.totalRecords = initial.summary ? initial.summary.totalRecords : 0;
				if (initial.records && initial.records.length > 0) {
					const baseOffset = initial.offsetIndex;
					let currentOffset = baseOffset;
					while (currentOffset < baseOffset + initial.records.length) {
						const chunkIdx = Math.floor(currentOffset / CHUNK_SIZE);
						const chunkStartInRecords = currentOffset - baseOffset;
						const chunkEndInRecords = Math.min(initial.records.length, chunkStartInRecords + CHUNK_SIZE);
						const chunkRecords = initial.records.slice(chunkStartInRecords, chunkEndInRecords);
						cache.put(chunkIdx, chunkRecords);
						currentOffset += CHUNK_SIZE;
					}
				}
				if (state.totalRecords > 0) {
					scrollToBottom();
				} else {
					renderVirtualWindow();
				}
			} else {
				renderVirtualWindow();
			}
		})();
	</script>
</body>
</html>`;
};
