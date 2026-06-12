# Changelog

## 0.6.0

- Added a compact context picker for adding extra Markdown files to chat context.
- Added visible context chips with remove controls.
- Chat prompts now label extra context files separately from the active note.

## 0.5.0

- Expanded the floating selection action into quick actions.
- Added `Ask`, `Explain`, `Summarize`, `Rewrite`, `Quiz`, and `Checklist` presets.
- Presets open the side panel, preserve the selected text as context, and prefill the composer.

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
