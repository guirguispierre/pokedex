# Repo Feature Audit — Phase B

**Date:** 2026-06-14
**Branch:** `chore/repo-cleanup`
**Scope:** every slash command, every service module, and the colocated sub-projects.
**Status:** Report only — nothing removed. Mark what you want gone and I'll do Phase C.

## How "references" was determined

- **Commands:** all 46 are loaded and dispatched by the new autoloader, so every one is *reachable*. Code can't tell me which you actually *use* in your server — so for commands "usage" is my guess at relevance to a poke.com bug-triage/community bot, flagged for your call. Only you know real usage.
- **Services / triggers / utils:** counted actual `require(...)` importers across `src/`.
- **Sub-projects:** checked whether anything in the bot's `src/` references them.

Legend: 🟢 actively used · 🟡 unclear (your call) · 🔴 probably dead

---

## 1. Slash commands (46 = 44 slash + 2 context-menu)

### Core triage / issue pipeline — 🟢 (this is the bot's reason to exist)
| Command | Description | Verdict |
|---|---|---|
| `issue` | Manage triaged issues | 🟢 |
| `pokedexbug` | Report a bug → engineering triage channel | 🟢 |
| `feedback` | Analyze/manage forum feedback | 🟢 |
| `feedback-triage` | Triage a feedback forum post into an issue | 🟢 |
| `merge` | Merge multiple issues into one | 🟢 |
| `addcontext` + `Add to Pokedex context` (ctx-menu) | Add context to a filed issue | 🟢 |
| `exclude` + `Exclude from Pokedex` (ctx-menu) | Keep messages out of triage context | 🟢 |
| `backfill-numbers` | Assign ticket #s to old issues (admin) | 🟢 (one-shot admin util — rarely needed once run) |
| `config` | Manage bot configuration | 🟢 |
| `autoscrape` | Configure automatic recipe scraping | 🟡 (tied to recipes feature, see §4) |

### Moderation — 🟢 (recently added, v2.12.0)
| Command | Description | Verdict |
|---|---|---|
| `automod` | Configure auto-moderation | 🟢 |
| `lock` / `unlock` | Lock/unlock a channel | 🟢 |
| `lockall` / `unlockall` | Server-wide lockdown / undo | 🟢 |
| `mute` / `unmute` | Discord timeout wrappers | 🟢 |
| `timeout` | Timeout a user | 🟡 overlaps `mute` — `mute`/`unmute` (v2.12.0) are friendlier wrappers over the same timeout. `timeout` may be redundant. |
| `warn` | Manage user warnings | 🟢 |
| `kick` / `ban` | Kick/ban a user | 🟢 |
| `purge` | Bulk delete messages | 🟢 |
| `slowmode` | Set/remove slowmode | 🟢 |
| `deletethread` | Delete a thread | 🟢 |

### Community / engagement — 🟡 (work fine; keep-or-cut is a product call)
| Command | Description | Verdict |
|---|---|---|
| `level` | Check XP level | 🟡 |
| `leaderboard` | Top bug reporters / contributors | 🟡 (leaderboard mixes triage + XP) |
| `starboard` | Configure the starboard | 🟡 |
| `giveaway` | Manage giveaways | 🟡 |
| `poll` | Create a poll | 🟡 |
| `color` | Pick a color role | 🟡 (v2.12.0) |
| `afk` | AFK notifier | 🟡 |
| `welcome` | Welcome/goodbye messages | 🟡 |
| `reactionrole` | Reaction role messages | 🟡 |
| `suggest` | Submit/manage suggestions | 🟡 |
| `starboard`/`giveaway`/`poll`… | (above) | — |

### Status feature — 🟡 (self-contained subsystem, see services §2)
| Command | Description | Verdict |
|---|---|---|
| `status` | Check Poke status | 🟡 — backed by 5 `status*` services + a poller started in `index.js`. Sizeable; keep only if you watch poke.com status in Discord. |

### Fun / off-topic for a triage bot — 🟡 leaning 🔴
| Command | Description | Verdict |
|---|---|---|
| `pokedex` | Look up a Pokémon | 🟡 (name pun aside, unrelated to poke.com) |
| `typechart` | Pokémon type matchups | 🟡 |
| `rickandmorty` | Rick & Morty quotes/burps | 🔴 likely — pure novelty |
| `creator` | About the creator | 🟡 (vanity) |

### Utility / meta — 🟢
| Command | Description | Verdict |
|---|---|---|
| `help` | List commands | 🟢 |
| `changelog` | What's new | 🟢 |
| `ping` | Latency/uptime | 🟢 |
| `serverinfo` | Server stats | 🟡 |
| `recipes` | Community recipe collection | 🟡 (see §4) |

**No command is unreachable** — the old worry about "commands never in the dispatch map" is now structurally impossible (autoloader + the `commandLoader` test that locks the set).

---

## 2. Service modules (`src/services/`)

| Module | One-liner | Importers | Verdict |
|---|---|---|---|
| `firestore` | Firestore data layer | 17 | 🟢 core |
| `triage` | Triage embeds / channel / digest scheduler | 7 | 🟢 core |
| `openrouter` | OpenRouter AI client | 4 | 🟢 core |
| `pipeline` | Issue-processing orchestrator | 3 | 🟢 core |
| `addContext` | Append additional context to issues | 3 | 🟢 |
| `agentTriage` | AI agent triage flow | 3 | 🟢 |
| `contextEvaluator` | AI context-gathering for threads/forums | 3 | 🟢 |
| `automod` | Spam/raid/scam auto-moderation | 2 | 🟢 |
| `capabilityGap` | Detect capability-gap reports | 2 | 🟢 |
| `duplicates` | Jaccard duplicate detection | 2 | 🟢 |
| `lockdown` | Server lockdown state | 2 | 🟢 |
| `queue` | Sequential issue queue | 2 | 🟢 |
| `recipeTagger` | Recipe tagging | 2 | 🟡 (recipes feature) |
| `statusFetcher` | Fetch poke.com status | 2 | 🟡 (status feature) |
| `statusPoller` | Poll + post status updates | 2 | 🟡 (status feature) |
| `statusStore` | Persist status state | 2 | 🟡 (status feature) |
| `authorRole` | OP/MOD/OTHER role tagging in threads | 1 | 🟢 |
| `colorRoles` | Color-role management | 1 | 🟡 (`color` cmd) |
| `frustration` | Detect user frustration | 1 | 🟢 |
| `issueNumberBackfill` | Backfill ticket numbers | 1 | 🟢 (with `backfill-numbers`) |
| `mcpApproval` | Approve MCP-reported issues | 1 | 🟢 |
| `receipt` | Closing-receipt builder | 1 | 🟢 |
| `statusDiff` | Diff status snapshots | 1 | 🟡 (status feature) |
| `statusFormatter` | Format status embeds | 1 | 🟡 (status feature) |
| `threadDecision` | Thread response decision logic | 1 | 🟢 |
| **`pending`** | **Old webhook "pending issue" poller** | **0** | **🔴 DEAD — zero references repo-wide. `index.js` even comments "pending poller replaced by instant webhook message detection." Safe delete.** |

**Status subsystem note:** `status` command + `statusDiff/Fetcher/Formatter/Poller/Store` (6 files) + the poller wired in `index.js` (gated by `status_enabled` config) form one cohesive, removable unit. All-or-nothing keep/cut.

---

## 3. Triggers & utils

| Module | Role | Importers | Verdict |
|---|---|---|---|
| `triggers/mention` | @mention → issue | 1 (index) | 🟢 |
| `triggers/reaction` | 🐛/💡 reaction → issue | 1 (index) | 🟢 |
| `triggers/thread` | Thread follow-up context | 1 (index) | 🟢 |
| `triggers/forum` | Forum post → issue | 1 (index) | 🟢 |
| `triggers/autoscrape` | Auto-scrape recipes from threads | 1 (index) | 🟡 (recipes feature) |
| `utils/safeInteractionReply` | Safe interaction reply helper | 1 (index) | 🟢 |

All wired through `index.js` event listeners. (Each shows "1 importer" = index.js; that's expected for event entry points.)

---

## 4. Colocated sub-projects (the big question)

All five are **git-tracked**, each has its **own `package.json`**, and **none are referenced by the bot's `src/`**. They're separate apps living in the bot's repo with no shared build/deps — a monorepo without monorepo tooling.

| Directory | package name | What it is | Referenced by bot? | Verdict |
|---|---|---|---|---|
| `dashboard-vercel/` | `dashboard-vercel` | Standalone Vercel dashboard app | No | 🟡 doesn't belong here — own repo |
| `forums-site/` | `forums-site` | Standalone forums website | No | 🟡 doesn't belong here — own repo |
| `recipes-site/` | `pokedex-recipes` | Standalone recipes website | No | 🟡 doesn't belong here — own repo |
| `pokedex-mcp/` | `pokedex-mcp-server` | MCP server | No (bot ingests MCP issues via Discord webhooks, not this code) | 🟡 doesn't belong here — own repo |
| `pokedex-mcp-cf/` | `pokedex-mcp-cf` | Cloudflare variant of the MCP server | No | 🟡 doesn't belong here — own repo |

**In-bot, KEEP (not sub-projects):**
- `src/dashboard/` — the Express dashboard the bot itself starts (`startDashboard()` in `index.js`). 🟢 used.
- `src/recipes/` — referenced by `triggers/autoscrape`, `commands/recipes`, `services/recipeTagger`. 🟢 used (lives or dies with the recipes feature).

**Recommendation:** the 5 top-level sub-projects look like they should be extracted to their own repos rather than deleted (they're real apps, just misfiled). But that's your call — I can remove them from this repo, split them out, or leave them.

---

## 5. Suggested decision list (mark each: keep / remove / split-out)

**Clear dead code (safe remove, no behavior change):**
- [ ] `src/services/pending.js` — 🔴 zero references.

**Coherent removable features (each is one Phase-C commit, touches command + services + help + changelog):**
- [ ] **Status** — `status` cmd + 5 `status*` services + poller in `index.js` + their tests.
- [ ] **Recipes** — `recipes` + `autoscrape` cmds, `triggers/autoscrape`, `services/recipeTagger`, `src/recipes/`, recipe button handling.
- [ ] **XP/levels** — `level` + `leaderboard` (leaderboard also surfaces triage stats — partial).
- [ ] **Engagement misc** — any of `starboard`, `giveaway`, `poll`, `color`, `afk`, `welcome`, `reactionrole`, `suggest`.
- [ ] **Fun** — `pokedex`, `typechart`, `rickandmorty`, `creator`.
- [ ] **Redundant** — `timeout` (overlaps `mute`/`unmute`).

**Sub-projects (remove from this repo vs split to own repo):**
- [ ] `dashboard-vercel/` · `forums-site/` · `recipes-site/` · `pokedex-mcp/` · `pokedex-mcp-cf/`

---

**I've stopped here.** Tell me which items to remove (and for the sub-projects, whether to delete or you'll split them out yourself), and I'll do Phase C — one feature per commit, suite green and bot bootable after each, updating README / CHANGELOG / `help`.
