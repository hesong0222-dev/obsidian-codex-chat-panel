# Codex Chat Panel for Obsidian

Chat with Codex from the side of your note.

Codex Chat Panel adds a compact, VS Code-style assistant panel to Obsidian. It reads the active note, remembers highlighted text, renders Markdown answers properly, and sends the request through your local Codex CLI. No separate API key flow is needed when your Codex CLI is already logged in with your ChatGPT account.

> Built for people who write, study, research, and refactor notes inside Obsidian, but still want a serious coding-agent style chat next to the file they are reading.

## What It Does

- Opens as a right-side Obsidian panel.
- Sends the active note as context.
- Sends highlighted text as focused context when you drag-select part of a note.
- Shows `Ask in side chat` beside selected note text for quick selection questions.
- Can edit the active note or highlighted selection in `Edit` mode.
- Keeps a small chat history so follow-up questions make sense.
- Shows when Codex is reading, working, and typing.
- Streams Codex CLI JSON events into the panel instead of waiting silently.
- Renders Codex Markdown replies as real headings, lists, links, and code blocks.
- Shows a diff preview before applying Codex edits.
- Lets you choose practical ChatGPT-account Codex models:
  - `gpt-5.5`
  - `gpt-5.4-mini`
  - `gpt-5.3-codex-spark`
- Runs Codex in read-only mode by default.

## Why This Exists

Obsidian already has your thinking. Codex already has strong reasoning and local workspace awareness. This plugin puts them next to each other without making you copy-paste notes into a browser tab.

The workflow is intentionally simple:

1. Open a note.
2. Optionally highlight the paragraph, code block, or theorem you care about.
3. Ask in the side panel.
4. Get a Markdown-rendered answer in place.

## Requirements

- Obsidian Desktop.
- Node.js 22 or newer if you build from source.
- Codex CLI installed and logged in.

Check Codex first:

```bash
codex --version
codex login
codex debug models
```

If `codex debug models` works, the plugin can usually call Codex too.

## Install

### Option 1: Manual Install From a Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.
2. Create this folder in your vault:

```text
YOUR_VAULT/.obsidian/plugins/codex-chat-panel/
```

3. Put the three files there.
4. In Obsidian, open `Settings -> Community plugins`.
5. Turn off Safe Mode if needed.
6. Enable `Codex Chat Panel`.

### Option 2: Build From Source

```bash
git clone https://github.com/hesong0222-dev/obsidian-codex-chat-panel.git
cd obsidian-codex-chat-panel
npm ci
npm run build
npm run install-local -- /path/to/your/obsidian/vault
```

Then reload Obsidian and enable the plugin.

## Use

Open the command palette and run:

```text
Open Codex chat panel
```

The panel also adds a ribbon icon.

### Ask About the Current Note

Open a note, type a question, and press `Enter`.

Use `Shift+Enter` for a new line.

### Ask About a Selection

Drag-select text in source mode or reading mode. A small `Ask in side chat` button appears beside the selection. Click it to open the panel with that excerpt captured as a focused `<selection>` block, then type your question.

This is useful for:

- Explaining a confusing paragraph.
- Turning lecture notes into a quiz.
- Reviewing a code snippet in a Markdown note.
- Asking "what does this proof step mean?"

### Choose a Model

The model picker sits next to the send button.

- `GPT-5.5`: best default for hard work.
- `GPT-5.4 mini`: lighter and practical for quick note questions.
- `GPT-5.3 Spark`: fast, useful for short answers and study prompts.

The plugin only shows models that are practical for Codex with a ChatGPT account.

### Edit the Current Note

Switch `Mode` from `Chat` to `Edit`, then describe the change you want.

Examples:

```text
make this explanation shorter and clearer
turn this section into bullet points
fix the C code comments in the selected block
rewrite this note as an exam checklist
```

If text is selected, Codex proposes an edit for that selection. If nothing is selected, Codex proposes an edit for the whole active note.

The note is not changed immediately. Review the inline diff, then choose `Apply` or `Reject`.

Edit mode is intentionally scoped:

- It only applies changes to the active note.
- It uses structured JSON from Codex.
- The plugin applies approved text through Obsidian's vault API.
- The plugin checks that the note has not changed since the edit was proposed.
- Large whole-note edits are blocked; select a smaller section instead.

## Settings

Open `Settings -> Codex Chat Panel`.

| Setting | Default | Notes |
| --- | --- | --- |
| Codex CLI path | `codex` | Use an absolute path if Obsidian cannot find the CLI. |
| Model | `gpt-5.5` | Same models as the panel picker. |
| Include active file | on | Sends the current note as context. |
| Include selection | on | Sends highlighted text when available. |
| Max active-file context | `24000` chars | Large notes are clipped in the middle. |
| Timeout | `180` seconds | Stops long Codex calls. |
| Answer language | Korean | Can be changed to English or match latest message. |

## How It Works

The plugin calls Codex CLI in JSON event mode:

```bash
codex exec \
  --model gpt-5.5 \
  --json \
  --skip-git-repo-check \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --sandbox read-only \
  -C /path/to/vault \
  --output-last-message /tmp/obsidian-codex-answer.txt \
  -
```

The prompt includes:

- vault root
- active note path
- active note content
- highlighted selection, if any
- recent chat turns
- latest user message

The panel listens to Codex JSONL events for status updates and assistant messages. It still reads `--output-last-message` as a final fallback, so noisy CLI logs do not show up in the chat.

In Edit mode, Codex must return structured JSON:

```json
{
  "operation": "replace_selection",
  "content": "updated Markdown",
  "summary": "what changed"
}
```

The plugin then shows a diff preview. The result is written only after you choose `Apply`.

## Privacy And Safety

This plugin sends note content to Codex through your local Codex CLI session. It does not run its own server and does not store chat transcripts outside Obsidian's plugin runtime.

Important defaults:

- Codex runs with `--sandbox read-only`.
- Calls are `--ephemeral`.
- The plugin ignores project/user Codex rules for cleaner note Q&A.
- Edit mode is limited to the active Obsidian note and applies approved changes through Obsidian, not arbitrary shell writes.

You should still treat selected text and active notes as data you are intentionally sending to Codex.

## Troubleshooting

### Obsidian Says Codex Failed

Run this in a terminal:

```bash
codex exec --model gpt-5.5 --sandbox read-only --skip-git-repo-check "Reply with ok"
```

If that fails, fix Codex CLI login or model access first.

### Obsidian Cannot Find `codex`

Set an absolute path in plugin settings.

Common macOS paths:

```text
/opt/homebrew/bin/codex
/usr/local/bin/codex
```

### Selection Is Not Sent

Make sure `Include selection` is enabled in settings. Then select text in the note before clicking the panel.

The panel shows `Selected N chars` when it has captured a selection. When possible, the note also shows an `Ask in side chat` button beside the selected text.

### A Model Fails

Model access depends on the Codex CLI account. Check:

```bash
codex debug models
```

If a model is not available for your account, choose another model in the panel.

## Development

```bash
npm ci
npm run dev
npm run build
npm run check
```

The generated Obsidian files are:

- `main.js`
- `manifest.json`
- `styles.css`

## Release Checklist

1. Bump `version` in `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`.
2. Run `npm run check`.
3. Commit changes.
4. Tag the version:

```bash
git tag 0.1.0
git push origin main --tags
```

GitHub Actions uploads the three release files.

## Roadmap

- BRAT install instructions once the first release is published.
- Optional prompt presets for explain, summarize, quiz, and review.
- Per-vault language preference in the panel.
- Better model availability detection from `codex debug models`.

## Contributing

Small, practical improvements are welcome. Please keep the panel quiet, fast, and note-first.

Before opening a PR:

```bash
npm run check
```

## License

MIT.
