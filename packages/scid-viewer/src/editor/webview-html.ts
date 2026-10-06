import type { FormattedScidRecord } from "../reader/scid-reader.js";
import type { InitMessage } from "./protocol.js";

export const formatFileSize = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

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
	const pageSize = initialData?.pageSize ?? 500;
	const records = initialData?.records ?? [];
	const rowsHtml = renderTableRows(records, "UTC");

	const initialJson = initialData ? JSON.stringify(initialData) : "null";

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

		td {
			padding: 5px 12px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.05);
			white-space: nowrap;
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
			<button id="btnFirst" title="Go to first records">⏮ First</button>
			<button id="btnPrev" title="Previous page">◀ Prev</button>
			<span class="range-indicator" id="rangeIndicator">Loading...</span>
			<button id="btnNext" title="Next page">Next ▶</button>
			<button id="btnLast" title="Go to last records">Last ⏭</button>
		</div>

		<div class="jump-group">
			<button id="btnLiveTail" title="Toggle real-time live follow mode">Live Tail: OFF</button>
			<button id="btnToggleTime" title="Toggle UTC vs Local Time">Time: UTC</button>
			<label for="jumpIndexInput" style="font-size: 11px; color: var(--vscode-descriptionForeground);">Jump #:</label>
			<input type="number" id="jumpIndexInput" min="0" placeholder="Index">
			<button id="btnGo">Go</button>
			<label for="pageSizeSelect" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 4px;">Page:</label>
			<select id="pageSizeSelect">
				<option value="100">100</option>
				<option value="250">250</option>
				<option value="500" selected>500</option>
				<option value="1000">1000</option>
			</select>
			<button id="btnTail" class="btn-primary" title="Jump to most recent trades" style="margin-left: 4px;">Latest (Tail)</button>
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
				${rowsHtml}
			</tbody>
		</table>
	</div>

	<script>
		(function() {
			const vscode = acquireVsCodeApi();
			let state = {
				offsetIndex: ${offsetIndex},
				pageSize: ${pageSize},
				totalRecords: ${totalRecords},
				timeMode: 'UTC',
				liveTail: false,
				minVolume: 0,
				priceFilterOp: null,
				priceFilterVal: null,
				records: []
			};

			const initial = ${initialJson};
			if (initial) {
				state.offsetIndex = initial.offsetIndex;
				state.pageSize = initial.pageSize;
				state.totalRecords = initial.summary.totalRecords;
				state.records = initial.records ? initial.records.slice() : [];
				updateControls();
			}

			// DOM Elements
			const btnFirst = document.getElementById('btnFirst');
			const btnPrev = document.getElementById('btnPrev');
			const btnNext = document.getElementById('btnNext');
			const btnLast = document.getElementById('btnLast');
			const btnGo = document.getElementById('btnGo');
			const btnTail = document.getElementById('btnTail');
			const btnLiveTail = document.getElementById('btnLiveTail');
			const btnToggleTime = document.getElementById('btnToggleTime');
			const jumpIndexInput = document.getElementById('jumpIndexInput');
			const pageSizeSelect = document.getElementById('pageSizeSelect');
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

			pageSizeSelect.value = String(state.pageSize);

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

			function disableLiveTailIfActive() {
				if (state.liveTail) {
					state.liveTail = false;
					updateLiveTailButton();
					vscode.postMessage({
						type: 'TOGGLE_LIVE_TAIL',
						enabled: false
					});
				}
			}

			function updateControls() {
				const start = state.totalRecords === 0 ? 0 : state.offsetIndex + 1;
				const end = Math.min(state.totalRecords, state.offsetIndex + state.pageSize);
				rangeIndicator.textContent = \`Showing \${start.toLocaleString()} - \${end.toLocaleString()} of \${state.totalRecords.toLocaleString()}\`;

				btnFirst.disabled = state.offsetIndex <= 0;
				btnPrev.disabled = state.offsetIndex <= 0;
				btnNext.disabled = state.offsetIndex + state.pageSize >= state.totalRecords;
				btnLast.disabled = state.offsetIndex + state.pageSize >= state.totalRecords;
			}

			function parsePriceFilter(raw) {
				if (!raw || !raw.trim()) {
					state.priceFilterOp = null;
					state.priceFilterVal = null;
					return;
				}
				const trimmed = raw.trim();
				const match = trimmed.match(/^([><]=?|=)?s*([0-9]+(?:\\.[0-9]+)?)$/);
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

			function renderRows() {
				const isFiltered = state.minVolume > 0 || state.priceFilterVal !== null;
				const visible = isFiltered ? state.records.filter(matchesFilter) : state.records;

				if (visible.length === 0) {
					tableBody.innerHTML = '<tr><td colspan="7" class="empty-cell">No matching records</td></tr>';
					if (isFiltered) {
						rangeIndicator.textContent = \`Filtered: 0 matching of \${state.records.length.toLocaleString()}\`;
					} else {
						updateControls();
					}
					return;
				}

				let html = '';
				const isLocal = state.timeMode === 'LOCAL';
				for (const rec of visible) {
					const sideClass = rec.side === 'BUY' ? 'badge-buy' : rec.side === 'SELL' ? 'badge-sell' : 'badge-neutral';
					const timeStr = isLocal ? (rec.localFormatted || rec.isoUtc) : rec.isoUtc;
					const priceVal = typeof rec.price === 'number' ? rec.price : (rec.close || 0);
					html += \`<tr>
						<td class="col-index">\${rec.index.toLocaleString()}</td>
						<td class="col-time">\${escape(timeStr)}</td>
						<td class="col-price">\${priceVal.toFixed(2)}</td>
						<td class="col-qty">\${rec.totalVolume.toLocaleString()}</td>
						<td class="col-side"><span class="badge \${sideClass}">\${rec.side}</span></td>
						<td class="col-volume">\${rec.bidVolume.toLocaleString()}</td>
						<td class="col-volume">\${rec.askVolume.toLocaleString()}</td>
					</tr>\`;
				}
				tableBody.innerHTML = html;

				if (isFiltered) {
					rangeIndicator.textContent = \`Filtered: \${visible.length.toLocaleString()} matching of \${state.records.length.toLocaleString()}\`;
				} else {
					updateControls();
				}
			}

			function requestPage(newOffset) {
				const clampedOffset = Math.max(0, Math.min(Math.max(0, state.totalRecords - state.pageSize), newOffset));
				state.offsetIndex = clampedOffset;
				vscode.postMessage({
					type: 'REQUEST_PAGE',
					offsetIndex: clampedOffset,
					pageSize: state.pageSize
				});
				rangeIndicator.textContent = 'Loading...';
				btnFirst.disabled = true;
				btnPrev.disabled = true;
				btnNext.disabled = true;
				btnLast.disabled = true;
			}

			btnFirst.addEventListener('click', () => {
				disableLiveTailIfActive();
				requestPage(0);
			});
			btnPrev.addEventListener('click', () => {
				disableLiveTailIfActive();
				requestPage(state.offsetIndex - state.pageSize);
			});
			btnNext.addEventListener('click', () => {
				disableLiveTailIfActive();
				requestPage(state.offsetIndex + state.pageSize);
			});
			btnLast.addEventListener('click', () => {
				disableLiveTailIfActive();
				const lastOffset = Math.max(0, state.totalRecords - state.pageSize);
				requestPage(lastOffset);
			});
			btnTail.addEventListener('click', () => {
				const lastOffset = Math.max(0, state.totalRecords - state.pageSize);
				requestPage(lastOffset);
			});

			btnLiveTail.addEventListener('click', () => {
				state.liveTail = !state.liveTail;
				updateLiveTailButton();
				vscode.postMessage({
					type: 'TOGGLE_LIVE_TAIL',
					enabled: state.liveTail
				});
				if (state.liveTail) {
					const lastOffset = Math.max(0, state.totalRecords - state.pageSize);
					if (state.offsetIndex < lastOffset) {
						requestPage(lastOffset);
					}
				}
			});

			btnToggleTime.addEventListener('click', () => {
				state.timeMode = state.timeMode === 'UTC' ? 'LOCAL' : 'UTC';
				btnToggleTime.textContent = 'Time: ' + state.timeMode;
				thTime.textContent = state.timeMode === 'UTC' ? 'Time (UTC)' : 'Time (Local)';
				renderRows();
			});

			filterMinVol.addEventListener('input', () => {
				state.minVolume = parseInt(filterMinVol.value, 10) || 0;
				renderRows();
			});

			filterPrice.addEventListener('input', () => {
				parsePriceFilter(filterPrice.value);
				renderRows();
			});

			btnClearFilters.addEventListener('click', () => {
				filterMinVol.value = '';
				filterPrice.value = '';
				state.minVolume = 0;
				state.priceFilterOp = null;
				state.priceFilterVal = null;
				renderRows();
			});

			btnGo.addEventListener('click', () => {
				disableLiveTailIfActive();
				const target = parseInt(jumpIndexInput.value, 10);
				if (!isNaN(target)) {
					requestPage(target);
				}
			});

			jumpIndexInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					btnGo.click();
				}
			});

			pageSizeSelect.addEventListener('change', () => {
				state.pageSize = parseInt(pageSizeSelect.value, 10);
				requestPage(state.offsetIndex);
			});

			window.addEventListener('message', (event) => {
				const msg = event.data;
				if (!msg) return;

				if (msg.type === 'PAGE_DATA' || msg.type === 'INIT') {
					state.offsetIndex = msg.offsetIndex;
					state.pageSize = msg.pageSize;
					if (msg.totalRecords !== undefined) {
						state.totalRecords = msg.totalRecords;
					} else if (msg.summary && msg.summary.totalRecords !== undefined) {
						state.totalRecords = msg.summary.totalRecords;
					}

					state.records = msg.records ? msg.records.slice() : [];
					renderRows();
					tableWrapper.scrollTop = 0;
				} else if (msg.type === 'APPEND_RECORDS') {
					state.totalRecords = msg.totalRecords;
					if (statTotalRecords) statTotalRecords.textContent = msg.totalRecords.toLocaleString();
					if (msg.fileSize && statFileSize) statFileSize.textContent = formatBytes(msg.fileSize);
					if (msg.lastRecordIsoUtc && statLastTime) statLastTime.textContent = msg.lastRecordIsoUtc;

					if (state.liveTail && msg.records && msg.records.length > 0) {
						for (const r of msg.records) {
							state.records.push(r);
						}
						if (state.records.length > 1000) {
							state.records = state.records.slice(state.records.length - 1000);
						}
						state.offsetIndex = Math.max(0, state.totalRecords - state.records.length);
						renderRows();
						tableWrapper.scrollTop = tableWrapper.scrollHeight;
					}
				}
			});

			function escape(s) {
				return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
			}
		})();
	</script>
</body>
</html>`;
};
