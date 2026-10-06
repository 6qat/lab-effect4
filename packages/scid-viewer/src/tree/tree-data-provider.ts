import { Effect } from "effect";
import * as vscode from "vscode";
import type { ScidReaderShape } from "../reader/scid-reader.js";
import {
	formatTradeCountBadge,
	groupFilesByTicker,
	type ParsedScidFile,
	parseScidFileInfo,
} from "./tree-model.js";

export class TickerTreeItem extends vscode.TreeItem {
	constructor(
		public readonly ticker: string,
		public readonly files: ReadonlyArray<ParsedScidFile>,
	) {
		super(ticker, vscode.TreeItemCollapsibleState.Expanded);
		this.contextValue = "ticker";
		this.iconPath = new vscode.ThemeIcon("folder");
		this.description = `${files.length} ${files.length === 1 ? "file" : "files"}`;
	}
}

export class ScidFileTreeItem extends vscode.TreeItem {
	constructor(
		public readonly fileInfo: ParsedScidFile,
		recordCount?: number,
	) {
		super(fileInfo.session, vscode.TreeItemCollapsibleState.None);
		this.contextValue = "scidFile";
		this.iconPath = new vscode.ThemeIcon("file-binary");
		const uri = vscode.Uri.file(fileInfo.fsPath);
		this.resourceUri = uri;
		this.tooltip = `${fileInfo.fileName}\nPath: ${fileInfo.fsPath}`;

		if (typeof recordCount === "number") {
			this.description = formatTradeCountBadge(recordCount);
			this.tooltip += `\nTotal trades: ${recordCount.toLocaleString()}`;
		} else {
			this.description = fileInfo.fileName;
		}

		this.command = {
			command: "vscode.openWith",
			title: "Open SCID File",
			arguments: [uri, "scidViewer.editor"],
		};
	}
}

export type ScidTreeItem = TickerTreeItem | ScidFileTreeItem;

export class ScidTreeDataProvider
	implements vscode.TreeDataProvider<ScidTreeItem>, vscode.Disposable
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		ScidTreeItem | undefined | null
	>();
	public readonly onDidChangeTreeData: vscode.Event<
		ScidTreeItem | undefined | null
	> = this._onDidChangeTreeData.event;

	private readonly disposables: vscode.Disposable[] = [];
	private tickerGroups = new Map<string, ParsedScidFile[]>();

	constructor(private readonly reader: ScidReaderShape) {
		const watcher = vscode.workspace.createFileSystemWatcher("**/*.scid");
		watcher.onDidCreate(() => this.refresh(), this, this.disposables);
		watcher.onDidChange(() => this.refresh(), this, this.disposables);
		watcher.onDidDelete(() => this.refresh(), this, this.disposables);
		this.disposables.push(watcher);
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: ScidTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: ScidTreeItem): Promise<ScidTreeItem[]> {
		if (!element) {
			const uris = await vscode.workspace.findFiles(
				"**/*.scid",
				"**/node_modules/**",
			);
			const parsed = uris.map((u) => parseScidFileInfo(u.fsPath));
			this.tickerGroups = groupFilesByTicker(parsed);

			const tickerItems: TickerTreeItem[] = [];
			const sortedTickers = Array.from(this.tickerGroups.keys()).sort();
			for (const ticker of sortedTickers) {
				const files = this.tickerGroups.get(ticker) ?? [];
				tickerItems.push(new TickerTreeItem(ticker, files));
			}

			return tickerItems;
		}

		if (element instanceof TickerTreeItem) {
			const items: ScidFileTreeItem[] = [];
			for (const file of element.files) {
				let recordCount: number | undefined;
				try {
					recordCount = await Effect.runPromise(
						this.reader.getRecordCount(file.fsPath),
					);
				} catch {
					recordCount = undefined;
				}
				items.push(new ScidFileTreeItem(file, recordCount));
			}
			return items;
		}

		return [];
	}
}
