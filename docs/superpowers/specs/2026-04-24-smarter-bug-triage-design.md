# Smarter Per-Report Bug Triage — Design

**Status:** Draft
**Date:** 2026-04-24
**Author:** guirguispierre + Claude Code (brainstorming session)
**Scope:** Spec A of a two-spec initiative. Spec B (`/pokedex-sort` batch re-triage command) is a separate, later spec that builds on the intelligence shipped here.

## 1. Problem

The current Pokedex triage pipeline is shallow:

- **Screenshots are collected but never shown to the AI.** `pipeline.js:43-57` stores image attachments; the classifier in `openrouter.js` only sees `text`. Visible error messages, stack traces, and UI state in screenshots are invisible to classification.
- **No self-awareness of capability gaps.** When a bug report is unclassifiable or needs information Pokedex can't obtain, the bot silently classifies with whatever it has. The owner has no backlog of "things I should build into Pokedex."
- **Threads use blanket ✅ reactions.** `thread.js:66-120` reacts to every follow-up message regardless of content. Bot feels robotic; meaningful reporter updates don't get meaningful bot responses.
- **No auto-resolution.** Reporters saying "fixed!" or "solved" leaves the issue `open` forever.
- **Mentions create low-signal issues when replying to other users.** `@Pokedex did you see this?` in a reply chain triggers issue creation off the *replying* message, not the original complaint.
- **Everything goes to `eng-triage`, including user complaints about Pokedex itself** ("bot keeps misclassifying"). SWEs get noise; Pokedex-about-Pokedex feedback isn't surfaced to the bot owner.

## 2. Goals

1. Classify screenshots (extract error text, screen, app state) and feed that into triage.
2. Give the triage AI a tool-using agent loop so it can search existing issues, check the live poke.com status API, and read recent channel messages before classifying.
3. Route Pokedex-about-Pokedex reports (user-filed bugs, user-filed feature requests, agent-detected capability gaps) to `#pokedex-testing` instead of `eng-triage`.
4. Make thread replies smart — reply with substance only when there's substance to add; otherwise react or stay silent.
5. Auto-resolve issues when the reporter indicates resolution, with false-positive safety.
6. Detect when a mention is part of a reply chain and classify the *parent* content instead of the mention wrapper; early-exit for casual chatter and direct bot questions without creating an issue.
7. Maintain a deduped "capability gap" backlog in `#pokedex-testing` so the owner can see what Pokedex wishes it had.

## 3. Non-Goals

- **Spec B territory (explicitly out of scope):** `/pokedex-sort`, batch re-triage over historical issues, lifecycle commands on gaps (resolve/wontfix/etc.), metrics dashboards.
- **Prompt caching** and other cost optimizations beyond hard budgets.
- **New entry points** beyond today's (mention, 🐛/💡 reaction, forum, `/pokedexbug`). `/suggest` and `/feedback` stay on their existing paths.
- **Real-time owner interactivity in `#pokedex-testing`.** The channel is a one-way backlog. Per user: "no one will answer since the SWEs that will use this will only read the bug error that was given. i want this to be fully autonomous."
- **CI / GitHub Actions wiring** for tests. `npm test` runs locally; CI is a follow-up.

## 4. Architecture

### 4.1 Data flow

```
message → pipeline.processIssue
  → agentTriage.triageIssue(text, images, { channelId, reporterId, guildId, parentMessage? })
      loop up to agent_max_tool_calls iterations:
        openrouter.callWithTools(messages, TOOLS, images_on_first_turn_only)
        if tool_calls:
          for call in response.tool_calls:
            dispatchTool(call.name, call.args, ctx)
            append (assistant tool_call + tool_result) to messages
          continue
        else:
          parse final JSON → break
  → if classification.capability_gap: capabilityGap.record(gap, issueId, guild)
  → firestore.saveIssue({ ...classification, target, agentMeta })
  → triage.postIssueEmbed(guild, issue, issueId)
       channel = target === 'pokedex_bot' ? pokedex_self_channel : triage_channel
  → acknowledge / follow-up thread per existing behavior
```

### 4.2 File-level impact

**New files:**

- `src/services/agentTriage.js` — Loop orchestrator. Public API: `triageIssue(text, images, ctx)`.
- `src/services/agentTools/searchIssues.js` — Semantic + keyword search over Firestore `issues`.
- `src/services/agentTools/getStatus.js` — Thin wrapper around `statusFetcher.fetchSummary()`.
- `src/services/agentTools/readChannel.js` — Fetches last N messages from the reporting channel via the bot's Discord client.
- `src/services/agentTools/index.js` — Tool registry: exports OpenAI-compatible tool schema array + `dispatch(name, args, ctx)`.
- `src/services/capabilityGap.js` — Gap record/dedup + `#pokedex-testing` post/edit.
- `test/` directory + initial tests (see §10).

**Modified files:**

- `src/services/openrouter.js` — Add `callWithTools(messages, tools, images)` for single-turn tool-use. Existing `classifyIssue` becomes a thin wrapper that delegates to `agentTriage` for the default path; direct callers remain for the `agent_enabled: false` fallback.
- `src/services/pipeline.js` — Call `agentTriage.triageIssue` instead of `classifyIssue`. Route to channel based on `target`. Pass parent message when mention is a reply.
- `src/services/triage.js` — `findTriageChannel(guild, target)` picks channel by target. `buildIssueEmbed` renders pokedex-self variant (title prefix, color palette).
- `src/services/firestore.js` — New `searchIssues(query, limit)` helper. Issue schema gains `target`, `lastEvaluatedAt`, `agentMeta`, resolution fields.
- `src/services/contextEvaluator.js` — Evaluator return type expanded: `responseMode: "ignore" | "react" | "reply"`, `resolved: boolean`, `resolvedReason: string | null`. Collects new images from messages since `lastEvaluatedAt`.
- `src/triggers/thread.js` — Unify forum and non-forum paths through `evaluateContext`. Apply `responseMode`. Enforce `agent_max_replies_per_thread_per_10m`. Stop auto-evaluating after 24h silence on a resolved issue.
- `src/triggers/mention.js` — On mention, fetch `message.reference` if present. Pass parent content as `parentMessage` context to agent. Agent classifies mention as `new_issue` / `followup_on_existing` / `chatter` / `question_to_bot`; only `new_issue` creates an issue.
- `src/commands/pokedexbug.js` — Force `target: "pokedex_bot"` but still run agent for priority/category/vision/gap detection.
- `src/config/config.js` defaults + `config.json` — New keys (see §6).
- `CHANGELOG.md` — 2.9.0 entry.
- `package.json` — version bump 2.8.2 → 2.9.0.

## 5. Agent loop & tools

### 5.1 Loop shape (pseudocode)

```
triageIssue(text, images, ctx):
  messages = [system_prompt, build_user_message(text, images, ctx.parentMessage?)]
  for i in 0..agent_max_tool_calls:
    response = openrouter.callWithTools(messages, TOOLS, images_if_i_eq_0)
    if response.tool_calls and response.tool_calls.length > 0:
      for call in response.tool_calls:
        result = agentTools.dispatch(call.name, call.args, ctx)
        messages.append({ role: 'assistant', tool_calls: [call] })
        messages.append({ role: 'tool', tool_call_id: call.id, content: JSON(result) })
      continue
    classification = parseJSON(response.content)
    if !valid(classification):
      return fallback(text, 'invalid_json')
    return { ...classification, agentMeta: { toolCallsMade, durationMs } }
  return fallback(text, 'budget_exhausted')
```

Images are attached only to the first user message. Reposting them each iteration would multiply vision costs without adding information.

### 5.2 Tool contracts

**`search_issues(query: string, limit: number = 5)`**
Returns `[{ id, summary, status, priority, category, createdAt, similarity }]`. Implementation: keyword search + existing Jaccard helper from `duplicates.js`, ordered by similarity. Returns `[]` on failure (no gap emitted — this tool should always be available).

**`get_poke_status()`**
Returns `{ overall, incidents: [{ name, status, startedAt }] }` via `statusFetcher.fetchSummary()`. If status is disabled or the API is down, returns `{ unavailable: true, reason }` and the agent SHOULD emit `capability_gap: "live status API access"` in its final classification.

**`read_channel_context(limit: number = 20)`**
Returns `[{ author, content, createdAt, hasImage }]`. `channelId` comes from `ctx`, NOT from LLM-supplied args — the agent cannot redirect this tool at a different channel (prevents snooping). Bot messages are included. Each message's content truncated to 500 chars.

### 5.3 System prompt additions

Extend the existing prompt in `openrouter.js:9-48` with:

1. **Tool-use guidance:** "Before classifying, consider whether the available tools would meaningfully improve the classification. Don't call tools just to call them. If the text alone is clearly sufficient, go straight to the final JSON."
2. **Self-vs-product rule:** "If the complaint is directed at Pokedex (this Discord bot) rather than poke.com (the product), set `target: 'pokedex_bot'`. Phrases like 'you're doing it wrong', 'the bot misclassified', 'pokedex ignored my message', 'this bot is broken' → `pokedex_bot`. Everything about poke.com the product → `poke_product`."
3. **Capability-gap guidance:** "If you identify that you could have triaged better *if* you had a capability you don't have, report ONE gap in `capability_gap: { title, detail }`. Be disciplined: only genuinely load-bearing gaps. Wishful-thinking gaps are worse than no gaps."
4. **Vision rule:** "If images are attached, extract visible error text, which screen/app is shown, and any relevant app state. Put findings in `evidence.screenshot_text`."
5. **Mention context rule** (when `parentMessage` is provided): "This mention was posted as a reply to another user's message. That parent message is the likely subject — classify its content, not the reply wrapper. If the parent is just chatter and the mention adds no new bug info, classify as `chatter` and set `responseMode: 'ignore'`."

### 5.4 Final JSON schema emitted by the agent

```json
{
  "priority": "critical|high|medium|low",
  "category": "<existing category enum>",
  "target": "poke_product|pokedex_bot",
  "mentionType": "new_issue|followup_on_existing|chatter|question_to_bot",
  "summary": "string",
  "reasoning": "string",
  "follow_up": "string|null",
  "evidence": {
    "screenshot_text": "string|null",
    "related_issues": ["issueId", ...]|null,
    "active_incident": "string|null"
  },
  "capability_gap": { "title": "string", "detail": "string" }|null
}
```

`mentionType` only applies to mention-trigger invocations; other triggers force `new_issue`. When `mentionType` is `"chatter"` or `"question_to_bot"`, the pipeline early-exits: no issue is created, no Firestore write, and `priority`/`category`/`target`/`evidence` fields are ignored (the agent may set them to placeholder values or null). `summary` and `reasoning` are still expected so the skip can be logged.

### 5.5 Evaluator (thread follow-up) schema

```json
{
  "complete": false,
  "missing": ["..."],
  "responseMode": "ignore|react|reply",
  "reply": "string|null",
  "triageUpdate": "string|null",
  "reclassify": false,
  "resolved": false,
  "resolvedReason": "string|null",
  "newImagesInspected": ["<image-url>", ...]
}
```

## 6. Configuration

New keys added to `src/config/config.js` defaults + `config.json`:

| Key | Default | Purpose |
|---|---|---|
| `pokedex_owner_id` | `null` (env: `POKEDEX_OWNER_ID`) | Discord user ID to @-mention on first-seen gaps and critical self-bugs |
| `pokedex_self_channel` | `"pokedex-testing"` | Channel name for Pokedex-self issues + capability-gap backlog |
| `agent_enabled` | `true` | Master kill switch. `false` → fall back to today's single-shot `classifyIssue` |
| `agent_max_tool_calls` | `5` | Hard cap per triage invocation |
| `agent_max_replies_per_thread_per_10m` | `3` | Rate limit on bot replies in a single thread |

All appear in `/config set` autocomplete automatically (autocomplete reads `getAllConfig()` — `src/commands/config.js:81-89`). No autocomplete code change needed.

## 7. Self-vs-product routing

### 7.1 Channel mapping

- `target: "poke_product"` → `triage_channel` (default `eng-triage`).
- `target: "pokedex_bot"` → `pokedex_self_channel` (default `pokedex-testing`).

Both use the same embed shape. Pokedex-self embeds differ visually:

- Title prefix `[Pokedex self]`.
- Color palette in the purple family to distinguish from the priority-colored product bugs at a glance.
- Extra field "Reported message" linking back to the original Discord message.
- Owner @-mention in the post body for `critical` and `high` priority only.

### 7.2 Target reclassification across a thread

If a thread follow-up flips `target` (e.g. initially looked like a poke.com bug, but reporter's next message reveals they're frustrated with Pokedex itself):

1. Edit the original embed to: "Moved to #pokedex-testing" + link.
2. Post a fresh embed in the correct channel. Update `issue.triageMessageId` to the new one.
3. Don't delete the old — it's an audit trail.

### 7.3 `/pokedexbug` command

Override: always `target: "pokedex_bot"` regardless of what the agent would pick. User explicitly said "this is a Pokedex bug." Agent still runs for priority/category/vision/gap detection.

## 8. Conversation intelligence

### 8.1 Thread replies (`responseMode`)

Every thread message (not just forum) goes through `evaluateContext`. Based on `responseMode`:

- `ignore` — third-party chatter, short acknowledgments, emoji-only. No reaction, no reply.
- `react` — "+1", "same here", reporter confirming new info without asking anything. Bot reacts ✅. No message.
- `reply` — new substantive info, question for the bot, clarifying question *from* the bot. Bot posts a short reply.

Hard rate limit: `agent_max_replies_per_thread_per_10m` (default 3). Enforced in `thread.js` via a small in-memory tracker keyed by `threadId`, sliding window.

After `resolved: true`, stop auto-evaluating on messages older than 24h from resolution time.

### 8.2 Auto-resolve

Triggered when evaluator returns `resolved: true` AND `message.author.id === issue.reporterId`. Other participants saying "fixed" doesn't count.

Actions:

1. Update issue: `status: "resolved"`, `resolvedAt`, `resolvedReason`, `resolvedBy: "reporter"`.
2. Edit triage embed: add ✅ "Resolved by reporter" field, change color to green family.
3. Post a single thread reply: `"Marked as resolved — reply if it comes back."` (No `/reopen` command in this spec; reopening via a new report in the same thread is handled by existing thread context collection.)
4. Do NOT lock the thread. Stop auto-evaluating after 24h of silence.

Confidence gate (handled by prompting, not a separate field): when the evaluator is unsure, the prompt instructs it to return `resolved: false` AND `responseMode: "reply"` with `reply: "sounds like this is working now — should I close this out?"`. Auto-resolve only fires on `resolved: true`. The reporter's next "yes" / "close it" reply flips it in a subsequent evaluation cycle.

### 8.3 Mention-reply context awareness

In `triggers/mention.js`:

1. If `message.reference?.messageId` exists, fetch the referenced message. Pass its content + author to the agent as `parentMessage`.
2. Also provide the last 5–10 channel messages via `read_channel_context` as ambient context.
3. Agent classifies via `mentionType`:
   - `new_issue` → full triage pipeline.
   - `followup_on_existing` → use `search_issues` to find the related open issue; append thread-context there via `firestore.appendThreadContext`. Re-run evaluator on the matched issue.
   - `chatter` → early-exit. No issue created. No reaction (silent for v1; configurable later).
   - `question_to_bot` → early-exit with a short reply pointing to `/help`.

Example fixed: User A complains about Gmail integration; User B replies `@Pokedex did you see this?` → agent reads User A's message as parent content, creates the issue from User A's complaint, notes User B as the escalator.

## 9. Capability-gap backlog

### 9.1 Schema

New Firestore collection `capability_gaps`:

```json
{
  "id": "string",
  "title": "short title (e.g. 'log-query tool')",
  "normalizedKey": "slugified/stemmed for dedup",
  "firstSeenAt": "timestamp",
  "lastSeenAt": "timestamp",
  "occurrenceCount": 1,
  "exampleIssueIds": ["<last up to 5>"],
  "postMessageId": "string|null",
  "status": "open|in_progress|shipped|wont_do"
}
```

### 9.2 Dedup

On `capability_gap: { title, detail }` from agent:

1. Normalize `title` (lowercase, strip stopwords, light stem) → `normalizedKey`.
2. Lookup existing doc by `normalizedKey`.
3. **First occurrence:** insert doc; post embed in `#pokedex-testing` with `<@pokedex_owner_id>` mention; store `postMessageId`.
4. **Nth occurrence:** increment `occurrenceCount`; update `lastSeenAt`; append `issueId` to `exampleIssueIds` (cap 5); **edit** the existing post.
5. Re-ping the owner only at thresholds: occurrence 3, 10, 50.
6. If `status` is `shipped` or `wont_do`, record the occurrence in Firestore but do nothing in the channel (gap is dead-lettered).

### 9.3 Embed format

```
🔧 Capability gap: <title>
Seen <N> times (first: <rel time>, last: <rel time>)
Status: <status>

Detail:
<latest detail string from agent>

Example issues: #<id1>, #<id2>, #<id3>  (most recent)
<@owner>   ← only on first-seen and threshold re-pings
```

### 9.4 Wiring

- `agentTriage.js` returns `capability_gap` as part of its result object.
- `pipeline.js` — after the issue is saved (so `exampleIssueIds` can include the real `issueId`) — calls `capabilityGap.record(gap, issueId, guild)`.
- `capabilityGap.js` owns Firestore read/write + channel post/edit.

No lifecycle slash commands in this spec. Status stays `open` until a human edits Firestore directly or Spec B adds admin tooling.

## 10. Testing

`CLAUDE.md` states no test suite exists. This spec adds a minimal harness using Node's built-in `node --test` (zero new dependencies). `package.json` gets a `"test": "node --test test/"` script.

### 10.1 Automated tests (synthetic data only, per memory `feedback_test_data_policy.md`)

- `test/agentTools/searchIssues.test.js` — query normalization, result shaping with a fixture issues array.
- `test/capabilityGap.test.js` — `normalizeKey()` dedup (variants map to same key), threshold calculation (first/3rd/10th/50th fires re-ping, others don't).
- `test/triage-routing.test.js` — given `target: "pokedex_bot"` → returns `pokedex_self_channel` channel; `"poke_product"` → `triage_channel`.
- `test/autoResolve.test.js` — reporter says "solved" → resolve; non-reporter says "fixed" → no resolve; hedged phrase ("we need this fixed") → no resolve.
- `test/agentTriage-fallback.test.js` — mocked OpenRouter responses: empty `tool_calls` with malformed JSON → fallback; loop hits budget → fallback with `agent_budget_exhausted` flag.

OpenRouter, Discord, and Firestore are mocked in-process. No network. No secrets. Tests that would need secrets are env-gated and `.skip()`'d by default per repo policy.

### 10.2 Manual test plan (run in a staging guild before merge)

1. Mention bot with a screenshot of a fake error → agent extracts text, posts to `eng-triage` with `evidence.screenshot_text` populated.
2. Mention bot in a reply to another user's complaint → parent message is what gets classified, not the "did you see this" wrapper.
3. Post "you're doing it wrong, pokedex" at the bot → routed to `#pokedex-testing`, not `eng-triage`.
4. Report a bug, reply "solved" in the thread as the reporter → issue auto-resolved, embed updated.
5. Report a bug, a *different* user replies "fixed" → no auto-resolve.
6. Report a bug, bot asks a follow-up, reporter sends another screenshot in thread → new screenshot is read; `evidence.screenshot_text` augmented.
7. Report two bugs that should produce the same gap title → first creates a `#pokedex-testing` post, second edits it with count=2. Owner is pinged only on the first.
8. Toggle `agent_enabled: false` via `/config set` → pipeline falls back to today's single-shot behavior. Toggle back on.
9. Block OpenRouter network access (e.g. set `OPENROUTER_API_KEY=invalid`) → issue still saved with "AI unavailable" note.
10. Rapid-fire 5 thread messages from the reporter within 2 minutes → bot replies at most 3 times (rate limit).

## 11. Graceful degradation

| Failure | Behavior |
|---|---|
| Single tool call throws | Tool returns `{ error: <msg> }` to agent; agent continues |
| All tools throw repeatedly | Agent exits loop early, classifies with current info |
| Vision call fails (image fetch 404 / OpenRouter rejects image) | Retry once without images; log `evidence.screenshot_text: "image unreadable"` |
| Agent loop hits `agent_max_tool_calls` without valid final JSON | Fallback to today's `classifyIssue(text)`; set `agentMeta.fallbackReason: "budget_exhausted"`. If this fires on >5% of reports/hour, emit `capability_gap: "agent budget too tight"` |
| OpenRouter unreachable | Heuristic classification (`priority: "unclassified"`, `category: "other"`); post to `eng-triage` with "AI unavailable" note |
| `agent_enabled: false` | Skip agent; use today's `classifyIssue` path. Vision + gaps disabled |
| Firestore write fails | Log and best-effort continue (same as today) |
| `#pokedex-testing` channel missing | Post to `eng-triage` with `[Pokedex self]` prefix as fallback. Log warning |

## 12. Observability

- Each triage invocation logs duration, tool calls made, fallback reason (if any) via `console.log` (matches existing service logging style).
- Issue document gets `agentMeta: { toolCallsMade, durationMs, fallbackReason, modelUsed }`.

No Grafana, no metrics emission. Follow-up if needed.

## 13. Cost controls

- `max_tokens` on each agent call: 2000 (conservative).
- Tool result truncation: `read_channel_context` → 20 messages × 500 chars each; `search_issues` → 5 results × 300-char summaries.
- No prompt caching in v1.

## 14. Ship process

Per memory `feedback_ship_process.md`:

1. **Branch:** `feat/smarter-bug-triage` off `main`.
2. **Commits:** one per subsystem (agentTriage, agentTools, capabilityGap, routing, thread intelligence, mention context, tests, config/defaults).
3. **Version bump:** `package.json` `2.8.2` → `2.9.0`. New features, backwards-compatible at runtime since `agent_enabled: true` preserves or improves today's behavior and all new config keys have sensible defaults.
4. **CHANGELOG.md:** new `## 2.9.0 — 2026-04-24` section:
   - **Added**: screenshot reading via vision; tool-using agent triage (issue search, status API, channel context); capability-gap backlog in `#pokedex-testing`; auto-resolve on reporter saying "solved"/"fixed"; smart thread replies (ignore/react/reply); mention-reply parent-message context awareness; `target`-based routing between `eng-triage` and `#pokedex-testing`.
   - **Changed**: `pokedexbug` command now runs through the agent for richer classification; issue schema adds `target`, `lastEvaluatedAt`, `agentMeta`, resolution fields.
   - **Config**: new keys `pokedex_owner_id`, `pokedex_self_channel`, `agent_enabled`, `agent_max_tool_calls`, `agent_max_replies_per_thread_per_10m`.
5. **PR** against `main`. Title: `feat: smarter agent-based bug triage with vision + capability gaps`. Body: 3–5 bullet summary + staging-guild screenshot(s) if practical + the §10.2 manual test checklist.
6. No `--no-verify`, no force-push, no `git rebase -i` during review. Address feedback as new commits.

## 15. Out-of-scope follow-ups (tracked here, not built)

- Spec B: `/pokedex-sort` batch re-triage.
- Admin slash commands for capability gap lifecycle (mark shipped / wontfix).
- Reopen flow (`/reopen <id>`).
- CI workflow for `npm test`.
- Prompt caching.
- Reporter-pattern detection (tool D from brainstorm Q5) — reserved for when volume is higher.
- Docs/support-bot answering (tool E from brainstorm Q5) — separate product concern.
