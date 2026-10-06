import esbuild from "esbuild";

await Promise.all([
	esbuild.build({
		entryPoints: ["src/extension.ts"],
		bundle: true,
		outfile: "dist/extension.cjs",
		external: ["vscode"],
		format: "cjs",
		platform: "node",
		target: "node20",
		sourcemap: true,
	}),
	esbuild.build({
		entryPoints: ["src/editor/webview/main.ts"],
		bundle: true,
		outfile: "dist/webview.js",
		format: "iife",
		platform: "browser",
		target: "es2022",
		sourcemap: true,
	}),
]);
