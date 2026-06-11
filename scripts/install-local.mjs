import fs from "fs";
import path from "path";
import process from "process";

const vaultPath = process.argv[2];

if (!vaultPath) {
  console.error("Usage: npm run install-local -- /path/to/your/obsidian/vault");
  process.exit(1);
}

const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "codex-chat-panel");
fs.mkdirSync(pluginDir, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(path.resolve(file), path.join(pluginDir, file));
}

console.log(`Installed Codex Chat Panel to ${pluginDir}`);
