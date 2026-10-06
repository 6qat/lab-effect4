import * as vscode from "vscode";
import { ScidEditorProvider } from "./editor/scid-editor-provider.js";
import { makeScidReader } from "./reader/scid-reader.js";
import { ScidTreeDataProvider } from "./tree/tree-data-provider.js";

export function activate(context: vscode.ExtensionContext) {
	const reader = makeScidReader();
	const editorProvider = new ScidEditorProvider(reader, context.extensionUri);
	const treeDataProvider = new ScidTreeDataProvider(reader);

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			ScidEditorProvider.viewType,
			editorProvider,
			{
				webviewOptions: {
					retainContextWhenHidden: true,
				},
				supportsMultipleEditorsPerDocument: false,
			},
		),
		vscode.window.registerTreeDataProvider("scidExplorer", treeDataProvider),
		vscode.commands.registerCommand("scidExplorer.refresh", () => {
			treeDataProvider.refresh();
		}),
		vscode.commands.registerCommand(
			"scidExplorer.openFile",
			(uri: vscode.Uri) => {
				vscode.commands.executeCommand(
					"vscode.openWith",
					uri,
					ScidEditorProvider.viewType,
				);
			},
		),
		treeDataProvider,
	);
}

export function deactivate() {
	// Clean up resources on extension deactivation
}
