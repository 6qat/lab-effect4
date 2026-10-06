import * as vscode from "vscode";
import { ScidEditorProvider } from "./editor/scid-editor-provider.js";
import { makeScidReader } from "./reader/scid-reader.js";

export function activate(context: vscode.ExtensionContext) {
	const reader = makeScidReader();
	const provider = new ScidEditorProvider(reader);

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			ScidEditorProvider.viewType,
			provider,
			{
				webviewOptions: {
					retainContextWhenHidden: true,
				},
				supportsMultipleEditorsPerDocument: false,
			},
		),
	);
}

export function deactivate() {
	// Clean up resources on extension deactivation
}
