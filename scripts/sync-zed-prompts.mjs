import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const zedDir = path.join(rootDir, ".zed");
const promptsDir = path.join(zedDir, "prompts");

// Ensure project-level .zed/prompts directory exists
fs.mkdirSync(promptsDir, { recursive: true });

const skillDirs = [
	path.join(rootDir, ".agents", "skills"),
	path.join(rootDir, ".agent", "skills"),
];

const processed = new Map();

for (const dir of skillDirs) {
	if (!fs.existsSync(dir)) continue;

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillName = entry.name;
		if (processed.has(skillName)) continue;

		const skillPath = path.join(dir, skillName, "SKILL.md");
		if (!fs.existsSync(skillPath)) continue;

		const relPath = path.relative(rootDir, skillPath);
		processed.set(skillName, relPath);
	}
}

// Generate project-level .zed/prompts/*.md templates for Zed's /prompt command
for (const [skillName, relPath] of processed.entries()) {
	const promptFile = path.join(promptsDir, `${skillName}.md`);
	const content = `Please follow the instructions in ${relPath} to execute the following request:\n`;
	fs.writeFileSync(promptFile, content, "utf8");
}

console.log(
	`✓ Synchronized ${processed.size} skill prompt template(s) to ./.zed/prompts/`,
);
console.log("Usage in Zed Assistant: Type '/prompt ' to select any skill.");
