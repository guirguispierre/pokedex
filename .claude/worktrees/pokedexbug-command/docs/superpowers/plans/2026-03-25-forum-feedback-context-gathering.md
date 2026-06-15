# Forum Feedback Auto-Context Gathering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pokedex auto-engages users in `#feedback` forum posts to gather enough context so developers can fix issues from `#eng-triage` without further questions.

**Architecture:** New `threadCreate` trigger for forum intake, a context evaluator AI service that decides when/what to reply, and `/feedback` upgraded with `analyze` + `status` subcommands. Builds on existing thread handler, triage system, and OpenRouter AI.

**Tech Stack:** discord.js 14, firebase-admin (Firestore), OpenRouter API

**Spec:** `docs/superpowers/specs/2026-03-25-forum-feedback-context-gathering-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/services/contextEvaluator.js` | AI-powered context evaluation — decides if Pokedex should reply, what to say, and whether context is complete |
| `src/triggers/forum.js` | `threadCreate` handler for `#feedback` forum — intake, classify, save, first follow-up |

### Modified Files
| File | Changes |
|------|---------|
| `src/services/openrouter.js` | Add `evaluateIssueContext()` function for context evaluator AI calls |
| `src/services/firestore.js` | Add `updateIssueFields()` and `getForumIssues()` helpers |
| `src/services/triage.js` | Add context badge to `buildIssueEmbed()`, "Gather Context" button, `updateContextBadge()` helper |
| `src/triggers/thread.js` | Route forum-sourced issues through context evaluator instead of generic response |
| `src/index.js` | Register `threadCreate` event, add `triage_gather_` button handler |
| `src/commands/feedback.js` | Rewrite as `analyze` + `status` subcommands |
| `config.json` | Add `feedback_forum` key |

---

### Task 1: Add Firestore Helpers

**Files:**
- Modify: `src/services/firestore.js:236-259` (module.exports)

- [ ] **Step 1: Add `updateIssueFields` function**

Add before `module.exports` in `src/services/firestore.js`:

```js
async function updateIssueFields(issueId, fields) {
  await db.collection('issues').doc(issueId).update(fields);
}
```

- [ ] **Step 2: Add `getForumIssues` function**

Add after `updateIssueFields`:

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

- [ ] **Step 3: Export both new functions**

Add `updateIssueFields` and `getForumIssues` to the `module.exports` object.

- [ ] **Step 4: Verify syntax**

Run: `node -c src/services/firestore.js`
Expected: no output (clean syntax)

- [ ] **Step 5: Commit**

```bash
git add src/services/firestore.js
git commit -m "feat: add updateIssueFields and getForumIssues Firestore helpers"
```

---

### Task 2: Add `feedback_forum` Config Key

**Files:**
- Modify: `config.json`

- [ ] **Step 1: Add `feedback_forum` to config.json**

Add `"feedback_forum": "feedback"` to `config.json` (after `level_announce`).

- [ ] **Step 2: Commit**

```bash
git add config.json
git commit -m "feat: add feedback_forum config key"
```

---

### Task 3: Add Context Evaluator AI Call to OpenRouter

**Files:**
- Modify: `src/services/openrouter.js:121` (module.exports)

- [ ] **Step 1: Add `evaluateIssueContext` function**

Add before `module.exports` in `src/services/openrouter.js`:

```js
async function evaluateIssueContext(issue, conversationHistory, extraHint) {
  const model = getConfig('model');

  const transcript = conversationHistory
    .map(m => `[${m.isBot ? 'Pokedex' : m.author}]: ${m.content}`)
    .join('\n');

  const contextChecklist = {
    bug: 'steps to reproduce, expected vs actual behavior, environment/platform, frequency, screenshots or logs',
    feature_request: 'use case / problem being solved, current workaround, importance to their workflow',
    ux_issue: 'what they were trying to do, what confused them, where in the app',
    performance: 'what is slow, how slow (quantify), when it started, device/network info',
  };

  const checklist = contextChecklist[issue.category] || contextChecklist.bug;

  const systemPrompt = `You are Pokedex, a triage assistant for poke.com's Discord. Your job is to evaluate whether a reported issue has enough context for a developer to investigate and fix it WITHOUT needing to ask the reporter anything.

## Current Issue
- Summary: ${issue.summary}
- Priority: ${issue.priority}
- Category: ${(issue.category || 'other').replace(/_/g, ' ')}
- Original report: ${(issue.text || '').slice(0, 500)}

## Context Checklist (guidance, not rigid)
For this category, good reports usually include: ${checklist}

## Rules
- Phrase questions naturally and conversationally — never as a checklist
- Skip items the user already covered
- Ask off-script questions if something unexpected comes up
- Return shouldReply: false for non-substantive messages (thanks, cool, emojis, greetings)
- Return shouldReply: true with a triageUpdate when meaningful new context arrives, even days later
- Return reclassify: true when new info could change priority or category
- Mark complete: true ONLY when a developer would have enough to start working without further questions
- If user says "never mind" / "fixed itself" — acknowledge warmly, note self-resolved
- Keep replies short, friendly, and focused — one question at a time
${extraHint ? `\n## Additional Instruction\n${extraHint}` : ''}

Return ONLY valid JSON:
{
  "complete": boolean,
  "missing": ["what is still needed"],
  "shouldReply": boolean,
  "reply": "what to say to the user" or null,
  "triageUpdate": "new context summary for the engineering triage embed" or null,
  "reclassify": boolean
}`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://poke.com',
        'X-Title': 'Pokedex Context Evaluator',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Conversation so far:\n${transcript}` },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error(`Context evaluator API error: ${response.status}`);
      return { complete: false, missing: [], shouldReply: false, reply: null, triageUpdate: null, reclassify: false };
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(content);
    return {
      complete: !!parsed.complete,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      shouldReply: !!parsed.shouldReply,
      reply: typeof parsed.reply === 'string' ? parsed.reply : null,
      triageUpdate: typeof parsed.triageUpdate === 'string' ? parsed.triageUpdate : null,
      reclassify: !!parsed.reclassify,
    };
  } catch (err) {
    console.error('Context evaluator failed:', err.message);
    return { complete: false, missing: [], shouldReply: false, reply: null, triageUpdate: null, reclassify: false };
  }
}
```

- [ ] **Step 2: Export the new function**

Change `module.exports = { classifyIssue };` to `module.exports = { classifyIssue, evaluateIssueContext };`

- [ ] **Step 3: Verify syntax**

Run: `node -c src/services/openrouter.js`
Expected: no output (clean syntax)

- [ ] **Step 4: Commit**

```bash
git add src/services/openrouter.js
git commit -m "feat: add evaluateIssueContext AI call for context evaluator"
```

---

### Task 4: Create Context Evaluator Service

**Files:**
- Create: `src/services/contextEvaluator.js`

- [ ] **Step 1: Create the file**

```js
const { evaluateIssueContext } = require('./openrouter');
const { classifyIssue } = require('./openrouter');
const firestore = require('./firestore');
const { buildIssueEmbed, findTriageChannel } = require('./triage');

async function evaluateContext(issue, conversationHistory, extraHint) {
  return evaluateIssueContext(issue, conversationHistory, extraHint);
}

async function processEvaluation(guild, issue, issueId, evaluation) {
  // Update triage embed if there's new context to show
  if (evaluation.triageUpdate && issue.triageMessageId) {
    const triageChannel = findTriageChannel(guild);
    if (triageChannel) {
      try {
        const triageMsg = await triageChannel.messages.fetch(issue.triageMessageId);
        const embed = buildIssueEmbed(issue, issueId);
        embed.addFields({ name: '💬 Context Update', value: evaluation.triageUpdate.slice(0, 1024) });
        embed.setTimestamp();
        await triageMsg.edit({ embeds: [embed] });
      } catch {
        // Triage message may have been deleted
      }
    }
  }

  // Reclassify if needed
  if (evaluation.reclassify) {
    const threadContext = issue.threadContext || [];
    const additionalInfo = threadContext.map(c => c.text).join('\n');
    const fullContext = `Original report: ${issue.text}\n\nAdditional information:\n${additionalInfo}`;
    const newClassification = await classifyIssue(fullContext);
    await firestore.updateIssueClassification(issueId, newClassification);
  }

  // Mark context complete
  if (evaluation.complete && !issue.contextComplete) {
    await firestore.updateIssueFields(issueId, {
      contextComplete: true,
      contextCompletedAt: new Date().toISOString(),
    });
    await updateContextBadge(guild, { ...issue, contextComplete: true }, issueId);
  }
}

async function updateContextBadge(guild, issue, issueId) {
  if (!issue.triageMessageId) return;
  const triageChannel = findTriageChannel(guild);
  if (!triageChannel) return;

  try {
    const triageMsg = await triageChannel.messages.fetch(issue.triageMessageId);
    const embed = buildIssueEmbed(issue, issueId);
    embed.setTimestamp();
    await triageMsg.edit({ embeds: [embed] });
  } catch {
    // Triage message may have been deleted
  }
}

function buildConversationHistory(messages) {
  return messages.map(m => ({
    author: m.author?.username || 'unknown',
    isBot: m.author?.bot || false,
    content: m.content || '',
    attachments: [...(m.attachments?.values() || [])].map(a => ({ url: a.url, name: a.name })),
    createdAt: m.createdAt?.toISOString() || new Date().toISOString(),
  }));
}

module.exports = { evaluateContext, processEvaluation, updateContextBadge, buildConversationHistory };
```

- [ ] **Step 2: Verify syntax**

Run: `node -c src/services/contextEvaluator.js`
Expected: no output (clean syntax)

- [ ] **Step 3: Commit**

```bash
git add src/services/contextEvaluator.js
git commit -m "feat: create context evaluator service"
```

---

### Task 5: Add Context Badge and Gather Button to Triage

**Files:**
- Modify: `src/services/triage.js:14-42` (buildTriageButtons)
- Modify: `src/services/triage.js:44-94` (buildIssueEmbed)
- Modify: `src/services/triage.js:182` (module.exports)

- [ ] **Step 1: Rewrite `buildTriageButtons` to return two rows**

Discord allows max 5 buttons per row. With 6 buttons we need two rows. Replace the entire `buildTriageButtons` function in `src/services/triage.js`:

```js
function buildTriageButtons(issueId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`triage_ack_${issueId}`)
      .setLabel('Acknowledged')
      .setEmoji('👀')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`triage_fix_${issueId}`)
      .setLabel('Fixed')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`triage_wontfix_${issueId}`)
      .setLabel("Won't Fix")
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`triage_escalate_${issueId}`)
      .setLabel('Escalate')
      .setEmoji('🔺')
      .setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`triage_delete_${issueId}`)
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`triage_gather_${issueId}`)
      .setLabel('Gather Context')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}
```

`buildTriageButtons` now returns an array of `ActionRowBuilder`s instead of a single one.

- [ ] **Step 2: Add context status badge to `buildIssueEmbed`**

In `src/services/triage.js`, add after the attachments block (before `return embed;` at line 93):

```js
  if (issue.contextComplete === true) {
    embed.addFields({ name: '✅ Context Complete', value: 'Enough info for a developer to investigate' });
  } else if (issue.source === 'forum' && issue.contextComplete !== true) {
    embed.addFields({ name: '⏳ Gathering Context', value: 'Pokedex is talking to the reporter' });
  }
```

- [ ] **Step 3: Update `postIssueEmbed` to handle button array**

Change line 112-113 from:
```js
  const buttons = buildTriageButtons(issueId);
  const msg = await channel.send({ embeds: [embed], components: [buttons] });
```
To:
```js
  const buttons = buildTriageButtons(issueId);
  const msg = await channel.send({ embeds: [embed], components: buttons });
```

- [ ] **Step 3b: Update button-disabling logic in `src/index.js` to handle multiple rows**

The existing button handler (index.js lines 296-308) only processes `message.components[0].components`. With two rows, it must iterate all rows. Replace the button-disabling block:

```js
    // Disable buttons after action and highlight the one clicked
    const updatedRows = message.components.map(row => {
      const updatedRow = new ActionRowBuilder();
      for (const component of row.components) {
        const btn = ButtonBuilder.from(component);
        if (component.customId === customId) {
          btn.setDisabled(false);
          btn.setStyle(2);
        } else {
          btn.setDisabled(true);
        }
        updatedRow.addComponents(btn);
      }
      return updatedRow;
    });

    await interaction.update({ embeds: [embed], components: updatedRows });
```

- [ ] **Step 4: Verify syntax**

Run: `node -c src/services/triage.js`
Expected: no output (clean syntax)

- [ ] **Step 5: Commit**

```bash
git add src/services/triage.js
git commit -m "feat: add context badge and gather context button to triage embeds"
```

---

### Task 6: Create Forum Trigger

**Files:**
- Create: `src/triggers/forum.js`

- [ ] **Step 1: Create the forum trigger**

```js
const { ChannelType } = require('discord.js');
const { getConfig } = require('../config/config');
const { classifyIssue } = require('../services/openrouter');
const firestore = require('../services/firestore');
const { postIssueEmbed } = require('../services/triage');
const { evaluateContext, buildConversationHistory } = require('../services/contextEvaluator');

const STARTER_MSG_RETRIES = 3;
const STARTER_MSG_DELAY_MS = 2000;

async function handleForumPost(thread) {
  // Only handle forum channel threads
  if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

  // Check if this is the configured feedback forum
  const feedbackForum = getConfig('feedback_forum') || 'feedback';
  const parentName = thread.parent.name.toLowerCase();
  const parentId = thread.parent.id;
  if (parentName !== feedbackForum.toLowerCase() && parentId !== feedbackForum) return;

  // Join the thread so the bot can send messages
  try {
    await thread.join();
  } catch (err) {
    console.error('Failed to join forum thread:', err.message);
    return;
  }

  // Fetch starter message with retries
  let starterMessage = null;
  for (let i = 0; i < STARTER_MSG_RETRIES; i++) {
    try {
      starterMessage = await thread.fetchStarterMessage();
      if (starterMessage) break;
    } catch {
      // May not be available yet
    }
    await new Promise(resolve => setTimeout(resolve, STARTER_MSG_DELAY_MS));
  }

  if (!starterMessage || !starterMessage.content?.trim()) {
    console.warn(`Forum thread ${thread.id} has no starter message after retries — skipping`);
    return;
  }

  const text = starterMessage.content.trim();
  const guild = thread.guild;

  // Resolve reporter name early for the placeholder issue
  let reporterName = 'unknown';
  try {
    const member = await guild.members.fetch(thread.ownerId);
    reporterName = member.user.username;
  } catch {
    reporterName = starterMessage.author?.username || 'unknown';
  }

  // Phase 1: Save a placeholder issue with initialProcessing=true
  // This prevents thread.js from double-processing the starter message
  const placeholderData = {
    source: 'forum',
    threadId: thread.id,
    channelId: thread.parentId,
    guildId: guild.id,
    messageId: starterMessage.id,
    reporterId: thread.ownerId,
    reporterName,
    text,
    priority: 'unclassified',
    category: 'other',
    summary: text.slice(0, 100),
    reasoning: 'Pending classification',
    initialProcessing: true,
  };
  const issueId = await firestore.saveIssue(placeholderData);

  // Phase 2: Classify while the guard is active
  // Resolve forum tags
  const availableTags = thread.parent.availableTags || [];
  const forumTags = (thread.appliedTags || []).map(tagId => {
    const tag = availableTags.find(t => t.id === tagId);
    return tag?.name || 'unknown';
  });

  const classificationInput = `${thread.name}\n\n${text}`;
  const classification = await classifyIssue(classificationInput);

  // Collect attachments from starter message
  const attachments = [...starterMessage.attachments.values()].map(a => ({
    url: a.url,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    isImage: a.contentType?.startsWith('image/') || false,
  }));

  // Phase 3: Update the issue with full classification and clear the guard
  await firestore.updateIssueFields(issueId, {
    forumTags,
    priority: classification.priority,
    category: classification.category,
    summary: classification.summary,
    reasoning: classification.reasoning,
    attachments,
    initialProcessing: false,
  });

  // Post triage embed
  const savedIssue = await firestore.getIssueById(issueId);
  const triageMessageId = await postIssueEmbed(guild, savedIssue, issueId);
  if (triageMessageId) {
    await firestore.updateIssueTriageMessageId(issueId, triageMessageId);
  }

  // Re-fetch issue so it has triageMessageId for the evaluator
  const issueWithTriage = await firestore.getIssueById(issueId);

  // Run context evaluator for first follow-up
  const history = buildConversationHistory([starterMessage]);
  const evaluation = await evaluateContext(issueWithTriage, history);

  if (evaluation.shouldReply && evaluation.reply) {
    await thread.send(evaluation.reply);
  }
}

module.exports = { handleForumPost };
```

- [ ] **Step 2: Verify syntax**

Run: `node -c src/triggers/forum.js`
Expected: no output (clean syntax)

- [ ] **Step 3: Commit**

```bash
git add src/triggers/forum.js
git commit -m "feat: add forum trigger for auto-intake of feedback posts"
```

---

### Task 7: Update Thread Handler for Forum Issues

**Files:**
- Modify: `src/triggers/thread.js`

- [ ] **Step 1: Add imports**

Add at the top of `src/triggers/thread.js`, after existing imports:

```js
const { evaluateContext, processEvaluation, buildConversationHistory } = require('../services/contextEvaluator');
```

- [ ] **Step 2: Add initialProcessing guard**

In `handleThreadMessage`, after `const issue = await firestore.getIssueByThreadId(threadId);` and the `if (!issue) return false;` check, add:

```js
  // Guard: forum.js is still processing this thread — don't interfere
  if (issue.initialProcessing) return true;
```

- [ ] **Step 3: Add forum-specific context evaluation path**

Inside the debounced `setTimeout` callback (where the reclassification happens), wrap the existing logic in an `if/else` on `issue.source`:

After `const updatedIssue = await firestore.getIssueByThreadId(threadId);` and `if (!updatedIssue) return;`, replace the existing reclassification + triage update + thread acknowledgement logic with:

```js
      if (updatedIssue.source === 'forum') {
        // Forum issues: use context evaluator for smart replies
        const allMessages = [];
        let lastId;
        while (true) {
          const batch = await message.channel.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
          if (batch.size === 0) break;
          allMessages.push(...batch.values());
          lastId = batch.last().id;
          if (batch.size < 100) break;
        }
        allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        const history = buildConversationHistory(allMessages);
        const evaluation = await evaluateContext(updatedIssue, history);

        // Process triage updates, reclassification, and context complete badge
        await processEvaluation(message.guild, updatedIssue, updatedIssue.id, evaluation);

        // Reply in the thread if evaluator says to
        if (evaluation.shouldReply && evaluation.reply) {
          await message.channel.send(evaluation.reply);
        }
      } else {
        // Non-forum issues: existing behavior (reclassify + generic acknowledgement)
        // ... keep all existing code here unchanged ...
      }
```

The existing code (lines ~49-114 of thread.js) goes inside the `else` block unchanged.

- [ ] **Step 4: Verify syntax**

Run: `node -c src/triggers/thread.js`
Expected: no output (clean syntax)

- [ ] **Step 5: Commit**

```bash
git add src/triggers/thread.js
git commit -m "feat: route forum issues through context evaluator in thread handler"
```

---

### Task 8: Register Forum Trigger and Gather Button in index.js

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add forum trigger import**

Add near the top of `src/index.js`, alongside other trigger imports:

```js
const { handleForumPost } = require('./triggers/forum');
```

- [ ] **Step 2: Register `threadCreate` event**

Add after the `client.on('messageCreate', ...)` handler (after line ~138):

```js
client.on('threadCreate', async (thread) => {
  try {
    await handleForumPost(thread);
  } catch (err) {
    console.error('Error handling forum post:', err);
  }
});
```

- [ ] **Step 3: Add `gather` button handler**

In `handleButtonInteraction`, after the `if (action === 'delete') { ... return; }` block (after line ~276), add:

```js
    // Handle gather context — send Pokedex to the forum thread to ask more questions
    if (action === 'gather') {
      try {
        const issue = await firestore.getIssueById(issueId);
        if (!issue?.threadId) {
          await interaction.reply({ content: 'This issue has no linked thread.', ephemeral: true });
          return;
        }

        const thread = await interaction.guild.channels.fetch(issue.threadId);
        if (!thread) {
          await interaction.reply({ content: 'Could not find the linked thread.', ephemeral: true });
          return;
        }

        // Unarchive if needed
        if (thread.archived) {
          await thread.setArchived(false);
        }

        // Scrape conversation history
        const allMessages = [];
        let lastId;
        while (true) {
          const batch = await thread.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
          if (batch.size === 0) break;
          allMessages.push(...batch.values());
          lastId = batch.last().id;
          if (batch.size < 100) break;
        }
        allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        const { evaluateContext, buildConversationHistory } = require('./services/contextEvaluator');
        const history = buildConversationHistory(allMessages);
        const evaluation = await evaluateContext(issue, history, 'A developer needs more information on this issue.');

        if (evaluation.shouldReply && evaluation.reply) {
          await thread.send(evaluation.reply);
          await interaction.reply({ content: 'Sent follow-up in the forum post.', ephemeral: true });
        } else {
          await interaction.reply({ content: 'Context evaluator decided no follow-up is needed right now.', ephemeral: true });
        }
      } catch (err) {
        console.error('Failed to gather context:', err);
        await interaction.reply({ content: 'Failed to send follow-up.', ephemeral: true });
      }
      return;
    }
```

- [ ] **Step 4: Verify syntax**

Run: `node -c src/index.js`
Expected: no output (clean syntax)

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat: register forum trigger and gather context button handler"
```

---

### Task 9: Rewrite /feedback Command with analyze and status Subcommands

**Files:**
- Modify: `src/commands/feedback.js`

**Note: Breaking change.** The old `/feedback` accepted a `channel` option to analyze any channel. The new `/feedback analyze` reads from Firestore (forum issues ingested by the trigger) only. This is intentional — the forum trigger now handles intake, and `/feedback analyze` works on the enriched data. Users who need to analyze a different channel can configure `feedback_forum` via `/config set`.

- [ ] **Step 1: Rewrite command definition**

Replace the `commandData` definition (lines 48-66) with:

```js
const commandData = new SlashCommandBuilder()
  .setName('feedback')
  .setDescription('Analyze and manage feedback from the forum')
  .addSubcommand(sub =>
    sub.setName('analyze')
      .setDescription('AI theme analysis of feedback forum posts')
      .addIntegerOption(opt =>
        opt.setName('limit')
          .setDescription('Max issues to analyze (default: 20)')
          .setRequired(false))
      .addStringOption(opt =>
        opt.setName('visibility')
          .setDescription('Who can see the response')
          .setRequired(false)
          .addChoices(
            { name: 'Only me', value: 'ephemeral' },
            { name: 'Everyone', value: 'public' },
          )))
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Dashboard overview of feedback pipeline health')
      .addStringOption(opt =>
        opt.setName('visibility')
          .setDescription('Who can see the response')
          .setRequired(false)
          .addChoices(
            { name: 'Only me', value: 'ephemeral' },
            { name: 'Everyone', value: 'public' },
          )));
```

- [ ] **Step 2: Rewrite `execute` function**

Replace the `execute` function with a router:

```js
async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'analyze') return handleAnalyze(interaction);
  if (sub === 'status') return handleStatus(interaction);
  return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}
```

- [ ] **Step 3: Write `handleAnalyze`**

This replaces the old `execute` function. It reads from enriched Firestore data instead of scraping raw forum threads:

```js
async function handleAnalyze(interaction) {
  const limit = interaction.options.getInteger('limit') || 20;
  const visibility = interaction.options.getString('visibility') || 'ephemeral';
  const ephemeral = visibility === 'ephemeral';

  await interaction.deferReply({ ephemeral });

  const guild = interaction.guild;

  // Read from enriched Firestore data instead of raw forum scraping
  let issues = await firestore.getForumIssues(limit);

  if (issues.length === 0) {
    return interaction.editReply('No forum feedback issues found. Make sure the forum trigger is active.');
  }

  // Build enriched feedback data from issues
  const feedbackData = issues.map((issue, i) => ({
    name: issue.summary || 'Untitled',
    authorName: issue.reporterName || 'unknown',
    messageCount: (issue.threadContext || []).length,
    tags: issue.forumTags || [],
    firstMessage: buildEnrichedText(issue),
  }));

  const analysis = await organizeFeedback(feedbackData);
  if (!analysis) {
    return interaction.editReply('Failed to analyze feedback. Try again later.');
  }

  // Save each theme as an issue
  const savedIssueIds = [];
  for (const theme of (analysis.themes || [])) {
    try {
      const issueData = {
        messageId: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        guildId: guild.id,
        channelId: 'feedback-analysis',
        reporterId: interaction.user.id,
        reporterName: interaction.user.username,
        text: `[Feedback Theme] ${theme.description || ''}\n\nUser quotes: ${(theme.user_quotes || []).join(' | ')}\n\nSuggested action: ${theme.suggested_action || 'None'}`,
        priority: theme.priority || 'medium',
        category: theme.category || 'feature_request',
        summary: theme.name || 'Feedback theme',
        reasoning: theme.priority_reasoning || 'From /feedback analyze',
        source: 'feedback',
      };
      const issueId = await firestore.saveIssue(issueData);
      savedIssueIds.push(issueId);
    } catch (err) {
      console.error('Failed to save feedback theme:', err.message);
      savedIssueIds.push(null);
    }
  }

  const triageChannel = findTriageChannel(guild);
  if (triageChannel) {
    await postToTriage(triageChannel, analysis, { name: 'feedback' }, feedbackData.length, interaction.user.username, savedIssueIds);
  }

  await sendAnalysisReply(interaction, analysis, { name: 'feedback' }, feedbackData.length, !!triageChannel, savedIssueIds.filter(Boolean).length);
}

function buildEnrichedText(issue) {
  let text = issue.text || '';
  const context = (issue.threadContext || []).map(c => c.text).join('\n');
  if (context) {
    text += `\n\nAdditional context from conversation:\n${context}`;
  }
  if (issue.contextComplete) {
    text += '\n\n[Context gathering complete]';
  }
  return text.slice(0, 2000);
}
```

- [ ] **Step 4: Write `handleStatus`**

```js
async function handleStatus(interaction) {
  const visibility = interaction.options.getString('visibility') || 'ephemeral';
  const ephemeral = visibility === 'ephemeral';

  await interaction.deferReply({ ephemeral });

  const issues = await firestore.getForumIssues();

  // Calculate stats
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thisWeek = issues.filter(i => {
    const created = i.createdAt?.toDate?.() || new Date(i.createdAt);
    return created >= weekAgo;
  });

  const complete = issues.filter(i => i.contextComplete === true && i.status === 'open').length;
  const awaiting = issues.filter(i => !i.contextComplete && i.status === 'open').length;
  const newThisWeek = thisWeek.length;

  // By category
  const byCategory = {};
  for (const issue of issues.filter(i => i.status === 'open')) {
    const cat = (issue.category || 'other').replace(/_/g, ' ');
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  // By priority
  const byPriority = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues.filter(i => i.status === 'open')) {
    const p = issue.priority || 'low';
    if (byPriority[p] !== undefined) byPriority[p]++;
  }

  // Oldest awaiting context
  const oldestAwaiting = issues
    .filter(i => !i.contextComplete && i.status === 'open')
    .sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() || new Date(a.createdAt);
      const bTime = b.createdAt?.toDate?.() || new Date(b.createdAt);
      return aTime - bTime;
    })[0];

  const categoryLines = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `${cat}: **${count}**`)
    .join(' | ') || 'none';

  const embed = new EmbedBuilder()
    .setTitle('📊 Feedback Pipeline Status')
    .setColor(0x5865f2)
    .addFields(
      { name: '📝 Total Forum Issues', value: `This week: **${newThisWeek}** | All time: **${issues.length}**`, inline: false },
      { name: '📋 Context Status', value: `✅ Complete: **${complete}** | ⏳ Awaiting reply: **${awaiting}** | 🆕 New this week: **${newThisWeek}**`, inline: false },
      { name: '📂 By Category', value: categoryLines, inline: false },
      { name: '🎯 By Priority', value: `🔴 Critical: **${byPriority.critical}** | 🟠 High: **${byPriority.high}** | 🟡 Medium: **${byPriority.medium}** | 🟢 Low: **${byPriority.low}**`, inline: false },
    )
    .setTimestamp();

  if (oldestAwaiting) {
    const created = oldestAwaiting.createdAt?.toDate?.() || new Date(oldestAwaiting.createdAt);
    const timestamp = Math.floor(created.getTime() / 1000);
    embed.addFields({
      name: '⏰ Oldest Awaiting Context',
      value: `\`${oldestAwaiting.id}\` — ${oldestAwaiting.summary || 'No summary'} (<t:${timestamp}:R>)`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
```

- [ ] **Step 5: Keep existing helper functions**

The existing `organizeFeedback`, `findFeedbackChannel`, `postToTriage`, `sendAnalysisReply`, `buildFeedbackThemeButtons`, and `buildFeedbackThemeButtonsWithId` functions stay as-is. Only the command definition and `execute` function change.

- [ ] **Step 6: Verify syntax**

Run: `node -c src/commands/feedback.js`
Expected: no output (clean syntax)

- [ ] **Step 7: Commit**

```bash
git add src/commands/feedback.js
git commit -m "feat: rewrite /feedback with analyze and status subcommands"
```

---

### Task 10: Smoke Test and Final Verification

- [ ] **Step 1: Verify all files have clean syntax**

Run: `node -c src/services/firestore.js && node -c src/services/openrouter.js && node -c src/services/contextEvaluator.js && node -c src/services/triage.js && node -c src/triggers/forum.js && node -c src/triggers/thread.js && node -c src/index.js && node -c src/commands/feedback.js && echo "All files OK"`

Expected: `All files OK`

- [ ] **Step 2: Verify the bot starts without import errors**

Run: `timeout 5 node src/index.js 2>&1 || true`

Look for: no `MODULE_NOT_FOUND` errors. The bot will fail to connect (no token in dev) but imports should resolve.

- [ ] **Step 3: Commit any fixes if needed**

- [ ] **Step 4: Final commit with version bump**

Update `src/commands/ping.js` BOT_VERSION to `'2.2.0'`, add changelog entry to `src/commands/changelog.js`, update `package.json` version.

```bash
git add -A
git commit -m "feat: forum feedback auto-context gathering and /feedback upgrade (v2.2.0)"
```

- [ ] **Step 5: Push**

```bash
git push origin main
```
