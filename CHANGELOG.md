# Changelog

## [2.9.0] - 2026-04-25

### Added
- Screenshot reading via vision — agent extracts visible error text, screen, and app state from image attachments into `evidence.screenshot_text`.
- Tool-using agent triage loop with three tools: `search_issues`, `get_poke_status`, `read_channel_context`.
- Capability-gap backlog in `#pokedex-testing` — agent-detected gaps are deduped, reposted with counts, and @-mention the owner at 1/3/10/50 occurrences.
- Auto-resolve when the reporter says "solved"/"fixed"/etc. in an issue thread (reporter-only; unambiguous phrasing only).
- Smart thread replies — replaces blanket ✅ reactions with `responseMode: ignore | react | reply`.
- Mention-reply parent context — when a mention is a reply to another user's message, the parent content is what gets classified.
- Early-exit on casual-chatter mentions and direct questions to the bot (no issue created, optional short help reply).
- `target`-based routing: poke.com product bugs → `eng-triage`; Pokedex-self bugs and feature requests → `#pokedex-testing`.
- `node --test` harness; unit tests for agent tools, capability-gap dedup, target routing, rate limiting, auto-resolve, mention parent context.

### Changed
- `/pokedexbug` now runs through the agent for richer classification (screenshot reading, capability gaps) while preserving user-selected priority and category.
- Issue schema gains `target`, `evidence`, `agentMeta`, `lastEvaluatedAt`, and resolution fields (`resolvedAt`, `resolvedBy`, `resolvedReason`).
- Forum and non-forum thread paths are unified through one evaluator.

### Config
- `pokedex_owner_id` (default `null`; set via `POKEDEX_OWNER_ID` env var or `/config set pokedex_owner_id <discord-user-id>`)
- `pokedex_self_channel` (default `"pokedex-testing"`)
- `agent_enabled` (default `true`; set `false` to roll back to single-shot classification)
- `agent_max_tool_calls` (default `5`)
- `agent_max_replies_per_thread_per_10m` (default `3`)

All new keys are settable via `/config set` autocomplete.

## [2.5.1] - 2026-04-14

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
