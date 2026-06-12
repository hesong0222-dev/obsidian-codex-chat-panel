# Changelog

## 0.4.0

- Edit mode now proposes changes before writing to the note.
- Added an inline diff preview for proposed edits.
- Added `Apply` and `Reject` controls for each proposed edit.
- Applying an edit verifies the note has not changed since the proposal was generated.

## 0.3.1

- Added a floating `Ask in side chat` action when note text is selected.
- The action opens the side panel, captures the selected text as context, and focuses the composer.

## 0.3.0

- Added Edit mode.
- Codex can now rewrite the active note or the selected text.
- Edits are returned as structured JSON and applied through Obsidian's vault API.
- Edit scope is intentionally limited to the current active note.

## 0.2.0

- Added Codex typing/progress indicators.
- Switched Codex execution to JSONL event streaming with final-message fallback.
- Redesigned the side panel to feel closer to Obsidian and Notion: quieter chrome, softer message surfaces, better spacing, and a more polished composer.

## 0.1.0

- Initial public release.
- Active-note context.
- Highlighted selection context.
- Markdown-rendered assistant replies.
- Compact model picker for ChatGPT-account Codex models.
