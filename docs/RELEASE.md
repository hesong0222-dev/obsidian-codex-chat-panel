# Release Process

This project ships Obsidian plugin releases as GitHub release assets.

## Release Checklist

1. Update `CHANGELOG.md`.
2. Bump `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`.
3. Run:

```bash
npm ci
npm run check
```

4. Install into a local test vault:

```bash
npm run install-local -- /path/to/test/vault
```

5. Confirm these generated files match the local plugin folder:

```text
main.js
manifest.json
styles.css
```

6. Commit the release.
7. Tag the release:

```bash
git tag 0.x.0
git push origin main
git push origin 0.x.0
```

8. Confirm GitHub Actions succeeds for both CI and Release.
9. Confirm the GitHub release contains:

```text
main.js
manifest.json
styles.css
```

## Safety Expectations

- Edit mode must show reviewable changes before durable writes.
- Multi-file or agentic workflows must use reviewed edits.
- Release assets must be generated from source, not manually edited.
- Do not include vault data, credentials, screenshots with private note contents, or local machine paths in releases.
