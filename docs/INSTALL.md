# Install Guide

## Prerequisites

Install and log into Codex CLI:

```bash
codex login
codex debug models
```

You should see at least one model.

## Manual Install

Create the plugin folder:

```bash
mkdir -p "/path/to/vault/.obsidian/plugins/codex-chat-panel"
```

Copy these files into it:

```text
main.js
manifest.json
styles.css
```

Restart or reload Obsidian, then enable `Codex Chat Panel` under Community plugins.

## Source Install

```bash
git clone https://github.com/hesong0222-dev/obsidian-codex-chat-panel.git
cd obsidian-codex-chat-panel
npm ci
npm run build
npm run install-local -- /path/to/vault
```

## Verify

In Obsidian:

1. Open a Markdown note.
2. Run `Open Codex chat panel`.
3. Ask `Summarize this note in one sentence`.

If that fails, run:

```bash
codex exec --model gpt-5.5 --sandbox read-only --skip-git-repo-check "Reply with ok"
```
