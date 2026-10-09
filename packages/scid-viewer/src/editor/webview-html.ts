import type { InitMessage } from "./protocol.js";
import {
	escapeHtml,
	formatFileSize,
	renderTableRows,
} from "./record-render.js";
import { calculateSpacerHeights } from "./virtual-scroll.js";

export const renderWebviewHtml = (
	fileName: string,
	initialData: InitMessage | undefined,
	/** Webview bundle URI from the esbuild dual-entry build. Required: the viewer has no runtime script fallback. */
	scriptUri: string,
	cspSource?: string,
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
	${cspSource ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; script-src ${cspSource} 'unsafe-inline'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">` : ""}
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

		thead, .table-header-row {
			position: sticky;
			top: 0;
			background-color: var(--header-bg);
			z-index: 2;
			border-bottom: 2px solid var(--border-color);
		}

		.table-header-row {
			display: grid;
			grid-template-columns: 80px 220px 100px 90px 80px 90px 90px;
			height: 34px;
			align-items: center;
		}

		th, .table-header-cell {
			padding: 8px 12px;
			font-weight: 600;
			color: var(--vscode-editorHeader-foreground, #bbbbbb);
			white-space: nowrap;
			border-bottom: 1px solid var(--border-color);
			box-sizing: border-box;
			user-select: none;
		}

		tbody tr, .table-row {
			height: 28px;
			box-sizing: border-box;
		}

		.table-row {
			display: grid;
			grid-template-columns: 80px 220px 100px 90px 80px 90px 90px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.05);
			align-items: center;
		}

		td, .table-cell {
			padding: 4px 12px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.05);
			white-space: nowrap;
			height: 28px;
			box-sizing: border-box;
			display: flex;
			align-items: center;
		}

		tbody tr:nth-child(even), .table-row:nth-child(even) {
			background-color: var(--row-alt-bg);
		}

		tbody tr:hover, .table-row:hover {
			background-color: var(--row-hover-bg);
		}

		.col-index { width: 80px; color: var(--vscode-descriptionForeground, #888); justify-content: flex-start; }
		.col-time { width: 220px; justify-content: flex-start; }
		.col-price { width: 100px; font-weight: 600; justify-content: flex-end; text-align: right; }
		.col-qty { width: 90px; justify-content: flex-end; text-align: right; }
		.col-side { width: 80px; justify-content: center; text-align: center; }
		.col-volume { width: 90px; justify-content: flex-end; text-align: right; }

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

		.empty-row { display: block; width: 100%; }
		.empty-cell {
			text-align: center;
			justify-content: center;
			padding: 40px;
			width: 100%;
			color: var(--vscode-descriptionForeground, #888888);
			font-style: italic;
		}

		.spacer {
			width: 100%;
			flex-shrink: 0;
			background: transparent;
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
		<div class="scid-table" role="table">
			<div class="table-header-row" role="row">
				<div class="table-header-cell col-index" role="columnheader">#</div>
				<div class="table-header-cell col-time" id="thTime" role="columnheader">Time (UTC)</div>
				<div class="table-header-cell col-price" role="columnheader">Price</div>
				<div class="table-header-cell col-qty" role="columnheader">Quantity</div>
				<div class="table-header-cell col-side" role="columnheader">Side</div>
				<div class="table-header-cell col-volume" role="columnheader">Bid Vol</div>
				<div class="table-header-cell col-volume" role="columnheader">Ask Vol</div>
			</div>
			<div id="spacerTop" class="spacer" style="height: ${initialSpacers.topSpacerHeight}px;"></div>
			<div id="tableBody" class="table-body" role="rowgroup">
				${rowsHtml}
			</div>
			<div id="spacerBottom" class="spacer" style="height: ${initialSpacers.bottomSpacerHeight}px;"></div>
		</div>
		<button id="floatingFollowPill" class="floating-follow-pill" style="display: none;" title="Resume Live Tail follow mode">
			<span class="pill-icon">↓</span>
			<span id="pillText">0 new trades — Resume Live Tail</span>
		</button>
	</div>
	<script>
		try {
			var w = document.getElementById('tableWrapper');
			if (w && w.scrollHeight > 0) {
				w.scrollTop = w.scrollHeight;
			}
		} catch (e) {}
	</script>

	<script id="scid-initial-data" type="application/json">${initialJson}</script>
	<script src="${escapeHtml(scriptUri)}"></script>
</body>
</html>`;
};
