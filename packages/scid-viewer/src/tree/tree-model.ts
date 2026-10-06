import * as path from "node:path";

export interface ParsedScidFile {
	readonly fsPath: string;
	readonly fileName: string;
	readonly ticker: string;
	readonly session: string;
}

export const parseScidFileInfo = (fsPath: string): ParsedScidFile => {
	const fileName = path.basename(fsPath);
	const baseName = fileName.replace(/\.scid$/i, "");
	const match = baseName.match(/^([A-Za-z0-9]+?)(?:[-_](\d{4}-\d{2}-\d{2}))?$/);

	if (match?.[1]) {
		return {
			fsPath,
			fileName,
			ticker: match[1].toUpperCase(),
			session: match[2] ?? "Continuous",
		};
	}

	return {
		fsPath,
		fileName,
		ticker: "OTHER",
		session: baseName,
	};
};

export const groupFilesByTicker = (
	files: ReadonlyArray<ParsedScidFile>,
): Map<string, ParsedScidFile[]> => {
	const map = new Map<string, ParsedScidFile[]>();
	for (const file of files) {
		const existing = map.get(file.ticker);
		if (existing) {
			existing.push(file);
		} else {
			map.set(file.ticker, [file]);
		}
	}
	// Sort files inside each ticker by session descending (latest dates first)
	for (const list of map.values()) {
		list.sort((a, b) => b.session.localeCompare(a.session));
	}
	return map;
};

export const formatTradeCountBadge = (count?: number): string => {
	if (typeof count === "number") {
		return `${count.toLocaleString()} trades`;
	}
	return "0 trades";
};
