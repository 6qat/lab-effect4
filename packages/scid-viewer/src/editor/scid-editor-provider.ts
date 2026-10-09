import * as path from "node:path";
import { Effect, Fiber } from "effect";
import * as vscode from "vscode";
import type { ScidReaderShape } from "../reader/scid-reader.js";
import type {
	AppendRecordsMessage,
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

	constructor(
		private readonly reader: ScidReaderShape,
		private readonly extensionUri: vscode.Uri,
	) {}

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
			localResourceRoots: [this.extensionUri],
		};

		const filePath = document.uri.fsPath;
		const fileName = path.basename(filePath);

		const scriptUri = webview
			.asWebviewUri(
				vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
			)
			.toString();

		const reader = this.reader;

		let lastKnownRecordCount = 0;
		let liveTailFiber: Fiber.Fiber<void, unknown> | undefined;

		const initProgram = Effect.gen(function* () {
			const summary = yield* reader.getSummary(filePath);
			lastKnownRecordCount = summary.totalRecords;
			const pageSize = 500;
			const initialOffset = Math.max(0, summary.totalRecords - pageSize);
			const { records } = yield* reader.readSlice(
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
			webview.html = renderWebviewHtml(
				fileName,
				initMessage,
				scriptUri,
				webview.cspSource,
			);
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

		const stopLiveTail = (): Promise<void> => {
			if (liveTailFiber) {
				const f = liveTailFiber;
				liveTailFiber = undefined;
				return Effect.runPromise(Fiber.interrupt(f))
					.then(() => {})
					.catch(() => {});
			}
			return Promise.resolve();
		};

		const startLiveTail = (): void => {
			if (liveTailFiber) return;

			const pollLoop = Effect.gen(function* () {
				while (true) {
					yield* Effect.sleep("250 millis");
					const appendResult = yield* reader
						.readSlice(filePath, lastKnownRecordCount)
						.pipe(
							Effect.catch(() =>
								Effect.succeed({
									records: [],
									totalRecords: lastKnownRecordCount,
									fileSize: 0,
								}),
							),
						);

					if (appendResult.records.length > 0) {
						lastKnownRecordCount = appendResult.totalRecords;
						const lastRec =
							appendResult.records[appendResult.records.length - 1];
						const appendMsg: AppendRecordsMessage = {
							type: "APPEND_RECORDS",
							records: appendResult.records,
							totalRecords: appendResult.totalRecords,
							fileSize: appendResult.fileSize,
							lastRecordIsoUtc: lastRec?.isoUtc,
						};
						yield* Effect.promise(() => webview.postMessage(appendMsg));
					}
				}
			});

			liveTailFiber = Effect.runFork(pollLoop);
		};

		webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
			if (message.type === "REQUEST_PAGE") {
				const pageProgram = Effect.gen(function* () {
					const totalRecords = yield* reader.getRecordCount(filePath);
					if (totalRecords > lastKnownRecordCount) {
						lastKnownRecordCount = totalRecords;
					}
					const { records } = yield* reader.readSlice(
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
			} else if (message.type === "TOGGLE_LIVE_TAIL") {
				if (message.enabled) {
					startLiveTail();
				} else {
					await stopLiveTail();
				}
			} else if ((message as { type: string }).type === "WEBVIEW_ERROR") {
				console.error("[SCID Webview Error]", message);
			}
		});

		webviewPanel.onDidDispose(async () => {
			await stopLiveTail();
		});
	}
}
