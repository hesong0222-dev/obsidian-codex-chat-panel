# Roadmap to 1.0.0

This roadmap keeps the plugin small, local, and Obsidian-native while moving toward a safe Codex editing workflow.

## Product Position

Codex Chat Panel should feel like a lightweight Codex sidecar for Obsidian:

- no separate API key setup when Codex CLI is already logged in,
- note and selection context first,
- Markdown-native answers and edits,
- explicit user approval before durable writes,
- no hidden remote service.

## Release Sequence

### 0.4.0 - Reviewed Edits

Goal: edit mode proposes changes before writing.

Acceptance:

- Codex edit responses create a pending edit instead of immediately modifying the note.
- The panel shows a compact diff preview.
- The user can apply or reject the proposed edit.
- Applying verifies the note has not drifted from the proposal base.

### 0.5.0 - Selection Quick Actions

Goal: reduce the drag-select-to-answer loop to one click.

Acceptance:

- The floating selection action offers practical presets such as Explain, Summarize, Rewrite, Quiz, and Checklist.
- Presets fill the composer with a clear prompt and keep the selected text as context.
- The UI remains compact and does not obscure note text.

### 0.6.0 - Context Picker

Goal: let users intentionally add vault context beyond the active note.

Acceptance:

- Users can add a small set of extra Markdown files as context.
- Added files are visible in the panel before sending.
- The prompt labels each context source clearly.
- Large context is clipped predictably.

### 0.7.0 - Markdown Chat History

Goal: make useful conversations survive as Obsidian notes.

Acceptance:

- Users can save the current conversation to a Markdown file.
- Saved transcripts include source note, selected text summary, model, timestamps, and messages.
- The feature is opt-in and stores data inside the vault.

### 0.8.0 - Community Plugin Readiness

Goal: prepare for official Obsidian community plugin submission.

Acceptance:

- CI includes build, type check, release asset verification, and package metadata checks.
- README has screenshots/GIF placeholders, privacy summary, and concise install instructions.
- SECURITY, CONTRIBUTING, and troubleshooting docs match runtime behavior.
- The release process is documented and repeatable.

### 1.0.0 - Safe Agent Mode

Goal: provide a reviewed multi-step workflow without hidden writes.

Acceptance:

- Agent mode can inspect vault context and propose a plan.
- Proposed file changes are represented as reviewable edits.
- Multi-file writes require explicit user approval per file or per batch.
- Drift detection prevents applying stale edits.
- Failures leave the vault unchanged and explain the recovery path.

## Non-Goals Before 1.0.0

- No background autonomous vault rewrites.
- No server-side sync.
- No arbitrary shell writes from the Obsidian UI.
- No broad model marketplace.
