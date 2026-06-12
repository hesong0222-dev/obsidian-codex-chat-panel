import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

const requiredFiles = [
  "main.js",
  "manifest.json",
  "styles.css",
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "versions.json"
];

for (const file of requiredFiles) {
  assert(existsSync(file), `Missing required file: ${file}`);
}

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");

assert(manifest.id === "codex-chat-panel", "manifest.id must stay codex-chat-panel");
assert(Boolean(manifest.name), "manifest.name is required");
assert(Boolean(manifest.description), "manifest.description is required");
assert(Boolean(manifest.author), "manifest.author is required");
assert(manifest.isDesktopOnly === true, "Codex CLI integration must remain desktop-only");
assert(packageJson.version === manifest.version, "package.json and manifest.json versions differ");
assert(versions[manifest.version] === manifest.minAppVersion, "versions.json must map current version to minAppVersion");
assert(packageJson.license === "MIT", "package.json license must be MIT");
assert(Boolean(packageJson.repository?.url || packageJson.homepage || manifest.authorUrl), "Repository or author URL metadata is required");

const mainJs = readFileSync("main.js", "utf8");
assert(mainJs.includes("Codex Chat"), "main.js does not look like the built plugin");
assert(readFileSync("styles.css", "utf8").includes(".codex-chat-root"), "styles.css does not include plugin styles");

const docs = [
  "docs/INSTALL.md",
  "docs/MODELS.md",
  "docs/TROUBLESHOOTING.md",
  "docs/ROADMAP_1_0.md",
  "docs/RELEASE.md"
];
for (const doc of docs) {
  assert(existsSync(doc), `Missing documentation file: ${doc}`);
  assert(extname(doc) === ".md", `Documentation file must be Markdown: ${doc}`);
}

console.log(`release-assets-ok ${manifest.version}`);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
