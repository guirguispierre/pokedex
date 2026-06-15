# Changelog

## [2.5.0] - 2026-04-14

### Added
- **`/pokedexbug`** — new slash command for reporting bugs against Pokedex directly from Discord. Accepts a title, description, optional priority (critical/high/medium/low), category (bug/performance/security/ux_issue/infrastructure/other), and screenshot attachment. Reports flow through the existing Firestore issues pipeline and are posted to the eng-triage channel.

## [2.4.0] - 2026-03-25

### Added
- **AI-powered duplicate detection** — OpenRouter-based semantic matching replaces simple word overlap (Jaccard) as the primary duplicate detector. Jaccard remains as a fast pre-filter.
- **`/feedback-triage reorganize`** — new subcommand that scans all open issues for duplicate clusters using AI and auto-merges them (reporters, context, attachments, thread links).
- **Forum trigger duplicate check** — new feedback posts in #feedback are now checked against existing open issues before creating a new one. If a duplicate is found, the post is merged into the existing issue and the user is notified.
- `findDuplicateAI()` — single-issue AI duplicate detection against existing open issues (70% confidence threshold).
- `findDuplicateClustersAI()` — batch AI duplicate detection that identifies all duplicate groups across open issues.

### Changed
- `/feedback-triage run` now falls back to AI duplicate detection when Jaccard finds no match.
- `/feedback-triage scrape` now falls back to AI duplicate detection when Jaccard finds no match.
- `pipeline.js` issue processing now uses AI duplicate detection as fallback.

## [2.3.0] and earlier

See git history for previous changes.
