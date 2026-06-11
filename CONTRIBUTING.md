# Contributing

Thanks for taking a look.

This plugin is intentionally small. The goal is not to become a full AI workspace inside Obsidian. The goal is to make the most common workflow feel good:

1. read a note,
2. select the part that matters,
3. ask Codex,
4. keep writing.

## Local Setup

```bash
npm ci
npm run build
npm run install-local -- /path/to/your/vault
```

Reload Obsidian after installing.

## Pull Request Checklist

- Keep the UI compact.
- Avoid adding remote services.
- Keep Codex execution read-only unless there is a clear, reviewed reason.
- Run `npm run check`.
- Update README or docs if behavior changes.

## Design Principles

- The note is the center of the workflow.
- The panel should not steal vertical space.
- Settings belong in settings, not in the everyday chat path.
- Markdown replies should look like Markdown, not raw assistant text.
- If a feature needs a paragraph to explain, it probably needs a simpler UI.
