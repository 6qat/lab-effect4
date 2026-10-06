import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "dist/extension.cjs",
	external: ["vscode"],
	format: "cjs",
	platform: "node",
	target: "node20",
	sourcemap: true,
});
