# Security

Codex Chat Panel is a local Obsidian Desktop plugin that shells out to Codex CLI.

## Data Flow

When you send a message, the plugin may include:

- the active note path,
- the active note content,
- highlighted text,
- recent chat turns,
- your latest question.

That prompt is sent through your local Codex CLI session.

## Defaults

The plugin runs Codex with:

```bash
--sandbox read-only
--ephemeral
--ignore-user-config
--ignore-rules
```

These defaults are meant to keep note Q&A predictable and avoid accidental file edits.

## Edit Mode

Edit mode can modify the active Obsidian note. Codex returns a structured edit payload and the plugin applies it with Obsidian's vault API.

The scope is intentionally narrow:

- active note only,
- selected text or whole note only,
- no arbitrary shell writes,
- no multi-file edits.

## Reporting Issues

Please open a GitHub issue for security-sensitive behavior that does not expose private data. If private data is involved, open a minimal issue first and describe the category of problem without including the sensitive content.
