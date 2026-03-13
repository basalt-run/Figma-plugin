# Known Bugs

## ~~Component Registry: sourcePath shows token path instead of file path~~ — FIXED

**Context:** When adding a component via the dashboard form, if the source path field is left blank, `sourcePath` could incorrectly get populated with a token path (e.g. `"color.action.default"`) instead of a file path.

**Fix applied:** Added `sanitizeSourcePath()` helper that rejects token-path-like values (multiple dots, no slashes). Applied in:
- API route (POST/PUT) — sanitize before DB insert/update
- syncToGitHub — sanitize before writing to components.json
- Sync route — sanitize when upserting from components.json
- AddComponentModal — client-side normalization before submit
