# Troubleshooting

## The Panel Opens But Codex Fails

Check Codex CLI directly:

```bash
codex exec --model gpt-5.5 --sandbox read-only --skip-git-repo-check "Reply with ok"
```

If this fails, the issue is outside Obsidian.

## Obsidian Cannot Find Codex

Open plugin settings and set the full path.

macOS Homebrew paths:

```text
/opt/homebrew/bin/codex
/usr/local/bin/codex
```

## Selected Text Is Missing

The panel captures the last non-empty selection outside the Codex panel. Try this:

1. Select text in the note.
2. Confirm the panel shows `Selected N chars`.
3. Ask your question.

Also check that `Include selection` is enabled in plugin settings.

## Markdown Looks Raw

Assistant messages should be rendered through Obsidian's Markdown renderer. If you see raw Markdown everywhere, reload Obsidian and confirm you are running the latest `main.js`.

## Codex Looks Stuck On "Typing"

The plugin listens to Codex CLI JSONL events. Check the CLI directly:

```bash
codex exec --json --model gpt-5.5 --sandbox read-only --skip-git-repo-check "Reply with ok"
```

If no JSON events appear, update Codex CLI first.

## Model Is Rejected

Run:

```bash
codex debug models
```

Then choose a model available to your account.
