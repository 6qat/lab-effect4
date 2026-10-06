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
): string => {
	if (records.length === 0) {
		return `<tr><td colspan="7" class="empty-cell">No records available</td></tr>`;
	}

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
			return `<tr>
				<td class="col-index">${rec.index.toLocaleString()}</td>
				<td class="col-time">${escapeHtml(rec.isoUtc)}</td>
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
	const rowsHtml = renderTableRows(records);

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
			transition: background 0.15s;
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

		input[type="number"], select {
			background-color: var(--vscode-input-background, #3c3c3c);
			color: var(--vscode-input-foreground, #cccccc);
			border: 1px solid var(--vscode-input-border, #555555);
			border-radius: 3px;
			padding: 4px 6px;
			font-size: 12px;
			font-family: var(--font-mono);
		}

		input[type="number"] {
			width: 90px;
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
			<label for="jumpIndexInput" style="font-size: 11px; color: var(--vscode-descriptionForeground);">Jump to #:</label>
			<input type="number" id="jumpIndexInput" min="0" placeholder="Index">
			<button id="btnGo">Go</button>
			<label for="pageSizeSelect" style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 8px;">Page Size:</label>
			<select id="pageSizeSelect">
				<option value="100">100</option>
				<option value="250">250</option>
				<option value="500" selected>500</option>
				<option value="1000">1000</option>
			</select>
			<button id="btnTail" class="btn-primary" title="Jump to most recent trades" style="margin-left: 8px;">Latest Trades (Tail)</button>
		</div>
	</div>

	<div class="table-wrapper" id="tableWrapper">
		<table>
			<thead>
				<tr>
					<th class="col-index">#</th>
					<th class="col-time">Time (UTC)</th>
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
				totalRecords: ${totalRecords}
			};

			const initial = ${initialJson};
			if (initial) {
				state.offsetIndex = initial.offsetIndex;
				state.pageSize = initial.pageSize;
				state.totalRecords = initial.summary.totalRecords;
				updateControls();
			}

			// DOM Elements
			const btnFirst = document.getElementById('btnFirst');
			const btnPrev = document.getElementById('btnPrev');
			const btnNext = document.getElementById('btnNext');
			const btnLast = document.getElementById('btnLast');
			const btnGo = document.getElementById('btnGo');
			const btnTail = document.getElementById('btnTail');
			const jumpIndexInput = document.getElementById('jumpIndexInput');
			const pageSizeSelect = document.getElementById('pageSizeSelect');
			const rangeIndicator = document.getElementById('rangeIndicator');
			const tableBody = document.getElementById('tableBody');
			const tableWrapper = document.getElementById('tableWrapper');

			pageSizeSelect.value = String(state.pageSize);

			function updateControls() {
				const start = state.totalRecords === 0 ? 0 : state.offsetIndex + 1;
				const end = Math.min(state.totalRecords, state.offsetIndex + state.pageSize);
				rangeIndicator.textContent = \`Showing \${start.toLocaleString()} - \${end.toLocaleString()} of \${state.totalRecords.toLocaleString()}\`;

				btnFirst.disabled = state.offsetIndex <= 0;
				btnPrev.disabled = state.offsetIndex <= 0;
				btnNext.disabled = state.offsetIndex + state.pageSize >= state.totalRecords;
				btnLast.disabled = state.offsetIndex + state.pageSize >= state.totalRecords;
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

			btnFirst.addEventListener('click', () => requestPage(0));
			btnPrev.addEventListener('click', () => requestPage(state.offsetIndex - state.pageSize));
			btnNext.addEventListener('click', () => requestPage(state.offsetIndex + state.pageSize));
			btnLast.addEventListener('click', () => {
				const lastOffset = Math.max(0, state.totalRecords - state.pageSize);
				requestPage(lastOffset);
			});
			btnTail.addEventListener('click', () => {
				const lastOffset = Math.max(0, state.totalRecords - state.pageSize);
				requestPage(lastOffset);
			});

			btnGo.addEventListener('click', () => {
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

					renderRows(msg.records);
					updateControls();
					tableWrapper.scrollTop = 0;
				}
			});

			function renderRows(records) {
				if (!records || records.length === 0) {
					tableBody.innerHTML = '<tr><td colspan="7" class="empty-cell">No records in this window</td></tr>';
					return;
				}

				let html = '';
				for (const rec of records) {
					const sideClass = rec.side === 'BUY' ? 'badge-buy' : rec.side === 'SELL' ? 'badge-sell' : 'badge-neutral';
					html += \`<tr>
						<td class="col-index">\${rec.index.toLocaleString()}</td>
						<td class="col-time">\${escape(rec.isoUtc)}</td>
						<td class="col-price">\${rec.price.toFixed(2)}</td>
						<td class="col-qty">\${rec.totalVolume.toLocaleString()}</td>
						<td class="col-side"><span class="badge \${sideClass}">\${rec.side}</span></td>
						<td class="col-volume">\${rec.bidVolume.toLocaleString()}</td>
						<td class="col-volume">\${rec.askVolume.toLocaleString()}</td>
					</tr>\`;
				}
				tableBody.innerHTML = html;
			}

			function escape(s) {
				return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
			}
		})();
	</script>
</body>
</html>`;
};
