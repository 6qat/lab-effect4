import type { FormattedScidRecord } from "../reader/scid-reader.js";

export const formatFileSize = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
		return `<div class="table-row empty-row" role="row" colspan="7"><div class="table-cell empty-cell" role="cell">No records available</div></div>`;
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
			return `<div class="table-row" role="row">
				<div class="table-cell col-index" role="cell">${rec.index.toLocaleString()}</div>
				<div class="table-cell col-time" role="cell">${escapeHtml(timeStr)}</div>
				<div class="table-cell col-price" role="cell">${priceVal.toFixed(2)}</div>
				<div class="table-cell col-qty" role="cell">${rec.totalVolume.toLocaleString()}</div>
				<div class="table-cell col-side" role="cell"><span class="badge ${sideClass}">${rec.side}</span></div>
				<div class="table-cell col-volume" role="cell">${rec.bidVolume.toLocaleString()}</div>
				<div class="table-cell col-volume" role="cell">${rec.askVolume.toLocaleString()}</div>
			</div>`;
		})
		.join("\n");
};
