# Forum Feedback Auto-Context Gathering & /feedback Upgrade

**Date:** 2026-03-25
**Status:** Approved
**Goal:** Developers open `#eng-triage` and have enough context to fix issues without any back-and-forth with reporters.

---

## Problem

Users post feedback in the `#feedback` Discord forum. Today, `/feedback` does a batch AI analysis of raw forum posts and groups them into themes. But raw posts often lack critical details (steps to reproduce, environment, expected behavior). Developers end up having to message users for more info, which slows everything down.

## Solution

Pokedex automatically engages users in their forum posts through multi-turn conversation to gather complete context. A context evaluator AI decides when to ask, when to stay quiet, and when the issue has enough info. The triage embed in `#eng-triage` gets a "Context Complete" badge so devs can prioritize fully-contexted issues. `/feedback` is upgraded with two subcommands: `analyze` (AI theme report using enriched data) and `status` (operational dashboard).

---

## Architecture: Approach C — Forum Trigger + Conversation Service with Context Evaluator

### New Files

#### `src/triggers/forum.js` — Forum Post Auto-Intake

Listens to the `threadCreate` event. Filters for threads whose parent matches the configured feedback forum channel.

**Flow:**
1. Filter — only act on threads whose `parent.id` or `parent.name` matches the `feedback_forum` config value. Ignore threads from other channels.
2. Join the thread — call `thread.join()` so the bot can send messages in it. Without this, the bot may not have access to the thread.
3. Wait for starter message — Discord fires `threadCreate` before the starter message is available. Retry `thread.fetchStarterMessage()` up to 3 times with 2-second delays. If still null after retries, log a warning and bail (do not create an issue from a thread with no content).
4. Set a processing flag — immediately store a flag (`issue.initialProcessing = true`) so that the `messageCreate` handler in `thread.js` knows to skip the starter message and avoid double-processing (see Race Condition Guard below).
5. Classify — send `${thread.name}\n\n${starterMessage.content}` through `classifyIssue()`
6. Collect attachments — extract from starter message (same pattern as `pipeline.js`)
7. Save — `firestore.saveIssue()` with:
   - `source: 'forum'`
   - `threadId: thread.id`
   - `channelId: thread.parentId`
   - `messageId: starterMessage.id`
   - `reporterId: thread.ownerId`
   - `reporterName: starterMessage.author.username`
   - `text: starterMessage.content`
   - `forumTags: extractedTagNames` (from `thread.appliedTags` resolved against parent `availableTags`)
   - Classification fields (priority, category, summary, reasoning)
   - Attachments array
   - `initialProcessing: false` (clear the flag after save completes)
8. Post triage embed — `triage.postIssueEmbed(thread.guild, issue, issueId)` to `#eng-triage` (note: `thread.guild` provides the guild object)
9. First follow-up — call `evaluateContext(issue, [starterMessage])` and if `shouldReply` is true, send `reply` in the forum post

**Config:** `feedback_forum` key in config.json (channel name or ID, default: `'feedback'`). Becomes configurable at runtime via `/config set feedback_forum <value>`.

#### Race Condition Guard: `threadCreate` vs `messageCreate`

When a user posts in a forum, Discord fires both `threadCreate` (new thread) and `messageCreate` (starter message). Without a guard, the `messageCreate` handler in `thread.js` could also process the starter message, causing duplicate responses.

**Solution:** `forum.js` saves the issue with `initialProcessing: true` before classification completes. In `thread.js`, after looking up the issue via `getIssueByThreadId`, check: if `issue.initialProcessing === true`, return `true` (claim the message) but do nothing. This lets `forum.js` finish its intake without interference. The flag is cleared to `false` when `forum.js` finishes saving the fully classified issue.

Additionally, there is a timing gap where `threadCreate` fires but `saveIssue` hasn't run yet, so `getIssueByThreadId` returns null and `thread.js` ignores the message. Then `forum.js` completes and picks it up. This is the happy path and requires no special handling — `thread.js` returning `false` just means the `messageCreate` handler falls through to the mention check, and since forum starter messages don't @mention the bot, nothing happens.

#### `src/services/contextEvaluator.js` — Context Evaluator

Single exported function: `evaluateContext(issue, conversationHistory, extraHint?)`

**Inputs:**
- `issue` — full Firestore issue object
- `conversationHistory` — array of `{ author, isBot, content, attachments, createdAt }` from the forum post
- `extraHint` — optional string (e.g., "A developer needs more information on this issue") for mod-triggered evaluations

**Output (parsed from AI JSON response):**
```js
{
  complete: boolean,        // enough context for a dev to fix?
  missing: string[],        // what's still needed (human-readable)
  shouldReply: boolean,     // should Pokedex say something?
  reply: string | null,     // what to say
  triageUpdate: string | null,  // new context summary for triage embed
  reclassify: boolean       // should we re-run full classification?
}
```

**AI System Prompt Design:**

The prompt tells the AI it is Pokedex, a triage assistant. Its job is to evaluate whether a reported issue has enough context for a developer to investigate and fix it without needing to ask the reporter anything else.

The prompt includes structured checklists as guidance (not rigid requirements):

- **Bugs:** steps to reproduce, expected vs actual behavior, environment/platform, frequency/consistency, screenshots or logs
- **Feature requests:** use case / problem being solved, current workaround (if any), how important to their workflow
- **UX issues:** what they were trying to do, what confused them, where in the app
- **Performance:** what's slow, how slow (quantify if possible), when it started, device/network info

The AI is instructed to:
- Phrase questions naturally and conversationally, not as a checklist
- Skip items the user already covered
- Ask off-script questions if something unexpected comes up
- Return `shouldReply: false` for non-substantive messages (thanks, "cool", emojis, etc.)
- Return `shouldReply: true` with a `triageUpdate` when meaningful new context arrives, even days later
- Return `reclassify: true` when new info could change priority or category
- Mark `complete: true` only when a developer would have enough to start working
- When an issue is already `complete` and the user adds more: only set `reclassify: true` and `triageUpdate` if the new info is materially different (not just a thank you or minor clarification). The AI makes this judgment — no hardcoded threshold.
- If the user says "never mind" / "fixed itself" — acknowledge and note for potential auto-close

**OpenRouter call:** Uses the same `getConfig('model')` as existing classification. The call is small and focused — conversation history + issue metadata + checklist prompt. Falls back gracefully if JSON parsing fails (returns `shouldReply: false, complete: false`).

### Modified Files

#### `src/index.js` — Event Registration & Button Handler

**Add `threadCreate` listener:**
```js
const { handleForumPost } = require('./triggers/forum');

client.on('threadCreate', async (thread) => {
  await handleForumPost(thread);
});
```

**Add `triage_gather_` button handler** in the existing `handleButtonInteraction` function. This must be handled as a separate code branch BEFORE the `ACTION_LABELS` lookup (same pattern as the existing `delete` branch), since `gather` is not in `ACTION_LABELS` and would silently return:
- Check `if (action === 'gather')` after the existing `if (action === 'delete')` block
- Extract `issueId` from `triage_gather_{issueId}`
- Fetch the issue from Firestore
- Fetch the linked forum thread via `thread.guild.channels.fetch(issue.threadId)`
- Unarchive the thread if archived
- Scrape conversation history from the thread
- Call `evaluateContext(issue, history, 'A developer needs more information on this issue.')`
- If `shouldReply`: send the reply in the forum thread
- Acknowledge the button click with an ephemeral "Sent follow-up in the forum post"
- Return early (same pattern as `delete`)

#### `src/triggers/thread.js` — Smart Reply for Forum Issues

Currently, `thread.js` always reclassifies and sends a generic "Got it — I've updated this issue" embed.

**Changes:**
- Import `evaluateContext` from `../services/contextEvaluator`
- Import `updateIssueFields` from `../services/firestore` (new helper, see below)
- After looking up the issue via `getIssueByThreadId`, add guard: if `issue.initialProcessing === true`, return `true` (claim the message but skip processing — `forum.js` is handling it)
- After appending context (existing behavior), check `issue.source === 'forum'`
- If forum: scrape full conversation history from the thread, call `evaluateContext(updatedIssue, history)`
  - If `shouldReply`: send `reply` as a plain message (not an embed — more conversational)
  - If `triageUpdate`: update the triage embed with new context summary
  - If `reclassify`: re-run `classifyIssue` with full context and update Firestore + triage embed
  - If `complete`: call `updateIssueFields(issueId, { contextComplete: true, contextCompletedAt: new Date().toISOString() })`, then update triage embed with "Context Complete" badge via `updateContextBadge(guild, updatedIssue, issueId)`
- If not forum: existing behavior unchanged (append, reclassify, generic acknowledgement embed)

The debounce mechanism (5s wait for multiple messages) stays in place — the evaluator runs after debounce settles.

#### `src/services/firestore.js` — New Helper Functions

The spec originally claimed existing functions cover all needs. This is incorrect — two new helpers are needed:

**`updateIssueFields(issueId, fields)`** — generic partial-update function:
```js
async function updateIssueFields(issueId, fields) {
  await db.collection('issues').doc(issueId).update(fields);
}
```
Used to set `contextComplete`, `contextCompletedAt`, `initialProcessing`, and any other ad-hoc field updates without creating a new function per field.

**`getForumIssues(limit = 500)`** — filtered query for forum-sourced issues:
```js
async function getForumIssues(limit = 500) {
  const snapshot = await db.collection('issues')
    .where('source', '==', 'forum')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}
```
Used by `/feedback analyze` and `/feedback status` instead of fetching all issues and filtering in JS. Requires a Firestore composite index on `source` + `createdAt` (Firestore will auto-prompt for this on first query).

Both functions added to `module.exports`.

#### `src/services/triage.js` — Context Complete Badge & Gather Button

**`buildIssueEmbed(issue, issueId)`:**
- If `issue.contextComplete === true`, add a field: `{ name: '✅ Context Complete', value: 'Enough info for a developer to investigate' }`
- If `issue.source === 'forum'` and `issue.contextComplete !== true`, add a field: `{ name: '⏳ Gathering Context', value: 'Pokedex is talking to the reporter' }`

**`buildTriageButtons(issueId)`:**
- Add a new button after Escalate: `triage_gather_{issueId}` with label "💬 Gather Context" (Secondary style)

**New helper `updateContextBadge(guild, issue, issueId)`:**
- Fetches the triage message via `issue.triageMessageId` (already stored on the issue by existing code)
- Rebuilds the embed with `buildIssueEmbed(issue, issueId)`
- Edits the message

#### `src/commands/feedback.js` — Split Into analyze & status

**Breaking change:** The current `/feedback` command has top-level options (`channel`, `limit`, `visibility`). Changing to subcommands requires re-registering the slash command with Discord. The old command definition will be replaced. Users who used `/feedback` will need to use `/feedback analyze` instead. The command re-registration happens automatically on bot startup (existing behavior in `index.js`).

**Command definition** changes from a single command to two subcommands:
- `/feedback analyze [limit] [visibility]` — AI theme report
- `/feedback status [visibility]` — operational dashboard

**`/feedback analyze`:**
- Same concept as current `/feedback` but reads from enriched Firestore issue data instead of raw forum scraping
- Queries `firestore.getForumIssues()` (new helper, avoids fetching all issues)
- Passes full issue data (including `threadContext`, classification, `contextComplete` status) to the AI theme grouping
- The AI analysis is higher quality because it has gathered context, not just raw first messages
- Output unchanged: header embed + per-theme embeds with buttons

**`/feedback status`:**
- Queries forum-sourced issues via `firestore.getForumIssues()`
- Builds a single embed with:
  - **Total posts:** this week / all time
  - **Context status:** `N complete, N awaiting reply, N new`
  - **By category:** `bugs (N), feature requests (N), UX (N), ...`
  - **By priority:** `critical (N), high (N), medium (N), low (N)`
  - **Oldest unresolved:** link to the oldest forum post still awaiting context
- Ephemeral by default, optional `visibility` param for public

#### `src/services/openrouter.js` — Context Evaluator AI Call

Add a new function `evaluateIssueContext(issue, conversationHistory, extraHint?)` that:
- Builds the context evaluator system prompt (checklists, smart behavior rules)
- Formats the conversation history as a readable transcript
- Includes the issue metadata (category, priority, summary, current threadContext)
- If `extraHint` is provided, appends it to the prompt
- Calls OpenRouter with the same model config
- Parses the JSON response into the structured output format
- Falls back gracefully if parsing fails (returns `shouldReply: false, complete: false`)

#### `config.json` — New Config Key

Add `feedback_forum` with default value `"feedback"`. This key will also appear in `/config list` and be settable via `/config set`.

### Firestore Schema Additions

No new collections. The existing `issues` collection gets these fields on forum-sourced issues:

- `source: 'forum'` — distinguishes from mention/reaction/mcp issues
- `forumTags: string[]` — Discord forum tags applied to the post
- `contextComplete: boolean` — set to `true` when evaluator says `complete: true`
- `contextCompletedAt: string` — ISO timestamp of when context was marked complete
- `initialProcessing: boolean` — transient flag, `true` while `forum.js` is processing a new post, `false` after

---

## Behavior Matrix

| Scenario | shouldReply | triageUpdate | reclassify | complete |
|----------|-------------|--------------|------------|----------|
| New forum post, missing details | true (ask follow-up) | null | false | false |
| User provides steps to reproduce | true (ask about expected behavior) | summary of new info | false | false |
| User provides all needed context | true ("Thanks, I have everything I need") | full context summary | true | true |
| User says "thanks" / "cool" / emoji | false | null | false | no change |
| User comes back 3 days later with real info | true (acknowledge + ask if more) | updated summary | true | re-evaluate |
| User says "never mind, fixed itself" | true (acknowledge) | note self-resolved | false | no change |
| Mod clicks "Gather Context" button | true (targeted question from dev perspective) | null | false | no change |
| Issue already context-complete, user adds more | true only if meaningful (AI judgment) | update if meaningful (AI judgment) | true if materially different (AI judgment) | stays true |

---

## What Stays Unchanged

- `src/services/pipeline.js` — forum intake calls the same underlying functions directly
- `src/services/duplicates.js` — no changes
- `src/triggers/mention.js` — no changes
- `src/triggers/reaction.js` — no changes
- Existing issue commands (`/issue close`, `reopen`, `view`, etc.) — all work with forum-sourced issues since they use the same Firestore schema
