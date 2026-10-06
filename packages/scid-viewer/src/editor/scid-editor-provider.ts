import * as path from "node:path";
import { Effect } from "effect";
import type * as vscode from "vscode";
import type { ScidReaderShape } from "../reader/scid-reader.js";
import type {
	InitMessage,
	PageDataMessage,
	WebviewToExtensionMessage,
} from "./protocol.js";
import { renderWebviewHtml } from "./webview-html.js";

export class ScidCustomDocument implements vscode.CustomDocument {
	constructor(public readonly uri: vscode.Uri) {}

	dispose(): void {
		// Scoped document disposal if necessary
	}
}

export class ScidEditorProvider
	implements vscode.CustomReadonlyEditorProvider<ScidCustomDocument>
{
	public static readonly viewType = "scidViewer.editor";

	constructor(private readonly reader: ScidReaderShape) {}

	openCustomDocument(uri: vscode.Uri): ScidCustomDocument {
		return new ScidCustomDocument(uri);
	}

	async resolveCustomEditor(
		document: ScidCustomDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const webview = webviewPanel.webview;
		webview.options = {
			enableScripts: true,
		};

		const filePath = document.uri.fsPath;
		const fileName = path.basename(filePath);

		const reader = this.reader;

		const initProgram = Effect.gen(function* () {
			const summary = yield* reader.getSummary(filePath);
			const pageSize = 500;
			const initialOffset = Math.max(0, summary.totalRecords - pageSize);
			const records = yield* reader.readSlice(
				filePath,
				initialOffset,
				pageSize,
			);

			const initMessage: InitMessage = {
				type: "INIT",
				fileName,
				summary: {
					fileType: summary.header.fileType,
					headerSize: summary.header.headerSize,
					recordSize: summary.header.recordSize,
					version: summary.header.version,
					totalRecords: summary.totalRecords,
					fileSize: summary.fileSize,
					firstRecordIsoUtc: summary.firstRecordIsoUtc,
					lastRecordIsoUtc: summary.lastRecordIsoUtc,
				},
				offsetIndex: initialOffset,
				pageSize,
				records,
			};

			return initMessage;
		});

		try {
			const initMessage = await Effect.runPromise(initProgram);
			webview.html = renderWebviewHtml(fileName, initMessage);
		} catch (err) {
			webview.html = `<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; padding: 24px; color: var(--vscode-errorForeground, red); background: var(--vscode-editor-background, #1e1e1e);">
	<h2>Failed to load SCID file</h2>
	<p>${String(err)}</p>
</body>
</html>`;
			return;
		}

		webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
			if (message.type === "REQUEST_PAGE") {
				const pageProgram = Effect.gen(function* () {
					const totalRecords = yield* reader.getRecordCount(filePath);
					const records = yield* reader.readSlice(
						filePath,
						message.offsetIndex,
						message.pageSize,
					);
					const pageData: PageDataMessage = {
						type: "PAGE_DATA",
						offsetIndex: message.offsetIndex,
						pageSize: message.pageSize,
						totalRecords,
						records,
					};
					return pageData;
				});

				try {
					const pageData = await Effect.runPromise(pageProgram);
					await webview.postMessage(pageData);
				} catch (err) {
					await webview.postMessage({
						type: "ERROR",
						message: `Failed to load page: ${String(err)}`,
					});
				}
			}
		});
	}
}
