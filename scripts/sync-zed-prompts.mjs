import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const zedDir = path.join(rootDir, ".zed");
const promptsDir = path.join(zedDir, "prompts");
const zedSkillsDir = path.join(zedDir, "skills");

// Ensure project-level .zed directories exist
fs.mkdirSync(promptsDir, { recursive: true });
fs.mkdirSync(zedSkillsDir, { recursive: true });

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

		processed.set(skillName, {
			fullPath: path.join(dir, skillName),
			relPath: path.relative(rootDir, skillPath),
		});
	}
}

for (const [skillName, { fullPath, relPath }] of processed.entries()) {
	// 1. Generate .zed/prompts/*.md
	const promptFile = path.join(promptsDir, `${skillName}.md`);
	const content = `Please follow the instructions in ${relPath} to execute the following request:\n`;
	fs.writeFileSync(promptFile, content, "utf8");

	// 2. Link/mirror to .zed/skills/<skillName> for native Zed slash commands
	const targetSkillDir = path.join(zedSkillsDir, skillName);
	if (!fs.existsSync(targetSkillDir)) {
		try {
			fs.symlinkSync(
				path.relative(zedSkillsDir, fullPath),
				targetSkillDir,
				"dir",
			);
		} catch {
			fs.cpSync(fullPath, targetSkillDir, { recursive: true });
		}
	}
}

console.log(`✓ Synchronized ${processed.size} skill(s) to:`);
console.log(
	`  1. Native Zed skills: ./.zed/skills/<skill-name>/SKILL.md (triggers /<skill-name>)`,
);
console.log(
	`  2. Prompt templates:  ./.zed/prompts/*.md (triggers /prompt <skill-name>)`,
);
