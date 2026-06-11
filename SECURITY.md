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

## Reporting Issues

Please open a GitHub issue for security-sensitive behavior that does not expose private data. If private data is involved, open a minimal issue first and describe the category of problem without including the sensitive content.
