# Changelog

## [Unreleased]

## [2.15.0] - 2026-06-21

### Changed
- **Upgraded `firebase-admin` 13 → 14** and migrated the entire data layer from the removed namespaced API to the v14 modular API (`getFirestore()`, `FieldValue`, `Timestamp` from `firebase-admin/firestore`; `initializeApp`/`cert` from `firebase-admin/app`) across 25 files. No behavior change — same Firestore reads/writes, transactions, and field sentinels.
- **Minimum Node.js is now 22** (required by firebase-admin 14; added an `engines` field). CI already runs Node 22 and 24.

### Security
- The firebase-admin 14 upgrade plus targeted `overrides` (`uuid`, `gaxios`, `retry-request`, `teeny-request`) clear the remaining moderate advisories in the google-cloud dependency tree. **`npm audit`: 0 vulnerabilities** (was 8 moderate).

## [2.14.2] - 2026-06-21

### Security
- Patched three high-severity transitive vulnerabilities via `overrides`, all to in-major versions (no breaking upgrades): **`form-data`** → 2.5.6 (CRLF injection via unescaped multipart field names), **`protobufjs`** → 7.6.4 (prototype-shadowing + unbounded-`Any` DoS), and **`undici`** → 6.27.0 (Set-Cookie header injection + WebSocket DoS). Supersedes Dependabot #74. No remaining high/critical advisories; the 8 moderate advisories that remain are deep `firebase-admin` internals requiring a major `firebase-admin@14` bump (tracked separately).

## [2.14.1] - 2026-06-21

### Fixed
- **Triage buttons stay active after a status click.** Pressing a status button (Acknowledged / Fixed / Won't Fix / Escalate) previously disabled *every* other button — including Delete and Gather Context — so a triager couldn't change the state again or recover from a misclick. All buttons now stay enabled; status is treated as a transition state, with each press appended to the embed as a running log.

## [2.14.0] - 2026-06-21

### Added
- **Image scam scanner** — when a recently-joined member posts an image in a monitored channel, Pokedex scans it with an OpenRouter vision model. Every scan is logged to a review channel. If it's a scam (confidence ≥ threshold), the message is deleted, the user is muted, and admins are alerted with the evidence. Configure via `/automod scamscan enable|monitor|review|admin|exempt|settings|dm|model|config`. Off by default until channels are set. Requires **Manage Server**.
- **Repost nuking via perceptual hash** — confirmed scam images are fingerprinted with a dHash. If the same image (even re-encoded or resized) is reposted in any channel by anyone, it's removed immediately without a second paid scan, and the admin alert lists every channel the image has been seen in. Fingerprints expire after 30 days.

### Internal
- New pure, unit-tested helpers: `dhashFromGrayscale`/`hammingDistance`/`isHashMatch` (`phash.js`), and `isNewMember`/`isExemptRole`/`selectScannableAttachments`/`parseVerdict`/`matchKnownScam`/`planAction` (`scamscan.js`). New service `scamscan.js` (config in `automod/scamscan`, fingerprints in the `scamHashes` collection) following the lockdown Firestore error contract. Extracted `applyTimeout` from `mute.js` so the scanner reuses the existing Discord-timeout path. Added `sharp` for image decode. Scans **fail open**: API/Discord errors never mute or delete. The scanner hooks into `messageCreate` right after the existing AutoMod pass.

## [2.13.0] - 2026-06-21

### Removed
- **Fun commands** — `/pokedex`, `/typechart`, and `/rickandmorty` have been removed. They were novelty/off-topic for a bug-triage bot and are no longer registered. (`/creator` is kept.)
- **`/timeout`** — removed as redundant with `/mute` and `/unmute` (v2.12.0), which are friendlier wrappers over the same Discord timeout. Use `/mute <user> <duration>` instead.
- **Colocated sub-projects** — `dashboard-vercel`, `forums-site`, `recipes-site`, `pokedex-mcp`, and `pokedex-mcp-cf` were extracted to their own standalone repositories (history preserved) and removed from this repo. The bot never referenced their code. The in-bot Express dashboard (`src/dashboard/`) and recipe ingestion (`src/recipes/`) are unaffected.

### Fixed
- **AutoMod scam detection — warning-context bypass closed.** A scammer could previously disable the entire crypto-scam scan just by sprinkling a warning word (`PSA`, `beware`, `scammers`, `phishing`) into a lure. Now an active call-to-action lure (`free nitro`, `send 1 BTC get 2 back`, `validate your wallet`, `double your bitcoin`) is flagged even when warning words are present, while genuine scam-warning PSAs are still left alone.
- **AutoMod scam detection — fewer false positives.** Defensive security advice like "never enter your seed phrase" or "do not paste your private key anywhere" is no longer flagged as a scam (the existing "never share" exemption now also covers `enter`/`paste`/`submit` with `never`/`do not`/`avoid`). Legit dApp "connect your wallet" and plain price chatter remain unflagged.
- **`/unlockall` restores every locked channel.** Channels recorded in legacy string form were misclassified as deleted and silently never reopened; they are now correctly unlocked. A channel recorded twice across repeated `/lockall` runs is restored once to its true pre-lock state instead of being edited twice.
- **`/lockall`** also locks announcement/news channels (members can post there) and preserves each channel's pre-lock permission overwrites so `/unlockall` restores the exact prior state; forum channels are locked correctly, and a concurrency guard stops overlapping lockdown operations from corrupting the record. A total unlock failure never wipes the lockdown record, so a follow-up `/unlockall` can retry.
- **`/mute`** no longer reports failure when the mute succeeded but the infraction-log write failed.
- **`/color`** reuses an existing matching guild role (including presets) instead of creating duplicates, even under concurrent/cross-shard seeding; adds a duplicate-name guard, a resumable seed sentinel, and a list-length cap.
- **Mentions** — replying to Pokedex no longer creates a spurious issue (`ignoreRepliedUser`).

### Security
- Bumped vulnerable transitive dependencies via `overrides`: **`ws`** 8.20.0 → 8.21.0 (remote memory-exhaustion DoS) and **`@grpc/grpc-js`** 1.14.3 → 1.14.4 (crash on malformed requests / compressed messages — GHSA-5375-pq7m-f5r2, GHSA-99f4-grh7-6pcq). Supersedes Dependabot PRs #65/#68/#71, whose remaining changes targeted the now-extracted sub-projects.

### Internal
- **Command autoloader** — `src/index.js` now loads all slash + context-menu commands once at startup via a single `fs.readdirSync` loader (`src/commandLoader.js`) and derives the Discord registration payload from that map, replacing the hand-maintained per-command requires, registration array, and per-interaction dispatch map.
- **Single test runner** — consolidated on `node --test`; ported the still-valuable specs out of the legacy `vitest` `tests/` directory into `test/` and removed `tests/`, the `test:legacy` script, and the `vitest` devDependency.
- **Expanded edge-case coverage** — added hard-edge-case suites for lockdown, color roles, and crypto-scam detection. Suite is green at **435 tests**.
- **CI** — added a GitHub Actions workflow that runs `npm ci` + `npm test` on Node 22 and 24 for every push to `main` and every pull request.

## [2.12.0] - 2026-06-04

### Added
- `/lockall now [reason]` and `/unlockall [reason]` — lock or unlock every text channel at once. `/lockall now` only records the channels it actually changes, so `/unlockall` never re-opens a channel that was already locked before the lockdown. Use `/lockall exclude add|remove|list` to skip channels (e.g. announcements, mod-chat). Requires **Manage Channels**.
- `/mute <user> <duration> [reason]` and `/unmute <user> [reason]` — friendly wrappers over Discord timeouts, logged to the `infractions` collection and DM'd to the user. Requires **Moderate Members**.
- `/color` — self-service color roles. `list`, `set <name>`, `hex <#code>`, and `clear` are open to everyone; `add <name> <hex>` and `remove <name>` require **Manage Roles**. Picking a new color strips any previous color role (no stacking); the palette is pre-seeded with 10 starter colors on first use.
- AutoMod now detects and removes **crypto/giveaway scams** (free-nitro bait, airdrop/giveaway lures, "double your bitcoin" schemes, wallet-drainer links), escalating repeat offenders like other automod offenses. Toggled by the `blockCryptoScams` config flag (default on, only fires when automod is enabled).

### Fixed
- A mod or admin posting `@everyone`/`@here` (or pinging a role the bot belongs to) no longer makes Pokedex think it was mentioned and start triage. Only a direct `@Pokedex` ping creates an issue.

### Internal
- New pure, unit-tested helpers: `containsCryptoScam` (automod.js), `planLockdown`/`planUnlock` (lockdown.js), `mentionsBotDirectly` (mention.js), `normalizeHex`/`rolesToStrip` (colorRoles.js). New Firestore-backed services `lockdown.js` (config/lockdown doc) and `colorRoles.js` (color_roles collection).

## [2.11.0] - 2026-05-25

### Added
- `/addcontext <text>` slash command and right-click **Add to Pokedex context** message action — add extra info to a filed report after Pokedex stops asking. Both append to the issue's `additionalContext` and refresh the triage embed in place.
- `/backfill-numbers` admin slash command — assigns ticket #s to open issues that don't have one yet (using the same sequential counter) and re-renders their triage embeds.

### Changed
- Triage embed title now leads with the ticket # (`#1234 — <summary>`). Issue ID stays in the footer untouched, so existing links and lookups still work.
- When Pokedex hits the 3-question cap, it now sends an explicit notice ("That's all the questions I'll ask — filing your report now. If you remember more later, run `/addcontext`…") before posting the closing receipt.

### Internal
- New `additionalContext: [{ text, authorId, authorName, addedAt, sourceMessageId }]` field on issue documents, rendered as a `📝 Additional Context` field in the triage embed (most-recent first, capped at 1024 chars).
- `appendAdditionalContext` uses Firestore `arrayUnion` so two concurrent `/addcontext` calls cannot lose each other's writes.
- Backfill uses a transactional set-if-missing that cannot overwrite a number assigned by a concurrent `saveIssue`. Race-lost candidates are counted as skipped, not assigned.
- Triage-embed refresh now prefers `issue.triageChannelId` over channel-by-name lookup, so edits don't silently fail when the configured triage channel changes or the `pokedex_bot` fallback channel was used.
- `addContextMessage` (right-click) now `deferReply`s up front so the interaction can survive normal latency on Firestore + Discord round-trips.
- Defensive guards in `buildIssueEmbed`: skips null entries inside `additionalContext`, uses `Number.isFinite` so `NaN`/strings never produce `#NaN —` prefixes.
- `numberList([])` returns `(no number)` instead of leaking `, and undefined` into receipts.
- Extracted pure helpers: `buildTurnCapNotice` (receipt.js), `normalizeAdditionalContextText` / `buildTriageRefreshPayload` / `resolveTriageChannel` (addContext.js), and `backfillMissingIssueNumbers` (issueNumberBackfill.js). **221 node:test tests, all passing.**

## [2.10.1] - 2026-05-25

### Fixed
- MCP **Approve** button now works. Approving a pending MCP-reported issue threw "Failed to process MCP issue." because the triage message was sent with double-nested `components` (`[buildTriageButtons()]` instead of `buildTriageButtons()`); Discord couldn't serialize it. Decline was unaffected because it never posts to triage.

## [2.10.0] - 2026-05-22

### Added
- `/exclude` command (`last N`, `on`, `off`, `status`, `clear`) and a right-click **Exclude from Pokedex** message action — keep mod/bystander chatter out of a report's context.
- Sequential ticket numbers (`#1234`) on every issue, including MCP-reported ones; shown in triage embeds and the closing receipt.
- Structured closing receipt so the reporter knows a ticket was filed and what the team will see.
- Multi-bug splitting — distinct bugs in one thread become separate tickets.

### Changed
- Triage conversation is now author-aware: only the original reporter's messages count as bug info; anyone may still chime in, and the bot stays silent toward non-reporters (mods, bystanders) so their chatter doesn't pollute the ticket.
- Pokedex identifies itself as a bot on its first message, asks at most three one-at-a-time questions, never asks the user to self-diagnose, and exits to file the report on frustration signals.

### Internal
- Code-enforced question-turn counter, regex frustration classifier, structured sufficiency extraction, and a sequential-counter Firestore transaction.

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
