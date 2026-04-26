# Smarter Per-Report Bug Triage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-shot classification with an agent-loop-based triage pipeline that reads screenshots, uses tools (issue search, status API, channel context), routes Pokedex-self reports to `#pokedex-testing`, and maintains a deduped capability-gap backlog.

**Architecture:** New `agentTriage.js` orchestrates a tool-calling loop against OpenRouter. Three tool modules under `src/services/agentTools/` (search_issues, get_poke_status, read_channel_context) return structured results. `pipeline.js` delegates classification to the agent loop and routes the resulting issue to `eng-triage` or `#pokedex-testing` based on a new `target` field. `capabilityGap.js` owns dedup and channel posting for gap reports. Thread and mention triggers gain smarter behavior (response modes, auto-resolve, parent-message context).

**Tech Stack:** Node.js 18+, CommonJS, discord.js 14, firebase-admin, OpenRouter (Anthropic Claude Sonnet 4 via OpenAI-compatible API), `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-04-24-smarter-bug-triage-design.md`

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/services/agentTriage.js` | Loop orchestrator. `triageIssue(text, images, ctx)` → classification. |
| `src/services/agentTools/index.js` | Tool registry. Exports `TOOL_SCHEMAS` + `dispatch(name, args, ctx)`. |
| `src/services/agentTools/searchIssues.js` | Pure(ish) function — searches open issues using Jaccard. |
| `src/services/agentTools/getStatus.js` | Wraps `statusFetcher.fetchSummary()`. |
| `src/services/agentTools/readChannel.js` | Fetches last N Discord messages via bot's client. |
| `src/services/capabilityGap.js` | Normalize/dedup gaps + post/edit in `#pokedex-testing`. |
| `test/agentTools/searchIssues.test.js` | Unit tests — query shaping, similarity ordering. |
| `test/agentTools/readChannel.test.js` | Unit tests — channelId comes from ctx not args. |
| `test/agentTools/dispatch.test.js` | Unit tests — unknown tool, error shape. |
| `test/capabilityGap.test.js` | Unit tests — key normalization, threshold. |
| `test/triage-routing.test.js` | Unit tests — target → channel selection. |
| `test/autoResolve.test.js` | Unit tests — reporter check, hedged language. |
| `test/agentTriage-fallback.test.js` | Unit tests — budget exhaust, invalid JSON. |
| `test/thread-rate-limit.test.js` | Unit tests — 3-per-10min sliding window. |
| `test/mention-parent-context.test.js` | Unit tests — reference fetch path. |
| `test/helpers/mocks.js` | Shared mock factories (Firestore, Discord, OpenRouter). |

**Modified files:**

| Path | Change |
|---|---|
| `src/services/openrouter.js` | Add `callWithTools(messages, tools, images)` single-turn helper. |
| `src/services/pipeline.js` | Call `agentTriage.triageIssue` instead of `classifyIssue`; route by `target`. |
| `src/services/triage.js` | `findTriageChannel(guild, target)` + pokedex-self embed variant. |
| `src/services/firestore.js` | Add `searchOpenIssuesForAgent`, `updateIssueResolution`, `lastEvaluatedAt` helpers; gap collection CRUD. |
| `src/services/contextEvaluator.js` | Expand schema (`responseMode`, `resolved`, `resolvedReason`, image collection). |
| `src/triggers/thread.js` | Unify forum and non-forum paths; apply `responseMode`; rate limit; auto-resolve. |
| `src/triggers/mention.js` | Fetch `message.reference` if present; handle `mentionType`. |
| `src/commands/pokedexbug.js` | Force `target: "pokedex_bot"`; run agent path. |
| `src/config/config.js` | (No code change — just ensure new keys are in `config.json` so `getAllConfig` exposes them.) |
| `config.json` | Add 5 new keys. |
| `package.json` | `"test": "node --test test/"`; version 2.8.2 → 2.9.0. |
| `CHANGELOG.md` | New `## 2.9.0` section. |

---

## Phase 0 — Branch + test harness

### Task 1: Create branch and test harness

**Files:**
- Modify: `package.json`
- Create: `test/helpers/mocks.js`
- Create: `test/smoke.test.js`

- [ ] **Step 1: Create the implementation branch off main**

```bash
git fetch origin
git checkout -b feat/smarter-bug-triage origin/main
```

Expected: Switched to a new branch.

- [ ] **Step 2: Add `test` script to package.json**

Read `package.json`, find the `"scripts"` block. It currently has:

```json
"scripts": {
  "start": "node src/index.js"
}
```

Change to:

```json
"scripts": {
  "start": "node src/index.js",
  "test": "node --test test/"
}
```

- [ ] **Step 3: Create shared test mocks file**

Create `test/helpers/mocks.js`:

```js
// Shared mock factories for unit tests. No network, no secrets.

function fakeFirestore({ issues = [], gaps = [] } = {}) {
  const issuesById = new Map(issues.map(i => [i.id, { ...i }]));
  const gapsByKey = new Map(gaps.map(g => [g.normalizedKey, { ...g }]));

  return {
    async getOpenIssues(limit = 100) {
      return Array.from(issuesById.values())
        .filter(i => (i.status || 'open') === 'open')
        .slice(0, limit);
    },
    async getIssueById(id) {
      const i = issuesById.get(id);
      return i ? { ...i } : null;
    },
    async saveIssue(data) {
      const id = `issue_${issuesById.size + 1}`;
      issuesById.set(id, { id, status: 'open', ...data });
      return id;
    },
    async updateIssueFields(id, fields) {
      const existing = issuesById.get(id);
      if (!existing) throw new Error(`no issue ${id}`);
      issuesById.set(id, { ...existing, ...fields });
    },
    async getGapByKey(key) {
      const g = gapsByKey.get(key);
      return g ? { ...g } : null;
    },
    async createGap(data) {
      const id = `gap_${gapsByKey.size + 1}`;
      gapsByKey.set(data.normalizedKey, { id, ...data });
      return id;
    },
    async updateGap(key, fields) {
      const existing = gapsByKey.get(key);
      if (!existing) throw new Error(`no gap ${key}`);
      gapsByKey.set(key, { ...existing, ...fields });
    },
    _issuesById: issuesById,
    _gapsByKey: gapsByKey,
  };
}

function fakeChannel({ id = 'chan1', name = 'general', messages = [] } = {}) {
  return {
    id,
    name,
    isTextBased: () => true,
    messages: {
      fetch: async ({ limit = 50 } = {}) => {
        const msgs = messages.slice(-limit);
        return {
          size: msgs.length,
          values: () => msgs[Symbol.iterator](),
          [Symbol.iterator]: () => msgs[Symbol.iterator](),
          last: () => msgs[msgs.length - 1],
          first: () => msgs[0],
        };
      },
    },
    send: async (payload) => ({ id: `msg_${Date.now()}`, edit: async () => {}, payload }),
  };
}

function fakeGuild({ channels = [] } = {}) {
  const cache = new Map(channels.map(c => [c.id, c]));
  return {
    channels: {
      cache: {
        find: (predicate) => {
          for (const c of cache.values()) if (predicate(c)) return c;
          return null;
        },
        get: (id) => cache.get(id) || null,
        values: () => cache.values(),
      },
      fetch: async (id) => cache.get(id) || null,
    },
  };
}

function fakeMessage({
  id = 'm1',
  content = '',
  authorId = 'u1',
  authorUsername = 'tester',
  isBot = false,
  attachments = [],
  reference = null,
  channelId = 'chan1',
  createdAt = new Date(),
} = {}) {
  return {
    id,
    content,
    author: { id: authorId, username: authorUsername, bot: isBot },
    attachments: new Map(attachments.map((a, i) => [`att${i}`, a])),
    reference,
    channel: { id: channelId },
    createdAt,
    createdTimestamp: createdAt.getTime(),
    reply: async (payload) => ({ id: `reply_${Date.now()}`, payload }),
    react: async () => {},
  };
}

function fakeOpenRouterResponder(sequence) {
  // sequence: [{ tool_calls: [...] } | { content: '<json string>' } | Error]
  let i = 0;
  return async () => {
    if (i >= sequence.length) throw new Error('responder exhausted');
    const item = sequence[i++];
    if (item instanceof Error) throw item;
    return item;
  };
}

module.exports = {
  fakeFirestore,
  fakeChannel,
  fakeGuild,
  fakeMessage,
  fakeOpenRouterResponder,
};
```

- [ ] **Step 4: Create a smoke test to verify the runner works**

Create `test/smoke.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 5: Run tests to verify harness**

Run: `npm test`
Expected: `# tests 1` / `# pass 1` / `# fail 0`. Process exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json test/smoke.test.js test/helpers/mocks.js
git commit -m "$(cat <<'EOF'
chore(test): bootstrap node --test harness with shared mocks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 1 — Config and Firestore foundations

### Task 2: Add new config keys

**Files:**
- Modify: `config.json`

Config override validation (`src/config/config.js:37`) rejects keys not present in `config.json` defaults. All new keys must be added here.

- [ ] **Step 1: Read current `config.json` to confirm its shape**

Run: `cat config.json`
Expected: JSON object with `model`, `triage_channel`, etc.

- [ ] **Step 2: Add five new keys to `config.json`**

Merge these keys into the existing object (keep all current keys; add these; preserve alphabetical-ish grouping where possible):

```json
"pokedex_owner_id": null,
"pokedex_self_channel": "pokedex-testing",
"agent_enabled": true,
"agent_max_tool_calls": 5,
"agent_max_replies_per_thread_per_10m": 3
```

- [ ] **Step 3: Verify via a one-liner**

Run: `node -e "const c = require('./config.json'); console.log(['pokedex_owner_id','pokedex_self_channel','agent_enabled','agent_max_tool_calls','agent_max_replies_per_thread_per_10m'].map(k => [k, c[k]]))"`
Expected: Array showing each key with its default value.

- [ ] **Step 4: Commit**

```bash
git add config.json
git commit -m "$(cat <<'EOF'
feat(config): add agent triage config defaults

Adds pokedex_owner_id, pokedex_self_channel, agent_enabled,
agent_max_tool_calls, agent_max_replies_per_thread_per_10m
so /config set autocomplete can expose them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Firestore helpers for agent triage

**Files:**
- Modify: `src/services/firestore.js`

Adds: `searchOpenIssuesForAgent`, `updateIssueResolution`, `updateIssueFields`, `setIssueLastEvaluatedAt`, gap CRUD (`getGapByKey`, `createGap`, `updateGap`).

The spec requires issue docs to gain `target`, `lastEvaluatedAt`, `agentMeta`, and resolution fields. Those are set by existing `saveIssue` and new update functions — no schema migration needed (Firestore is schemaless).

- [ ] **Step 1: Read `src/services/firestore.js` end to understand current shape**

Run: `wc -l src/services/firestore.js`
Expected: A line count (typically 200+). Read the file to see existing exports and patterns.

- [ ] **Step 2: Add new helpers at the end of the functions block (before `module.exports`)**

Open `src/services/firestore.js`. Just before the `module.exports = {...}` line, add:

```js
async function updateIssueFields(issueId, fields) {
  await db.collection('issues').doc(issueId).update(fields);
}

async function setIssueLastEvaluatedAt(issueId, iso) {
  await db.collection('issues').doc(issueId).update({ lastEvaluatedAt: iso });
}

async function updateIssueResolution(issueId, { resolvedBy, resolvedReason }) {
  await db.collection('issues').doc(issueId).update({
    status: 'resolved',
    resolvedAt: new Date().toISOString(),
    resolvedBy,
    resolvedReason: resolvedReason || null,
  });
}

async function searchOpenIssuesForAgent(_query, limit = 50) {
  // Tool loads recent open issues; ranking happens in the tool via Jaccard.
  // Firestore doesn't do text search natively; we return a working set.
  const snapshot = await db.collection('issues')
    .where('status', '==', 'open')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getGapByKey(normalizedKey) {
  const snapshot = await db.collection('capability_gaps')
    .where('normalizedKey', '==', normalizedKey)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function createGap(data) {
  const docRef = await db.collection('capability_gaps').add({
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return docRef.id;
}

async function updateGap(gapId, fields) {
  await db.collection('capability_gaps').doc(gapId).update(fields);
}
```

- [ ] **Step 3: Export the new functions**

Find the `module.exports = { ... }` line. Add the new names. Example merged export:

```js
module.exports = {
  init,
  isDuplicate,
  saveIssue,
  getIssuesSince,
  getAllConfigOverrides,
  setConfigOverride,
  deleteConfigOverride,
  updateIssueTriageMessageId,
  updateIssueTriageChannelId,
  updateIssueThreadId,
  getIssueByThreadId,
  // ...whatever else already existed...
  updateIssueFields,
  setIssueLastEvaluatedAt,
  updateIssueResolution,
  searchOpenIssuesForAgent,
  getGapByKey,
  createGap,
  updateGap,
};
```

Preserve every existing export name — only add new ones.

- [ ] **Step 4: Sanity-check by requiring the module**

Run: `node -e "const f = require('./src/services/firestore'); console.log(typeof f.updateIssueFields, typeof f.getGapByKey, typeof f.searchOpenIssuesForAgent)"`
Expected: `function function function`

- [ ] **Step 5: Commit**

```bash
git add src/services/firestore.js
git commit -m "$(cat <<'EOF'
feat(firestore): helpers for agent triage and capability gaps

Adds updateIssueFields, setIssueLastEvaluatedAt, updateIssueResolution,
searchOpenIssuesForAgent, and gap CRUD (getGapByKey, createGap,
updateGap). No schema migrations needed — Firestore is schemaless.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Agent tools

### Task 4: searchIssues tool

**Files:**
- Create: `src/services/agentTools/searchIssues.js`
- Create: `test/agentTools/searchIssues.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/agentTools/searchIssues.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchIssues } = require('../../src/services/agentTools/searchIssues');

function ctx(issues) {
  return {
    firestore: {
      searchOpenIssuesForAgent: async () => issues,
    },
  };
}

test('returns empty array when no issues', async () => {
  const out = await searchIssues({ query: 'gmail' }, ctx([]));
  assert.deepEqual(out, []);
});

test('ranks by Jaccard similarity against summary + text', async () => {
  const issues = [
    { id: 'a', summary: 'Gmail integration broken for labels', text: 'labels not applying', status: 'open', priority: 'high', category: 'bug' },
    { id: 'b', summary: 'Calendar sync slow', text: 'meetings delayed', status: 'open', priority: 'medium', category: 'performance' },
    { id: 'c', summary: 'Gmail sync failing', text: 'cannot read new emails', status: 'open', priority: 'high', category: 'bug' },
  ];
  const out = await searchIssues({ query: 'gmail labels broken' }, ctx(issues));
  assert.ok(out.length >= 1, 'should return at least one match');
  assert.equal(out[0].id, 'a', 'best match should be the Gmail labels issue');
  assert.ok(typeof out[0].similarity === 'number');
});

test('respects limit argument (default 5)', async () => {
  const issues = Array.from({ length: 20 }, (_, i) => ({
    id: `i${i}`, summary: `Issue ${i} about gmail`, text: 'stuff', status: 'open',
  }));
  const out = await searchIssues({ query: 'gmail', limit: 3 }, ctx(issues));
  assert.equal(out.length, 3);
});

test('supplied channelId in args is ignored (ctx-only)', async () => {
  // This is defense-in-depth; searchIssues doesn't use channelId anyway.
  // Test documents the pattern for other tools.
  const out = await searchIssues({ query: 'x', channelId: 'evil' }, ctx([]));
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/agentTools/searchIssues.test.js`
Expected: FAIL — `Cannot find module '../../src/services/agentTools/searchIssues'`.

- [ ] **Step 3: Implement the tool**

Create `src/services/agentTools/searchIssues.js`:

```js
const { jaccardSimilarity } = require('../duplicates');

async function searchIssues(args, ctx) {
  const query = String(args?.query || '').trim();
  const limit = Math.max(1, Math.min(10, Number(args?.limit) || 5));
  if (!query) return [];

  let candidates = [];
  try {
    candidates = await ctx.firestore.searchOpenIssuesForAgent(query, 50);
  } catch {
    return [];
  }

  const scored = candidates.map(issue => {
    const sumSim = jaccardSimilarity(query, issue.summary || '');
    const textSim = jaccardSimilarity(query, issue.text || '');
    const similarity = Math.max(sumSim, textSim * 0.8);
    return {
      id: issue.id,
      summary: (issue.summary || '').slice(0, 300),
      status: issue.status || 'open',
      priority: issue.priority || 'unknown',
      category: issue.category || 'other',
      createdAt: issue.createdAt || null,
      similarity: Math.round(similarity * 100) / 100,
    };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

const schema = {
  type: 'function',
  function: {
    name: 'search_issues',
    description: 'Search open issues for ones similar to a query. Use this to find potential duplicates or related reports before classifying a new issue.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text (keywords or a short phrase).' },
        limit: { type: 'integer', description: 'Max results (1-10).', default: 5 },
      },
      required: ['query'],
    },
  },
};

module.exports = { searchIssues, schema };
```

- [ ] **Step 4: Run the tests to verify pass**

Run: `npm test -- test/agentTools/searchIssues.test.js`
Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/agentTools/searchIssues.js test/agentTools/searchIssues.test.js
git commit -m "$(cat <<'EOF'
feat(agent-tools): search_issues tool with Jaccard ranking

Reuses duplicates.jaccardSimilarity for ranking. Returns shaped
results capped at 10. Empty query → empty result.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: getStatus tool

**Files:**
- Create: `src/services/agentTools/getStatus.js`

No unit test — this tool is a 10-line wrapper around existing `statusFetcher`. Tested indirectly via the dispatcher + agent loop tests.

- [ ] **Step 1: Inspect existing status fetcher shape**

Run: `grep -n 'module.exports\|async function\|function ' src/services/statusFetcher.js`
Expected: See the exported functions. Identify the one that returns a parsed summary (likely `fetchSummary` or similar). Read its return shape via `head -60 src/services/statusFetcher.js`.

- [ ] **Step 2: Create the tool wrapper**

Create `src/services/agentTools/getStatus.js`. Adjust the import name (`fetchSummary`) to match whatever the actual status fetcher exports:

```js
const statusFetcher = require('../statusFetcher');
const { getConfig } = require('../../config/config');

async function getStatus(_args, _ctx) {
  if (!getConfig('status_enabled')) {
    return { unavailable: true, reason: 'status_disabled_in_config' };
  }

  try {
    // Use whichever export returns a parsed summary. Adjust if the real
    // export is named differently (e.g. fetchStatusSummary, fetch, etc.).
    const summary = typeof statusFetcher.fetchSummary === 'function'
      ? await statusFetcher.fetchSummary()
      : await statusFetcher.fetch();

    return {
      overall: summary?.status?.indicator || summary?.overall || 'unknown',
      incidents: (summary?.incidents || []).map(i => ({
        name: i.name,
        status: i.status,
        startedAt: i.started_at || i.startedAt || null,
      })),
    };
  } catch (err) {
    return { unavailable: true, reason: `fetch_failed: ${err.message}` };
  }
}

const schema = {
  type: 'function',
  function: {
    name: 'get_poke_status',
    description: 'Get the current live status of poke.com. Use this when a bug report mentions a service being down or integrations broken — there may be an active incident.',
    parameters: { type: 'object', properties: {} },
  },
};

module.exports = { getStatus, schema };
```

- [ ] **Step 3: Quick sanity check**

Run: `node -e "const t = require('./src/services/agentTools/getStatus'); console.log(typeof t.getStatus, typeof t.schema)"`
Expected: `function object`

- [ ] **Step 4: Commit**

```bash
git add src/services/agentTools/getStatus.js
git commit -m "$(cat <<'EOF'
feat(agent-tools): get_poke_status tool wrapping statusFetcher

Returns shaped summary or { unavailable: true } when the status
subsystem is disabled or unreachable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: readChannel tool

**Files:**
- Create: `src/services/agentTools/readChannel.js`
- Create: `test/agentTools/readChannel.test.js`

Critical rule: `channelId` comes from `ctx`, NEVER from LLM-supplied args. Test enforces this.

- [ ] **Step 1: Write the failing test**

Create `test/agentTools/readChannel.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readChannel } = require('../../src/services/agentTools/readChannel');
const { fakeChannel, fakeGuild, fakeMessage } = require('../helpers/mocks');

test('returns empty when channelId missing from ctx', async () => {
  const out = await readChannel({}, { guild: fakeGuild(), channelId: null });
  assert.deepEqual(out, []);
});

test('reads last N messages from ctx channel', async () => {
  const messages = [
    fakeMessage({ id: 'm1', content: 'hello', authorUsername: 'alice' }),
    fakeMessage({ id: 'm2', content: 'world', authorUsername: 'bob' }),
  ];
  const channel = fakeChannel({ id: 'c1', messages });
  const guild = fakeGuild({ channels: [channel] });

  const out = await readChannel({ limit: 20 }, { guild, channelId: 'c1' });
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'hello');
  assert.equal(out[0].author, 'alice');
});

test('ignores channelId passed in args (uses ctx.channelId only)', async () => {
  const messages = [fakeMessage({ id: 'm1', content: 'from allowed chan' })];
  const channel = fakeChannel({ id: 'allowed', messages });
  const guild = fakeGuild({ channels: [channel] });

  // Agent tries to redirect tool at a different channel via args
  const out = await readChannel(
    { limit: 5, channelId: 'attacker' },
    { guild, channelId: 'allowed' }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'from allowed chan');
});

test('truncates message content to 500 chars', async () => {
  const long = 'a'.repeat(1000);
  const messages = [fakeMessage({ id: 'm1', content: long })];
  const channel = fakeChannel({ id: 'c1', messages });
  const guild = fakeGuild({ channels: [channel] });

  const out = await readChannel({}, { guild, channelId: 'c1' });
  assert.equal(out[0].content.length, 500);
});

test('caps limit at 50 even if agent asks for more', async () => {
  const many = Array.from({ length: 100 }, (_, i) => fakeMessage({ id: `m${i}`, content: `msg${i}` }));
  const channel = fakeChannel({ id: 'c1', messages: many });
  const guild = fakeGuild({ channels: [channel] });

  const out = await readChannel({ limit: 1000 }, { guild, channelId: 'c1' });
  assert.ok(out.length <= 50);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/agentTools/readChannel.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the tool**

Create `src/services/agentTools/readChannel.js`:

```js
async function readChannel(args, ctx) {
  const channelId = ctx?.channelId;
  if (!channelId || !ctx?.guild) return [];

  const requested = Number(args?.limit) || 20;
  const limit = Math.max(1, Math.min(50, requested));

  let channel;
  try {
    channel = ctx.guild.channels.cache.get(channelId)
      || (await ctx.guild.channels.fetch(channelId).catch(() => null));
  } catch {
    return [];
  }
  if (!channel || typeof channel.messages?.fetch !== 'function') return [];

  let batch;
  try {
    batch = await channel.messages.fetch({ limit });
  } catch {
    return [];
  }

  const out = [];
  for (const m of batch.values ? batch.values() : batch) {
    const attachmentsList = m.attachments
      ? (typeof m.attachments.values === 'function' ? Array.from(m.attachments.values()) : [])
      : [];
    out.push({
      author: m.author?.username || 'unknown',
      content: String(m.content || '').slice(0, 500),
      createdAt: m.createdAt?.toISOString?.() || null,
      hasImage: attachmentsList.some(a => (a.contentType || '').startsWith('image/')),
    });
  }
  return out;
}

const schema = {
  type: 'function',
  function: {
    name: 'read_channel_context',
    description: 'Read the last N messages from the channel this report came from. Useful for seeing whether other users are complaining about the same thing right now.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max messages (1-50).', default: 20 },
      },
    },
  },
};

module.exports = { readChannel, schema };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/agentTools/readChannel.test.js`
Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/agentTools/readChannel.js test/agentTools/readChannel.test.js
git commit -m "$(cat <<'EOF'
feat(agent-tools): read_channel_context tool

channelId comes from ctx, never from agent args — prevents the
model from redirecting the tool at a different channel. Truncates
message content to 500 chars, caps limit at 50.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Tool registry and dispatcher

**Files:**
- Create: `src/services/agentTools/index.js`
- Create: `test/agentTools/dispatch.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/agentTools/dispatch.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TOOL_SCHEMAS, dispatch } = require('../../src/services/agentTools');

test('TOOL_SCHEMAS is a non-empty array of OpenAI-shaped function tool defs', () => {
  assert.ok(Array.isArray(TOOL_SCHEMAS));
  assert.ok(TOOL_SCHEMAS.length >= 3);
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function?.name, 'string');
    assert.equal(typeof t.function?.description, 'string');
  }
});

test('dispatch returns error object for unknown tool', async () => {
  const result = await dispatch('nope_not_real', {}, {});
  assert.equal(result.error, 'unknown_tool');
});

test('dispatch catches thrown errors and returns error shape', async () => {
  // Inject a fake ctx that makes search_issues throw
  const ctx = {
    firestore: {
      searchOpenIssuesForAgent: async () => { throw new Error('boom'); },
    },
  };
  const result = await dispatch('search_issues', { query: 'gmail' }, ctx);
  // searchIssues itself returns [] on catch — this proves tools are isolated
  assert.ok(Array.isArray(result));
});

test('dispatch routes search_issues to searchIssues', async () => {
  const ctx = {
    firestore: {
      searchOpenIssuesForAgent: async () => [
        { id: 'a', summary: 'gmail broken', text: 'labels', status: 'open' },
      ],
    },
  };
  const result = await dispatch('search_issues', { query: 'gmail' }, ctx);
  assert.ok(Array.isArray(result));
  assert.equal(result[0].id, 'a');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/agentTools/dispatch.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement registry + dispatcher**

Create `src/services/agentTools/index.js`:

```js
const { searchIssues, schema: searchIssuesSchema } = require('./searchIssues');
const { getStatus, schema: getStatusSchema } = require('./getStatus');
const { readChannel, schema: readChannelSchema } = require('./readChannel');

const HANDLERS = {
  search_issues: searchIssues,
  get_poke_status: getStatus,
  read_channel_context: readChannel,
};

const TOOL_SCHEMAS = [
  searchIssuesSchema,
  getStatusSchema,
  readChannelSchema,
];

async function dispatch(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return { error: 'unknown_tool', name };
  try {
    return await handler(args || {}, ctx || {});
  } catch (err) {
    return { error: 'tool_threw', message: err.message };
  }
}

module.exports = { TOOL_SCHEMAS, dispatch, HANDLERS };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/agentTools/dispatch.test.js`
Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/agentTools/index.js test/agentTools/dispatch.test.js
git commit -m "$(cat <<'EOF'
feat(agent-tools): registry and dispatcher

Exports TOOL_SCHEMAS for OpenRouter tool schemas and dispatch(name,
args, ctx) that routes to tool handlers, returning a standardized
error shape for unknown tools or handler throws.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Agent loop

### Task 8: openrouter.callWithTools

**Files:**
- Modify: `src/services/openrouter.js`

Adds a new single-turn function for tool-use and vision. Existing `classifyIssue` stays intact for fallback use.

- [ ] **Step 1: Add callWithTools at the end of `src/services/openrouter.js` (before `module.exports`)**

```js
async function callWithTools({ messages, tools, images = [], model: overrideModel, maxTokens = 2000 }) {
  const model = overrideModel || getConfig('model');

  // Inject images into the first user message if provided.
  const payloadMessages = messages.map(m => ({ ...m }));
  if (images.length > 0) {
    const firstUserIdx = payloadMessages.findIndex(m => m.role === 'user');
    if (firstUserIdx >= 0) {
      const existing = payloadMessages[firstUserIdx];
      const parts = [
        { type: 'text', text: typeof existing.content === 'string' ? existing.content : '' },
        ...images.map(url => ({ type: 'image_url', image_url: { url } })),
      ];
      payloadMessages[firstUserIdx] = { role: 'user', content: parts };
    }
  }

  const body = {
    model,
    messages: payloadMessages,
    max_tokens: maxTokens,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  } else {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://poke.com',
      'X-Title': 'Pokedex Agent Triage',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`openrouter ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('openrouter: no choices');

  return {
    content: typeof msg.content === 'string' ? msg.content : null,
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    usage: data.usage || null,
  };
}
```

- [ ] **Step 2: Export the new function**

In the `module.exports` line of `openrouter.js`, add `callWithTools`. Example:

```js
module.exports = { classifyIssue, evaluateIssueContext, callWithTools };
```

- [ ] **Step 3: Lint-grep to confirm no syntax issues**

Run: `node -e "require('./src/services/openrouter')"`
Expected: Exit 0 with no output.

- [ ] **Step 4: Commit**

```bash
git add src/services/openrouter.js
git commit -m "$(cat <<'EOF'
feat(openrouter): add callWithTools for tool-use + vision

Single-turn helper used by the new agent triage loop. Supports
tool schemas (OpenAI-compatible), inline images attached to the
first user message, and configurable max_tokens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: agentTriage.js — happy path

**Files:**
- Create: `src/services/agentTriage.js`
- Create: `test/agentTriage-fallback.test.js` (fallback test deferred to Task 10)

- [ ] **Step 1: Write the basic happy-path test**

Create `test/agentTriage.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triageIssue } = require('../src/services/agentTriage');
const { fakeFirestore } = require('./helpers/mocks');

function fakeOpenRouter(sequence) {
  let i = 0;
  return {
    callWithTools: async () => {
      if (i >= sequence.length) throw new Error('responder exhausted');
      return sequence[i++];
    },
  };
}

test('returns classification when model emits final JSON immediately', async () => {
  const or = fakeOpenRouter([
    {
      content: JSON.stringify({
        priority: 'high',
        category: 'bug',
        target: 'poke_product',
        summary: 'Gmail broken',
        reasoning: 'User reports labels not applying',
        follow_up: null,
        evidence: { screenshot_text: null, related_issues: null, active_incident: null },
        capability_gap: null,
      }),
      tool_calls: [],
    },
  ]);

  const out = await triageIssue({
    text: 'Gmail labels broken',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });

  assert.equal(out.priority, 'high');
  assert.equal(out.target, 'poke_product');
  assert.equal(out.agentMeta.toolCallsMade, 0);
  assert.ok(out.agentMeta.durationMs >= 0);
});

test('executes one tool call then receives final JSON', async () => {
  const or = fakeOpenRouter([
    {
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'search_issues', arguments: JSON.stringify({ query: 'gmail' }) },
        },
      ],
    },
    {
      content: JSON.stringify({
        priority: 'medium',
        category: 'bug',
        target: 'poke_product',
        summary: 'Gmail issue',
        reasoning: 'Found 1 similar',
        follow_up: null,
        evidence: { screenshot_text: null, related_issues: ['issue_1'], active_incident: null },
        capability_gap: null,
      }),
      tool_calls: [],
    },
  ]);

  const firestore = fakeFirestore({
    issues: [{ id: 'issue_1', summary: 'Gmail labels broken', text: 'labels not applying', status: 'open' }],
  });

  const out = await triageIssue({
    text: 'my gmail broke',
    images: [],
    ctx: { firestore, channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });

  assert.equal(out.agentMeta.toolCallsMade, 1);
  assert.deepEqual(out.evidence.related_issues, ['issue_1']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/agentTriage.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the loop**

Create `src/services/agentTriage.js`:

```js
const { getConfig } = require('../config/config');
const agentTools = require('./agentTools');

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low', 'unclassified'];
const VALID_TARGETS = ['poke_product', 'pokedex_bot'];

function buildSystemPrompt() {
  const priorities = getConfig('priorities') || ['critical', 'high', 'medium', 'low'];
  const categories = getConfig('categories') || ['bug', 'feature_request', 'ux_issue', 'performance', 'security', 'suggestion', 'other'];

  return `You are Pokedex, a smart issue triage bot for poke.com's Discord community.

## Platform Context
poke.com is an AI assistant living inside iMessage/WhatsApp/SMS. Integrations include Gmail, Outlook, Google Calendar, Notion, Linear, GitHub, Asana, Todoist, Ramp, Netlify, Vercel, Supabase. "Recipes" are workflow templates.

## Your job
Classify a reported issue. You have tools available: consider whether they would meaningfully improve the classification before calling them. Don't call tools just to call them. If the text (and image, if any) is clearly sufficient, go straight to the final JSON.

## Target routing
- target: "pokedex_bot" — the complaint is about THIS Discord bot (Pokedex). Phrases: "you're doing it wrong", "the bot misclassified", "pokedex ignored my message".
- target: "poke_product" — the complaint is about poke.com the product (integrations, AI behavior, messaging, etc.). This is the default.

## Capability gaps
If you identify that you could have triaged better *if* you had a capability you don't have (e.g., log query, video frame analysis, specific Recipe internals), report ONE gap in capability_gap: { title, detail }. Be disciplined — only genuinely load-bearing gaps. Wishful-thinking gaps are worse than no gaps.

## Vision
If an image is attached, extract visible error text, which screen/app is shown, and any relevant app state. Put findings in evidence.screenshot_text.

## Output
Return ONLY valid JSON matching:
{
  "priority": one of [${priorities.map(p => `"${p}"`).join(', ')}],
  "category": one of [${categories.map(c => `"${c}"`).join(', ')}],
  "target": "poke_product" | "pokedex_bot",
  "summary": "one-line summary",
  "reasoning": "why this classification",
  "follow_up": "a question to ask the reporter, or null",
  "evidence": {
    "screenshot_text": "extracted text, or null",
    "related_issues": ["issueId", ...] | null,
    "active_incident": "name of active incident from get_poke_status, or null"
  },
  "capability_gap": { "title": "short", "detail": "1 sentence" } | null
}`;
}

function parseClassification(content) {
  let clean = (content || '').trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  let parsed;
  try { parsed = JSON.parse(clean); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!VALID_PRIORITIES.includes(parsed.priority)) parsed.priority = 'unclassified';
  if (!VALID_TARGETS.includes(parsed.target)) parsed.target = 'poke_product';
  if (typeof parsed.summary !== 'string') return null;
  parsed.reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  parsed.follow_up = typeof parsed.follow_up === 'string' ? parsed.follow_up : null;
  parsed.evidence = parsed.evidence && typeof parsed.evidence === 'object' ? parsed.evidence : {};
  parsed.evidence.screenshot_text = parsed.evidence.screenshot_text || null;
  parsed.evidence.related_issues = Array.isArray(parsed.evidence.related_issues) ? parsed.evidence.related_issues : null;
  parsed.evidence.active_incident = parsed.evidence.active_incident || null;
  parsed.capability_gap = parsed.capability_gap && typeof parsed.capability_gap === 'object'
    ? { title: String(parsed.capability_gap.title || '').slice(0, 100), detail: String(parsed.capability_gap.detail || '').slice(0, 500) }
    : null;
  return parsed;
}

function fallbackClassification(text, reason) {
  return {
    priority: 'unclassified',
    category: 'other',
    target: 'poke_product',
    summary: String(text || '').slice(0, 100),
    reasoning: `Agent fallback: ${reason}`,
    follow_up: null,
    evidence: { screenshot_text: null, related_issues: null, active_incident: null },
    capability_gap: null,
    agentMeta: { fallbackReason: reason, toolCallsMade: 0, durationMs: 0 },
  };
}

async function triageIssue({ text, images = [], ctx, openrouter, parentMessage = null }) {
  const or = openrouter || require('./openrouter');
  const maxToolCalls = Number(getConfig('agent_max_tool_calls')) || 5;
  const startedAt = Date.now();

  const userContent = parentMessage
    ? `PARENT MESSAGE (the mention was a reply to this — classify its content, not the reply wrapper):\n[${parentMessage.author}]: ${parentMessage.content}\n\nREPLY FROM ${parentMessage.replierUsername || 'replier'}:\n${text}`
    : text;

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userContent },
  ];

  let toolCallsMade = 0;
  let imagesAttachedThisCall = images;

  for (let i = 0; i < maxToolCalls + 1; i++) {
    let response;
    try {
      response = await or.callWithTools({
        messages,
        tools: agentTools.TOOL_SCHEMAS,
        images: imagesAttachedThisCall,
      });
      imagesAttachedThisCall = [];
    } catch (err) {
      // Try once without images if we had images, in case vision is the problem
      if (imagesAttachedThisCall.length > 0) {
        imagesAttachedThisCall = [];
        continue;
      }
      return { ...fallbackClassification(text, `openrouter_error: ${err.message}`), agentMeta: { fallbackReason: `openrouter_error: ${err.message}`, toolCallsMade, durationMs: Date.now() - startedAt } };
    }

    if (response.tool_calls && response.tool_calls.length > 0) {
      if (toolCallsMade >= maxToolCalls) {
        return { ...fallbackClassification(text, 'budget_exhausted'), agentMeta: { fallbackReason: 'budget_exhausted', toolCallsMade, durationMs: Date.now() - startedAt } };
      }
      // Push the assistant turn ONCE with all tool_calls intact (OpenAI spec).
      messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls });
      for (const call of response.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
        const result = await agentTools.dispatch(call.function?.name, args, ctx);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
        toolCallsMade++;
      }
      continue;
    }

    const classification = parseClassification(response.content);
    if (!classification) {
      return { ...fallbackClassification(text, 'invalid_json'), agentMeta: { fallbackReason: 'invalid_json', toolCallsMade, durationMs: Date.now() - startedAt } };
    }
    return {
      ...classification,
      agentMeta: { toolCallsMade, durationMs: Date.now() - startedAt, modelUsed: getConfig('model') },
    };
  }

  return { ...fallbackClassification(text, 'budget_exhausted'), agentMeta: { fallbackReason: 'budget_exhausted', toolCallsMade, durationMs: Date.now() - startedAt } };
}

module.exports = { triageIssue, parseClassification, fallbackClassification };
```

**Erratum (2026-04-25, applied in commit `f0957d3`):** an earlier version of this code block pushed one `{ role: 'assistant', tool_calls: [call] }` per tool call inside the for-loop. That violates the OpenAI/OpenRouter chat-completions schema, which requires exactly one assistant message containing the full `tool_calls` array, followed by N `role: 'tool'` messages keyed by `tool_call_id`. The above version is correct.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/agentTriage.test.js`
Expected: Both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/agentTriage.js test/agentTriage.test.js
git commit -m "$(cat <<'EOF'
feat(agent-triage): triageIssue loop happy path

Calls OpenRouter via callWithTools, dispatches tool calls through
the agent tool registry, parses final JSON classification. Accepts
injected openrouter module for testability. Produces agentMeta
with toolCallsMade and durationMs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: agentTriage fallback ladder

**Files:**
- Create: `test/agentTriage-fallback.test.js`
- Modify: `src/services/agentTriage.js` (may need tweaks to pass tests)

- [ ] **Step 1: Write fallback tests**

Create `test/agentTriage-fallback.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triageIssue } = require('../src/services/agentTriage');
const { fakeFirestore } = require('./helpers/mocks');

function seq(items) {
  let i = 0;
  return {
    callWithTools: async () => {
      if (i >= items.length) throw new Error('exhausted');
      const v = items[i++];
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

test('fallback on invalid JSON from model', async () => {
  const or = seq([{ content: 'not json', tool_calls: [] }]);
  const out = await triageIssue({
    text: 'gmail broken',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });
  assert.equal(out.priority, 'unclassified');
  assert.equal(out.agentMeta.fallbackReason, 'invalid_json');
});

test('fallback when budget exhausted', async () => {
  // 6 consecutive responses that all ask for another tool call
  const infiniteTool = {
    content: null,
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'search_issues', arguments: '{"query":"x"}' } }],
  };
  const or = seq([infiniteTool, infiniteTool, infiniteTool, infiniteTool, infiniteTool, infiniteTool]);
  const out = await triageIssue({
    text: 'x',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });
  assert.equal(out.agentMeta.fallbackReason, 'budget_exhausted');
});

test('fallback when OpenRouter throws on every call (no images)', async () => {
  const or = seq([new Error('network down')]);
  const out = await triageIssue({
    text: 'x',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });
  assert.ok(out.agentMeta.fallbackReason.startsWith('openrouter_error'));
});

test('retries without images when first call with images fails', async () => {
  // First call (with images) throws; second call (without images) returns valid JSON
  const or = seq([
    new Error('vision rejected'),
    {
      content: JSON.stringify({
        priority: 'low', category: 'other', target: 'poke_product',
        summary: 'text-only classification', reasoning: 'r',
        follow_up: null,
        evidence: { screenshot_text: 'image unreadable', related_issues: null, active_incident: null },
        capability_gap: null,
      }),
      tool_calls: [],
    },
  ]);
  const out = await triageIssue({
    text: 'x',
    images: ['https://example.com/img.png'],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });
  assert.equal(out.priority, 'low');
  assert.equal(out.agentMeta.fallbackReason, undefined, 'second call succeeded, no fallback flag');
});
```

- [ ] **Step 2: Run tests — some may pass, some may fail**

Run: `npm test -- test/agentTriage-fallback.test.js`
Expected: Likely 3 pass, 1 may need `parseClassification` tweaking. If all pass, skip step 3.

- [ ] **Step 3: Adjust `agentTriage.js` if any tests fail**

Re-read the failing test output. Common fixes:
- If "invalid_json" test returns something other than `unclassified`, ensure `parseClassification` returns `null` for unparseable input and `fallbackClassification` is returned.
- If "budget_exhausted" fires too early, check the loop iteration count. The current implementation allows up to `maxToolCalls` tool-calling rounds, then one more round for the final response.
- Re-run tests until all four pass.

- [ ] **Step 4: Commit**

```bash
git add test/agentTriage-fallback.test.js src/services/agentTriage.js
git commit -m "$(cat <<'EOF'
test(agent-triage): fallback ladder — invalid JSON, budget, network, vision retry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Capability-gap backlog

### Task 11: capabilityGap — normalization + record logic

**Files:**
- Create: `src/services/capabilityGap.js`
- Create: `test/capabilityGap.test.js`

- [ ] **Step 1: Write tests**

Create `test/capabilityGap.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKey, shouldRepingAtCount, record } = require('../src/services/capabilityGap');
const { fakeFirestore, fakeChannel, fakeGuild } = require('./helpers/mocks');

test('normalizeKey maps variant titles to the same key', () => {
  const a = normalizeKey('Log query tool');
  const b = normalizeKey('log-query tool');
  const c = normalizeKey('TOOLS for querying logs');
  assert.equal(a, b);
  // c is a slightly different wording — may not match, but the two variants above MUST.
});

test('normalizeKey strips common stopwords', () => {
  const key = normalizeKey('the tool for querying the logs');
  assert.ok(!key.includes('the'));
});

test('shouldRepingAtCount: true at 1, 3, 10, 50; false otherwise', () => {
  assert.equal(shouldRepingAtCount(1), true);
  assert.equal(shouldRepingAtCount(2), false);
  assert.equal(shouldRepingAtCount(3), true);
  assert.equal(shouldRepingAtCount(4), false);
  assert.equal(shouldRepingAtCount(10), true);
  assert.equal(shouldRepingAtCount(11), false);
  assert.equal(shouldRepingAtCount(50), true);
  assert.equal(shouldRepingAtCount(51), false);
});

test('record creates new gap + channel post on first occurrence', async () => {
  const firestore = fakeFirestore();
  const postedMessages = [];
  const channel = {
    ...fakeChannel({ id: 'pc', name: 'pokedex-testing' }),
    send: async (payload) => {
      const msg = { id: `post_${postedMessages.length + 1}`, edit: async (p) => { msg.payload = p; } };
      postedMessages.push({ id: msg.id, payload });
      return msg;
    },
  };
  const guild = fakeGuild({ channels: [channel] });

  const gap = { title: 'log query tool', detail: 'would have confirmed by checking server logs' };
  await record({ gap, issueId: 'i1', guild, firestore, ownerId: '123456789012345678', channelName: 'pokedex-testing' });

  const stored = await firestore.getGapByKey(normalizeKey('log query tool'));
  assert.ok(stored);
  assert.equal(stored.occurrenceCount, 1);
  assert.deepEqual(stored.exampleIssueIds, ['i1']);
  assert.equal(postedMessages.length, 1);
  assert.ok(postedMessages[0].payload.content.includes('<@123456789012345678>'));
});

test('record edits existing post on second occurrence without re-pinging', async () => {
  const existing = {
    id: 'gap_existing',
    title: 'log query tool',
    normalizedKey: normalizeKey('log query tool'),
    occurrenceCount: 1,
    exampleIssueIds: ['i1'],
    postMessageId: 'post_1',
    status: 'open',
  };
  const firestore = fakeFirestore({ gaps: [existing] });

  let edited = null;
  const channel = {
    ...fakeChannel({ id: 'pc', name: 'pokedex-testing' }),
    send: async () => { throw new Error('should not post again'); },
    messages: {
      fetch: async (id) => {
        if (id === 'post_1') return { id, edit: async (p) => { edited = p; } };
        return null;
      },
    },
  };
  const guild = fakeGuild({ channels: [channel] });

  const gap = { title: 'Log Query Tool', detail: 'same gap' };
  await record({ gap, issueId: 'i2', guild, firestore, ownerId: '123456789012345678', channelName: 'pokedex-testing' });

  const stored = await firestore.getGapByKey(normalizeKey('log query tool'));
  assert.equal(stored.occurrenceCount, 2);
  assert.deepEqual(stored.exampleIssueIds, ['i1', 'i2']);
  assert.ok(edited, 'existing post was edited');
  assert.ok(!edited.content.includes('<@123456789012345678>'), 'no re-ping at count 2');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/capabilityGap.test.js`
Expected: Module not found.

- [ ] **Step 3: Implement `src/services/capabilityGap.js`**

```js
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'of', 'to', 'for', 'in', 'on', 'at',
  'with', 'by', 'from', 'i', 'me', 'my', 'you', 'your', 'it', 'is', 'be',
  'that', 'this', 'these', 'those', 'would', 'could', 'should',
  'tool', 'tools', 'capability', 'ability',
]);

function normalizeKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w))
    .map(w => w.replace(/(ing|ed|s)$/, ''))
    .sort()
    .join(' ');
}

function shouldRepingAtCount(n) {
  return n === 1 || n === 3 || n === 10 || n === 50;
}

function findChannelByName(guild, name) {
  return guild?.channels?.cache?.find?.(c => c.name === name && c.isTextBased?.()) || null;
}

function buildEmbedContent({ gap, occurrenceCount, firstSeenAt, lastSeenAt, status, exampleIssueIds, ownerPing }) {
  const when = (iso) => {
    if (!iso) return 'just now';
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return d.toISOString();
  };
  const lines = [
    `🔧 **Capability gap: ${gap.title}**`,
    `Seen **${occurrenceCount}** time${occurrenceCount === 1 ? '' : 's'} (first: ${when(firstSeenAt)}, last: ${when(lastSeenAt)})`,
    `Status: ${status}`,
    '',
    `**Detail:**`,
    gap.detail,
    '',
    `**Example issues:** ${(exampleIssueIds || []).slice(-5).map(id => '`' + id + '`').join(', ') || '—'}`,
  ];
  if (ownerPing) lines.push(`<@${ownerPing}>`);
  return lines.join('\n');
}

async function record({ gap, issueId, guild, firestore, ownerId, channelName }) {
  if (!gap?.title || !gap?.detail) return;
  const channel = findChannelByName(guild, channelName);
  const normalizedKey = normalizeKey(gap.title);
  const nowIso = new Date().toISOString();

  const existing = await firestore.getGapByKey(normalizedKey);

  if (existing) {
    if (existing.status === 'shipped' || existing.status === 'wont_do') {
      await firestore.updateGap(normalizedKey, {
        occurrenceCount: (existing.occurrenceCount || 0) + 1,
        lastSeenAt: nowIso,
      });
      return;
    }
    const newCount = (existing.occurrenceCount || 0) + 1;
    const newExamples = [...(existing.exampleIssueIds || []), issueId].slice(-5);
    await firestore.updateGap(normalizedKey, {
      occurrenceCount: newCount,
      lastSeenAt: nowIso,
      exampleIssueIds: newExamples,
      title: gap.title,
    });
    if (channel && existing.postMessageId) {
      try {
        const msg = await channel.messages.fetch(existing.postMessageId);
        const ownerPing = shouldRepingAtCount(newCount) ? ownerId : null;
        const content = buildEmbedContent({
          gap,
          occurrenceCount: newCount,
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: nowIso,
          status: existing.status || 'open',
          exampleIssueIds: newExamples,
          ownerPing,
        });
        await msg.edit({ content });
      } catch (err) {
        console.error('capabilityGap: edit failed', err.message);
      }
    }
    return;
  }

  let postMessageId = null;
  if (channel) {
    try {
      const content = buildEmbedContent({
        gap,
        occurrenceCount: 1,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        status: 'open',
        exampleIssueIds: [issueId],
        ownerPing: ownerId || null,
      });
      const posted = await channel.send({ content, allowedMentions: { users: ownerId ? [ownerId] : [] } });
      postMessageId = posted?.id || null;
    } catch (err) {
      console.error('capabilityGap: post failed', err.message);
    }
  }

  await firestore.createGap({
    title: gap.title,
    normalizedKey,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    occurrenceCount: 1,
    exampleIssueIds: [issueId],
    postMessageId,
    status: 'open',
  });
}

module.exports = { normalizeKey, shouldRepingAtCount, record };
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/capabilityGap.test.js`
Expected: All 5 tests pass. If "normalizeKey maps variant titles" fails, tweak the stopword or stemming list until the two documented variants collapse to the same key.

- [ ] **Step 5: Commit**

```bash
git add src/services/capabilityGap.js test/capabilityGap.test.js
git commit -m "$(cat <<'EOF'
feat(capability-gap): record/dedup/post for pokedex-testing backlog

normalizeKey slugs titles for dedup. shouldRepingAtCount triggers
owner pings at 1/3/10/50 occurrences. record creates or edits the
channel post and handles shipped/wont_do status skip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Triage channel routing

### Task 12: target-aware channel selection + self embed

**Files:**
- Modify: `src/services/triage.js`
- Create: `test/triage-routing.test.js`

- [ ] **Step 1: Read current triage.js to find `findTriageChannel` and `buildIssueEmbed`**

Run: `grep -n 'function \|module.exports' src/services/triage.js`
Expected: See the exports and function boundaries. Read the file fully.

- [ ] **Step 2: Write routing tests**

Create `test/triage-routing.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findTriageChannel } = require('../src/services/triage');
const { fakeChannel, fakeGuild } = require('./helpers/mocks');

// Minimal config stub — these tests run without Firestore so we rely on file defaults.
// Assumes config.json has triage_channel: 'eng-triage' and pokedex_self_channel: 'pokedex-testing'.

test('poke_product target → eng-triage channel', () => {
  const eng = fakeChannel({ id: 'e1', name: 'eng-triage' });
  const pok = fakeChannel({ id: 'p1', name: 'pokedex-testing' });
  const guild = fakeGuild({ channels: [eng, pok] });
  const out = findTriageChannel(guild, 'poke_product');
  assert.equal(out?.name, 'eng-triage');
});

test('pokedex_bot target → pokedex-testing channel', () => {
  const eng = fakeChannel({ id: 'e1', name: 'eng-triage' });
  const pok = fakeChannel({ id: 'p1', name: 'pokedex-testing' });
  const guild = fakeGuild({ channels: [eng, pok] });
  const out = findTriageChannel(guild, 'pokedex_bot');
  assert.equal(out?.name, 'pokedex-testing');
});

test('falls back to eng-triage when pokedex-testing missing', () => {
  const eng = fakeChannel({ id: 'e1', name: 'eng-triage' });
  const guild = fakeGuild({ channels: [eng] });
  const out = findTriageChannel(guild, 'pokedex_bot');
  assert.equal(out?.name, 'eng-triage');
});

test('no target defaults to poke_product behavior', () => {
  const eng = fakeChannel({ id: 'e1', name: 'eng-triage' });
  const guild = fakeGuild({ channels: [eng] });
  const out = findTriageChannel(guild);
  assert.equal(out?.name, 'eng-triage');
});
```

- [ ] **Step 3: Initialize config in the test file (before running)**

Because `getConfig` reads defaults from `config.json` lazily via `init()`, we need to load defaults for these tests. Add this to the top of `test/triage-routing.test.js` BEFORE the `test(...)` blocks:

```js
const { before } = require('node:test');
const config = require('../src/config/config');

before(() => {
  // Load config.json defaults without Firestore.
  // loadFileDefaults is not exported — use init() in a limited-mode call.
  // If init() requires firestoreService, temporarily stub it.
  const fs = require('fs');
  const path = require('path');
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
  // Monkey-patch: directly call the private by re-requiring. Simplest approach:
  config.setFirestoreService({ getAllConfigOverrides: async () => ({}) });
  return config.init();
});
```

If the `before` hook syntax doesn't work in node:test's "root test" scope, restructure using `describe`/`before` pair. Simplest alternative: put all tests inside a `describe('triage-routing', () => { before(...); test(...) })` block.

- [ ] **Step 4: Run tests to verify failure**

Run: `npm test -- test/triage-routing.test.js`
Expected: Tests fail because current `findTriageChannel` doesn't accept a `target` argument.

- [ ] **Step 5: Update `findTriageChannel` in `src/services/triage.js`**

Locate the existing `findTriageChannel(guild)` function. Replace with:

```js
function findTriageChannel(guild, target = 'poke_product') {
  const engName = getConfig('triage_channel') || 'eng-triage';
  const selfName = getConfig('pokedex_self_channel') || 'pokedex-testing';

  if (target === 'pokedex_bot') {
    const selfChan = guild?.channels?.cache?.find?.(c => c.name === selfName && c.isTextBased?.());
    if (selfChan) return selfChan;
    // Fallback to eng-triage with a [Pokedex self] prefix prepended by the embed builder.
  }
  return guild?.channels?.cache?.find?.(c => c.name === engName && c.isTextBased?.()) || null;
}
```

If `getConfig` isn't already imported at the top of `triage.js`, add it: `const { getConfig } = require('../config/config');`

- [ ] **Step 6: Run tests**

Run: `npm test -- test/triage-routing.test.js`
Expected: All 4 tests pass.

- [ ] **Step 7: Update `buildIssueEmbed` for pokedex-self variant**

In `src/services/triage.js`, find `buildIssueEmbed` (or the equivalent embed builder). Add a second parameter or detection so that when `issue.target === 'pokedex_bot'`:
- Title is prefixed with `[Pokedex self]`.
- Color is overridden to a purple family: `0x8b5cf6` (or similar). Keep existing priority-based colors for `poke_product`.

Example minimal patch (adjust variable names to match the existing file):

```js
function buildIssueEmbed(issue, issueId) {
  const isSelf = issue?.target === 'pokedex_bot';
  const priority = issue.priority || 'unclassified';
  const color = isSelf ? 0x8b5cf6 : (PRIORITY_COLORS[priority] ?? 0x808080);
  const titlePrefix = isSelf ? '[Pokedex self] ' : '';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${titlePrefix}${priority.toUpperCase()} — ${(issue.category || 'other').replace(/_/g, ' ')}`)
    // ... existing .setDescription, .addFields calls here ...
    ;
  // existing body of buildIssueEmbed continues
  return embed;
}
```

Merge these changes into the existing builder carefully — do NOT remove any existing fields.

- [ ] **Step 8: Update `postIssueEmbed` to respect target**

`postIssueEmbed(guild, issue, issueId)` currently calls `findTriageChannel(guild)`. Change that single call site to:

```js
const channel = findTriageChannel(guild, issue.target || 'poke_product');
```

If the self channel was missing and we fell back to eng-triage, prepend `[Pokedex self → fallback]` in the embed title. A quick check:

```js
const isSelfFallback = (issue.target === 'pokedex_bot') && channel?.name === (getConfig('triage_channel') || 'eng-triage');
```

Use `isSelfFallback` to adjust the title prefix.

Add owner mention in the post body for self-bugs with priority `critical` or `high`:

```js
const ownerId = getConfig('pokedex_owner_id');
const mentionLine = (issue.target === 'pokedex_bot' && ['critical', 'high'].includes(issue.priority) && ownerId)
  ? `<@${ownerId}>`
  : '';
// pass { content: mentionLine, embeds: [embed], allowedMentions: { users: ownerId ? [ownerId] : [] } } to channel.send
```

- [ ] **Step 9: Run full test suite to catch regressions**

Run: `npm test`
Expected: All tests pass. If any existing behavior changed, revisit the patches.

- [ ] **Step 10: Commit**

```bash
git add src/services/triage.js test/triage-routing.test.js
git commit -m "$(cat <<'EOF'
feat(triage): target-aware channel routing + pokedex-self embed variant

findTriageChannel(guild, target) picks eng-triage vs pokedex-testing.
buildIssueEmbed prefixes [Pokedex self] and uses a purple color
for target='pokedex_bot'. High/critical self-bugs @-mention the
pokedex_owner_id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Pipeline integration

### Task 13: pipeline.js uses agentTriage

**Files:**
- Modify: `src/services/pipeline.js`

This is the core swap. Preserves the `agent_enabled: false` fallback path to today's `classifyIssue`.

- [ ] **Step 1: Read current `src/services/pipeline.js`**

Already in context. `processIssue` is at lines 16-131; `handleDuplicate` at 133-174; `processIssueForced` at 179-226.

- [ ] **Step 2: Add agent triage import and helper**

At the top of `pipeline.js` imports, add:

```js
const agentTriage = require('./agentTriage');
const capabilityGap = require('./capabilityGap');
const { classifyIssue } = require('./openrouter');
```

(`classifyIssue` may already be imported — preserve the existing import in that case.)

- [ ] **Step 3: Extract an image-collection helper**

Inside `pipeline.js`, above `processIssue`, add:

```js
function collectImageUrls(message) {
  if (!message?.attachments?.size) return [];
  const out = [];
  for (const [, att] of message.attachments) {
    if ((att.contentType || '').startsWith('image/')) {
      out.push(att.url);
    }
  }
  return out;
}
```

- [ ] **Step 4: Replace the classifier call in `processIssue`**

Find the existing block (roughly lines 20-22):

```js
// Classify with AI
const classification = await classifyIssue(text);
```

Replace with:

```js
// Classify via agent loop (tool-use + vision). Fall back to single-shot if disabled.
const imageUrls = collectImageUrls(message);
let classification;
if (getConfig('agent_enabled') !== false) {
  classification = await agentTriage.triageIssue({
    text,
    images: imageUrls,
    ctx: {
      firestore,
      guild: message.guild,
      channelId: message.channel.id,
      reporterId: message.author.id,
      reporterName: message.author.username,
    },
  });
} else {
  classification = await classifyIssue(text);
  classification.target = 'poke_product';
  classification.evidence = classification.evidence || { screenshot_text: null, related_issues: null, active_incident: null };
}
```

(`getConfig` should already be imported; if not, add `const { getConfig } = require('../config/config');`.)

- [ ] **Step 5: Propagate `target` and new fields into `issueData`**

Find the `issueData` object construction. Add:

```js
target: classification.target || 'poke_product',
evidence: classification.evidence || null,
agentMeta: classification.agentMeta || null,
lastEvaluatedAt: new Date().toISOString(),
```

- [ ] **Step 6: Call capability-gap recorder after save**

After `issueId = await firestore.saveIssue(issueData);` and after `triageMessageId` is stored, add:

```js
if (classification.capability_gap && issueId !== 'unknown') {
  try {
    await capabilityGap.record({
      gap: classification.capability_gap,
      issueId,
      guild: message.guild,
      firestore,
      ownerId: getConfig('pokedex_owner_id'),
      channelName: getConfig('pokedex_self_channel') || 'pokedex-testing',
    });
  } catch (err) {
    console.error('capability gap record failed:', err.message);
  }
}
```

- [ ] **Step 7: Mirror the same changes into `processIssueForced`**

`processIssueForced` is a parallel implementation used when a user overrides the dupe check. Apply identical changes there: use agentTriage, add target/evidence/agentMeta/lastEvaluatedAt to issueData, call capabilityGap.record after save.

- [ ] **Step 8: Smoke-test module loads without syntax errors**

Run: `node -e "require('./src/services/pipeline')"`
Expected: Exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/services/pipeline.js
git commit -m "$(cat <<'EOF'
feat(pipeline): route through agentTriage with vision + tools

processIssue and processIssueForced now call agentTriage.triageIssue
with collected image URLs. agent_enabled: false preserves the
single-shot classifyIssue fallback. target/evidence/agentMeta are
persisted on the issue doc. Capability gaps are recorded after save.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — Conversation intelligence

### Task 14: Evaluator schema expansion

**Files:**
- Modify: `src/services/openrouter.js` (the `evaluateIssueContext` system prompt + return parsing)
- Modify: `src/services/contextEvaluator.js` (image collection)

- [ ] **Step 1: Expand the evaluator system prompt in `openrouter.js`**

Locate `evaluateIssueContext` (around lines 121-213 based on current file). Replace the `systemPrompt` block so the JSON schema section becomes:

```
Return ONLY valid JSON:
{
  "complete": boolean,
  "missing": ["what is still needed"],
  "responseMode": "ignore" | "react" | "reply",
  "reply": "what to say to the user" or null,
  "triageUpdate": "new context summary for the engineering triage embed" or null,
  "reclassify": boolean,
  "resolved": boolean,
  "resolvedReason": "one-line reason or null"
}
```

And add these new rules (keep the existing rules intact):

```
- responseMode: "ignore" for thanks, "ok", emoji-only, or third-party chatter. "react" when the reporter confirms info without asking anything. "reply" when there's substantive new info, a bot clarifying question to ask, or a reply from the bot is warranted.
- Only mark resolved: true when the REPORTER (original author of the issue) indicates resolution unambiguously (e.g., "solved", "fixed", "nvm works now", "figured it out"). Hedged phrases like "we need this fixed" do NOT count.
- If unsure whether the issue is resolved, set resolved: false AND responseMode: "reply" with reply: "sounds like this is working now — should I close this out?"
```

- [ ] **Step 2: Update the return parsing**

In `evaluateIssueContext`, after `const parsed = JSON.parse(content);`, update the return object:

```js
return {
  complete: !!parsed.complete,
  missing: Array.isArray(parsed.missing) ? parsed.missing : [],
  responseMode: ['ignore', 'react', 'reply'].includes(parsed.responseMode) ? parsed.responseMode : 'react',
  // Keep `shouldReply` for backwards compatibility with forum path callers until Task 15 unifies it.
  shouldReply: parsed.responseMode === 'reply',
  reply: typeof parsed.reply === 'string' ? parsed.reply : null,
  triageUpdate: typeof parsed.triageUpdate === 'string' ? parsed.triageUpdate : null,
  reclassify: !!parsed.reclassify,
  resolved: !!parsed.resolved,
  resolvedReason: typeof parsed.resolvedReason === 'string' ? parsed.resolvedReason : null,
};
```

Also update the error-case return (the one returned when the API call fails) to include `responseMode: 'ignore', resolved: false, resolvedReason: null`.

- [ ] **Step 3: Update `contextEvaluator.js` to collect new images**

In `src/services/contextEvaluator.js`, extend `buildConversationHistory` to already include `attachments[].contentType` and `isImage`. Also add a new exported helper:

```js
function collectNewImageUrls(messages, sinceIso) {
  const cutoff = sinceIso ? Date.parse(sinceIso) : 0;
  const urls = [];
  for (const m of messages) {
    const createdAt = m.createdAt?.getTime?.() || Date.parse(m.createdAt) || 0;
    if (createdAt <= cutoff) continue;
    const atts = m.attachments ? (m.attachments.values ? Array.from(m.attachments.values()) : m.attachments) : [];
    for (const a of atts) {
      if ((a.contentType || '').startsWith('image/') && a.url) urls.push(a.url);
    }
  }
  return urls;
}

module.exports = { evaluateContext, processEvaluation, updateContextBadge, buildConversationHistory, collectNewImageUrls };
```

- [ ] **Step 4: Smoke-test**

Run: `node -e "const e = require('./src/services/contextEvaluator'); console.log(typeof e.collectNewImageUrls)"`
Expected: `function`

- [ ] **Step 5: Commit**

```bash
git add src/services/openrouter.js src/services/contextEvaluator.js
git commit -m "$(cat <<'EOF'
feat(evaluator): expand schema — responseMode, resolved, image collection

evaluateIssueContext now returns responseMode (ignore/react/reply),
resolved, and resolvedReason. shouldReply is kept as a derived alias
for backwards compatibility with the forum path until thread.js is
unified. collectNewImageUrls helper lets thread callers feed new
screenshots into the next agent pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Unified thread handler with responseMode + rate limit

**Files:**
- Modify: `src/triggers/thread.js`
- Create: `test/thread-rate-limit.test.js`

- [ ] **Step 1: Write rate-limit test**

Create `test/thread-rate-limit.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canBotReplyInThread, _reset } = require('../src/triggers/thread');

test('first 3 replies allowed within 10 minutes', () => {
  _reset();
  const now = Date.now();
  assert.equal(canBotReplyInThread('t1', now), true);
  assert.equal(canBotReplyInThread('t1', now + 1000), true);
  assert.equal(canBotReplyInThread('t1', now + 2000), true);
});

test('4th reply within 10 minutes blocked', () => {
  _reset();
  const now = Date.now();
  canBotReplyInThread('t1', now);
  canBotReplyInThread('t1', now + 1000);
  canBotReplyInThread('t1', now + 2000);
  assert.equal(canBotReplyInThread('t1', now + 3000), false);
});

test('old replies slide out of window after 10 min', () => {
  _reset();
  const now = Date.now();
  canBotReplyInThread('t1', now);
  canBotReplyInThread('t1', now + 1000);
  canBotReplyInThread('t1', now + 2000);
  // 10 minutes + 1ms later, the first reply has slid out
  assert.equal(canBotReplyInThread('t1', now + 10 * 60 * 1000 + 1), true);
});

test('rate limits are per-thread', () => {
  _reset();
  const now = Date.now();
  canBotReplyInThread('t1', now);
  canBotReplyInThread('t1', now + 1);
  canBotReplyInThread('t1', now + 2);
  assert.equal(canBotReplyInThread('t2', now + 3), true, 'different thread not affected');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/thread-rate-limit.test.js`
Expected: FAIL — `canBotReplyInThread` not exported.

- [ ] **Step 3: Add the rate-limit function to `src/triggers/thread.js`**

At the top of `thread.js` (after requires), add:

```js
const replyHistory = new Map(); // threadId -> [timestamps]

function canBotReplyInThread(threadId, nowMs = Date.now()) {
  const maxReplies = Number(require('../config/config').getConfig('agent_max_replies_per_thread_per_10m')) || 3;
  const windowMs = 10 * 60 * 1000;
  const history = (replyHistory.get(threadId) || []).filter(t => nowMs - t < windowMs);
  if (history.length >= maxReplies) {
    replyHistory.set(threadId, history);
    return false;
  }
  history.push(nowMs);
  replyHistory.set(threadId, history);
  return true;
}

function _reset() { replyHistory.clear(); }
```

And export them:

```js
module.exports = { handleThreadMessage, canBotReplyInThread, _reset };
```

- [ ] **Step 4: Run rate-limit tests**

Run: `npm test -- test/thread-rate-limit.test.js`
Expected: All 4 tests pass.

- [ ] **Step 5: Unify forum and non-forum paths**

Replace the entire body of `handleThreadMessage` in `thread.js` with a unified implementation. Keep the existing debounce + `pendingUpdates` map. The debounced function body becomes:

```js
pendingUpdates.set(issue.id, setTimeout(async () => {
  pendingUpdates.delete(issue.id);
  try {
    const updatedIssue = await firestore.getIssueByThreadId(threadId);
    if (!updatedIssue) return;

    // Gather recent thread messages (cap 500).
    const allMessages = [];
    let lastId;
    const MAX = 500;
    while (allMessages.length < MAX) {
      const batch = await message.channel.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
      if (batch.size === 0) break;
      allMessages.push(...batch.values());
      if (batch.size < 100) break;
      lastId = batch.last().id;
    }
    allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const { buildConversationHistory, collectNewImageUrls } = require('../services/contextEvaluator');
    const history = buildConversationHistory(allMessages);
    const newImages = collectNewImageUrls(allMessages, updatedIssue.lastEvaluatedAt);

    // Feed images into the evaluator via a custom hint (evaluator prompt knows to look for "[new images attached: N]" and request the triage system to inspect them out-of-band OR we run a vision pass).
    const extraHint = newImages.length > 0 ? `The reporter has attached ${newImages.length} new screenshot(s) since the last evaluation. Assume you have seen their content (extracted below):\n<<agent_vision_summary will be populated before this call>>` : null;

    // Before calling the evaluator, run vision on new images through the agent to extract text
    // — simplest path for v1: call agentTriage on the new images only to get screenshot_text,
    // then pass that text to the evaluator.
    let visionSummary = null;
    if (newImages.length > 0) {
      const agentTriage = require('../services/agentTriage');
      const { getConfig } = require('../config/config');
      if (getConfig('agent_enabled') !== false) {
        try {
          const result = await agentTriage.triageIssue({
            text: `(vision-only follow-up for issue ${updatedIssue.id}) describe each screenshot briefly and extract visible error text`,
            images: newImages,
            ctx: { firestore, guild: message.guild, channelId: message.channel.id, reporterId: updatedIssue.reporterId },
          });
          visionSummary = result?.evidence?.screenshot_text || null;
        } catch (err) {
          console.error('thread vision pass failed:', err.message);
        }
      }
    }

    const evaluation = await require('../services/contextEvaluator').evaluateContext(
      updatedIssue,
      history,
      visionSummary ? `[Extracted from new screenshots]:\n${visionSummary}` : undefined
    );

    // processEvaluation updates triage embed + reclassify; pass evaluation as-is.
    await require('../services/contextEvaluator').processEvaluation(message.guild, updatedIssue, updatedIssue.id, evaluation);

    // Auto-resolve
    if (evaluation.resolved && message.author.id === updatedIssue.reporterId) {
      await firestore.updateIssueResolution(updatedIssue.id, {
        resolvedBy: 'reporter',
        resolvedReason: evaluation.resolvedReason,
      });
      try {
        await message.channel.send({ content: 'Marked as resolved — reply if it comes back.' });
      } catch {}
      // Update the triage embed color/field via updateContextBadge-like path (reuse existing helper)
      try {
        await require('../services/contextEvaluator').updateContextBadge(message.guild, { ...updatedIssue, status: 'resolved' }, updatedIssue.id);
      } catch {}
    }

    // Smart reply or react
    if (evaluation.responseMode === 'reply' && evaluation.reply && canBotReplyInThread(threadId)) {
      try { await message.channel.send({ content: evaluation.reply }); } catch {}
    } else if (evaluation.responseMode === 'react') {
      await message.react('✅').catch(() => {});
    } // ignore: do nothing

    // Bump lastEvaluatedAt so next invocation only fetches newer images.
    try { await firestore.setIssueLastEvaluatedAt(updatedIssue.id, new Date().toISOString()); } catch {}
  } catch (err) {
    console.error('Error processing thread context update:', err);
  }
}, DEBOUNCE_MS));
```

This removes the forum-vs-non-forum branching. Both paths share identical behavior now.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: All tests pass. Pay attention to any thread-related existing tests that may now fail.

- [ ] **Step 7: Commit**

```bash
git add src/triggers/thread.js test/thread-rate-limit.test.js
git commit -m "$(cat <<'EOF'
feat(thread): unified smart path — responseMode, rate limit, auto-resolve

Removes the forum vs non-forum branching. Every thread message goes
through evaluateContext. Response is ignored, reacted ✅, or replied
to based on responseMode. New screenshots trigger a vision pass
before evaluation. Auto-resolve fires only when the reporter
indicates resolution. Rate limit caps bot replies at
agent_max_replies_per_thread_per_10m per thread.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Auto-resolve standalone test

**Files:**
- Create: `test/autoResolve.test.js`

This tests the decision logic (pure part) in isolation by factoring it into a helper. Keeps thread.js tests integration-light.

- [ ] **Step 1: Extract the decision function from thread.js**

At the top of `src/triggers/thread.js`, add a small pure helper:

```js
function shouldAutoResolve(evaluation, messageAuthorId, reporterId) {
  if (!evaluation?.resolved) return false;
  if (messageAuthorId !== reporterId) return false;
  return true;
}
```

Export it: add `shouldAutoResolve` to `module.exports`. Use it at the auto-resolve site inside the debounced handler in place of the inline `if (evaluation.resolved && message.author.id === updatedIssue.reporterId)`.

- [ ] **Step 2: Write the test**

Create `test/autoResolve.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldAutoResolve } = require('../src/triggers/thread');

test('reporter says solved → resolves', () => {
  assert.equal(shouldAutoResolve({ resolved: true }, 'u1', 'u1'), true);
});

test('non-reporter says fixed → does NOT resolve', () => {
  assert.equal(shouldAutoResolve({ resolved: true }, 'u2', 'u1'), false);
});

test('evaluator says not resolved → no resolve even if reporter', () => {
  assert.equal(shouldAutoResolve({ resolved: false }, 'u1', 'u1'), false);
});

test('null evaluation → no resolve', () => {
  assert.equal(shouldAutoResolve(null, 'u1', 'u1'), false);
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- test/autoResolve.test.js`
Expected: All 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/triggers/thread.js test/autoResolve.test.js
git commit -m "$(cat <<'EOF'
test(thread): extract and test shouldAutoResolve helper

Reporter-only gate on auto-resolve is now a pure unit-tested function.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 8 — Mention trigger improvements

### Task 17: Mention — parent reference context

**Files:**
- Modify: `src/triggers/mention.js`
- Create: `test/mention-parent-context.test.js`

- [ ] **Step 1: Read current `src/triggers/mention.js`**

Run: `cat src/triggers/mention.js`
Expected: See how it calls `pipeline.processIssue`. Identify where we can fetch `message.reference`.

- [ ] **Step 2: Write the test**

Create `test/mention-parent-context.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractParentContext } = require('../src/triggers/mention');

test('returns null when no reference', async () => {
  const msg = { reference: null };
  const out = await extractParentContext(msg);
  assert.equal(out, null);
});

test('returns null when reference has no messageId', async () => {
  const msg = { reference: {} };
  const out = await extractParentContext(msg);
  assert.equal(out, null);
});

test('returns parent content + author when fetch succeeds', async () => {
  const parent = {
    content: 'Gmail broken all morning',
    author: { username: 'alice', id: 'u_alice' },
  };
  const msg = {
    reference: { messageId: 'm_parent' },
    channel: { messages: { fetch: async (id) => id === 'm_parent' ? parent : null } },
  };
  const out = await extractParentContext(msg);
  assert.equal(out.content, 'Gmail broken all morning');
  assert.equal(out.author, 'alice');
});

test('returns null on fetch throw', async () => {
  const msg = {
    reference: { messageId: 'm_parent' },
    channel: { messages: { fetch: async () => { throw new Error('gone'); } } },
  };
  const out = await extractParentContext(msg);
  assert.equal(out, null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- test/mention-parent-context.test.js`
Expected: `extractParentContext` not exported.

- [ ] **Step 4: Add the helper and wire it in**

In `src/triggers/mention.js`, add the helper at module-load time:

```js
async function extractParentContext(message) {
  const refId = message?.reference?.messageId;
  if (!refId) return null;
  try {
    const parent = await message.channel.messages.fetch(refId);
    if (!parent) return null;
    return {
      content: String(parent.content || '').slice(0, 1000),
      author: parent.author?.username || 'unknown',
      authorId: parent.author?.id || null,
    };
  } catch {
    return null;
  }
}
```

Then, at the top of the mention handler (where it currently calls `pipeline.processIssue(message, text)`), compute the parent and pass it through. The pipeline signature needs a small widening — update `pipeline.processIssue` to accept an optional `{ parentMessage }` option, and forward it to `agentTriage.triageIssue`.

In `mention.js`:

```js
const parent = await extractParentContext(message);
await pipeline.processIssue(message, text, { parentMessage: parent ? { ...parent, replierUsername: message.author.username } : null });
```

In `pipeline.js`, change the signature of `processIssue` to `async function processIssue(message, text, opts = {})`, and inside when building the agentTriage call, pass `parentMessage: opts.parentMessage || null`.

Export `extractParentContext` from `mention.js`: in the module.exports block, add it.

- [ ] **Step 5: Run tests**

Run: `npm test -- test/mention-parent-context.test.js`
Expected: All 4 tests pass.

- [ ] **Step 6: Run the full suite to check regressions**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/triggers/mention.js src/services/pipeline.js test/mention-parent-context.test.js
git commit -m "$(cat <<'EOF'
feat(mention): fetch parent message on reply-mentions

When a mention is a reply to another user's message, fetch the
parent and pass it to agentTriage as parentMessage context so the
agent classifies the parent's content (the real complaint) rather
than the reply wrapper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Mention — mentionType early-exit

**Files:**
- Modify: `src/triggers/mention.js`
- Modify: `src/services/pipeline.js`
- Modify: `src/services/agentTriage.js` (system prompt addition)

The agent can classify a mention as `chatter` or `question_to_bot` and the pipeline must honor that by early-exiting.

- [ ] **Step 1: Add `mentionType` to the agentTriage system prompt**

In `src/services/agentTriage.js` `buildSystemPrompt`, append (before the "## Output" section):

```
## Mention type (only set when called for a mention trigger; otherwise omit)
Set mentionType to one of:
- "new_issue": the message (or its parent, on a reply) describes a real issue. Proceed with full classification.
- "followup_on_existing": this is conversation about an already-reported issue. Use search_issues to find the best match; include its id in evidence.related_issues; set summary/reasoning briefly.
- "chatter": casual mention with no report ("lol @Pokedex is broken"). Do NOT create an issue.
- "question_to_bot": user is asking Pokedex something directly ("@Pokedex what do you do?"). Do NOT create an issue.
```

And add to the output schema block:

```
"mentionType": "new_issue" | "followup_on_existing" | "chatter" | "question_to_bot" | null,
```

Also update `parseClassification` to accept `mentionType`:

```js
parsed.mentionType = ['new_issue', 'followup_on_existing', 'chatter', 'question_to_bot'].includes(parsed.mentionType)
  ? parsed.mentionType
  : null;
```

- [ ] **Step 2: Plumb a `trigger` hint into agentTriage**

In `pipeline.processIssue`, when `opts.trigger === 'mention'`, pass `triggerHint: 'mention'` to `agentTriage.triageIssue`. Update `agentTriage.triageIssue` to accept `triggerHint` and include a line in the user message: `(Trigger: mention. Set mentionType in your output.)`.

In `mention.js`, call `pipeline.processIssue(message, text, { parentMessage: ..., trigger: 'mention' })`.

- [ ] **Step 3: Early-exit in `pipeline.processIssue` on chatter/question**

After receiving `classification` from agentTriage, check:

```js
if (classification.mentionType === 'chatter') {
  // Silent — no issue, no reply. Log and exit.
  console.log(`[pipeline] mention classified as chatter, skipping. message ${message.id}`);
  return;
}
if (classification.mentionType === 'question_to_bot') {
  try {
    await message.reply({
      content: 'I do bug triage for poke.com — if you have a bug or suggestion, describe it and I\'ll log it. Try `/help` for commands.',
      allowedMentions: { repliedUser: false },
    });
  } catch {}
  return;
}
if (classification.mentionType === 'followup_on_existing' && Array.isArray(classification.evidence?.related_issues) && classification.evidence.related_issues.length > 0) {
  // Append context to the matched issue and exit.
  const relatedId = classification.evidence.related_issues[0];
  try {
    await firestore.appendThreadContext(relatedId, `[From mention by ${message.author.username}]: ${text}`);
    await message.reply({
      content: `Linked to existing issue \`${relatedId}\`. Adding your note as context.`,
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.error('followup_on_existing append failed:', err.message);
  }
  return;
}
// Otherwise treat as new_issue and fall through to the normal save path.
```

- [ ] **Step 4: Smoke test — module loads**

Run: `node -e "require('./src/services/pipeline'); require('./src/triggers/mention')"`
Expected: Exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/triggers/mention.js src/services/pipeline.js src/services/agentTriage.js
git commit -m "$(cat <<'EOF'
feat(mention): mentionType early-exit — chatter, question_to_bot, followup

Agent now classifies mention intent as new_issue/followup/chatter/
question_to_bot. chatter stays silent. question_to_bot gets a short
help reply. followup_on_existing appends to the matched open issue
instead of creating a new one. Only new_issue hits the normal save
path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 9 — /pokedexbug slash command

### Task 19: /pokedexbug forces target=pokedex_bot and uses agent

**Files:**
- Modify: `src/commands/pokedexbug.js`

- [ ] **Step 1: Read current command**

Already in context from Phase 0 exploration. Currently classifies via hardcoded title/description/priority/category and calls `postIssueEmbed` directly.

- [ ] **Step 2: Add agent call + target override**

Open `src/commands/pokedexbug.js`. After assembling `title`, `description`, and capturing `screenshot`, but before building `issueData`, add:

```js
const agentTriage = require('../services/agentTriage');
const firestore = require('../services/firestore');
const { getConfig } = require('../config/config');
const capabilityGap = require('../services/capabilityGap');

const imageUrls = screenshot && (screenshot.contentType || '').startsWith('image/') ? [screenshot.url] : [];

let classification = null;
if (getConfig('agent_enabled') !== false) {
  try {
    classification = await agentTriage.triageIssue({
      text: `${title}\n\n${description}`,
      images: imageUrls,
      ctx: {
        firestore,
        guild: interaction.guild,
        channelId: interaction.channelId,
        reporterId: interaction.user.id,
        reporterName: interaction.user.username,
      },
    });
  } catch (err) {
    console.error('pokedexbug: agent triage failed, using user-provided values', err.message);
  }
}

// User picked priority/category overrides everything EXCEPT target — force pokedex_bot.
const effectivePriority = priority; // from user selection
const effectiveCategory = category; // from user selection
const effectiveSummary = (classification?.summary && classification.summary.length > 0) ? classification.summary : title;
const effectiveReasoning = classification?.reasoning || 'Reported via /pokedexbug slash command';
const evidence = classification?.evidence || null;
const capabilityGapPayload = classification?.capability_gap || null;
const agentMeta = classification?.agentMeta || null;
```

- [ ] **Step 3: Update issueData to include new fields + target override**

```js
const issueData = {
  text: description,
  reporterId: interaction.user.id,
  reporterName: interaction.user.username,
  guildId: interaction.guildId,
  channelId: null,
  messageId: null,
  priority: effectivePriority,
  category: effectiveCategory,
  summary: effectiveSummary,
  reasoning: effectiveReasoning,
  source: 'pokedexbug',
  attachments,
  target: 'pokedex_bot',
  evidence,
  agentMeta,
  lastEvaluatedAt: new Date().toISOString(),
};
```

- [ ] **Step 4: Record capability gap if emitted**

After `issueId = await firestore.saveIssue(issueData);`, add:

```js
if (capabilityGapPayload && issueId) {
  try {
    await capabilityGap.record({
      gap: capabilityGapPayload,
      issueId,
      guild: interaction.guild,
      firestore,
      ownerId: getConfig('pokedex_owner_id'),
      channelName: getConfig('pokedex_self_channel') || 'pokedex-testing',
    });
  } catch (err) {
    console.error('pokedexbug: capability gap record failed', err.message);
  }
}
```

- [ ] **Step 5: Smoke-test load**

Run: `node -e "require('./src/commands/pokedexbug')"`
Expected: Exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/pokedexbug.js
git commit -m "$(cat <<'EOF'
feat(pokedexbug): run agent triage + force target=pokedex_bot

/pokedexbug now runs the agent for screenshot reading, richer
summary, and capability-gap detection. User-selected priority and
category still win (explicit human judgment). target is always
pokedex_bot so it routes to #pokedex-testing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 10 — Ship prep

### Task 20: Changelog + version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Read current CHANGELOG.md head**

Run: `head -40 CHANGELOG.md`
Expected: See the top entries and format.

- [ ] **Step 2: Prepend the 2.9.0 entry**

Edit `CHANGELOG.md` and insert this block immediately after the top-level title but before the existing `## 2.8.2` (or equivalent most-recent) entry:

```markdown
## 2.9.0 — 2026-04-24

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
```

- [ ] **Step 3: Bump version in package.json**

Edit `package.json` and change `"version": "2.8.2"` to `"version": "2.9.0"`.

- [ ] **Step 4: Verify**

Run: `node -e "console.log(require('./package.json').version)"`
Expected: `2.9.0`

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "$(cat <<'EOF'
chore: bump to 2.9.0 + changelog

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: Final test + manual test plan execution

**Files:** None — this is a verification step.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass. Note any failures and fix them by re-reading the relevant task.

- [ ] **Step 2: Verify config loads without Firestore (offline sanity)**

Run: `node -e "const c = require('./config.json'); const keys = ['pokedex_owner_id','pokedex_self_channel','agent_enabled','agent_max_tool_calls','agent_max_replies_per_thread_per_10m']; for (const k of keys) if (!(k in c)) { console.error('missing', k); process.exit(1); } console.log('all config keys present');"`
Expected: `all config keys present`.

- [ ] **Step 3: Execute manual test plan in a staging guild**

The full checklist is in the spec, §10.2. Copy it here for reference:

1. Mention bot with a screenshot of a fake error → agent extracts text, posts to `eng-triage` with `evidence.screenshot_text` populated.
2. Mention bot in a reply to another user's complaint → parent message is what gets classified, not the "did you see this" wrapper.
3. Post "you're doing it wrong, pokedex" at the bot → routed to `#pokedex-testing`, not `eng-triage`.
4. Report a bug, reply "solved" in the thread as the reporter → issue auto-resolved, embed updated.
5. Report a bug, a *different* user replies "fixed" → no auto-resolve.
6. Report a bug, bot asks a follow-up, reporter sends another screenshot in thread → new screenshot is read; `evidence.screenshot_text` augmented.
7. Report two bugs that should produce the same gap title → first creates a `#pokedex-testing` post; second edits it with count=2. Owner is pinged only on the first.
8. Toggle `agent_enabled: false` via `/config set` → pipeline falls back to today's single-shot behavior. Toggle back on.
9. Block OpenRouter (set `OPENROUTER_API_KEY=invalid` in staging) → issue still saved with fallback classification and "AI unavailable" note.
10. Rapid-fire 5 thread messages from the reporter within 2 minutes → bot replies at most 3 times.

Tick each as completed. If any case fails, file a bug on yourself and fix before merge.

- [ ] **Step 4: Confirm no staged changes before opening PR**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

---

### Task 22: Open PR

**Files:** None — git/gh only.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/smarter-bug-triage
```

- [ ] **Step 2: Open the PR with `gh`**

```bash
gh pr create --title "feat: smarter agent-based bug triage with vision + capability gaps" --body "$(cat <<'EOF'
## Summary
- Replaces single-shot classification with an agent loop that reads screenshots and calls three tools (search_issues, get_poke_status, read_channel_context).
- Adds a deduped capability-gap backlog in #pokedex-testing.
- Routes Pokedex-self bugs/feature requests to #pokedex-testing; poke.com bugs stay in eng-triage.
- Thread replies are now smart (ignore/react/reply), auto-resolve on reporter saying "solved", mention-reply fetches the parent message for context.

## Spec
`docs/superpowers/specs/2026-04-24-smarter-bug-triage-design.md`

## Test plan
- [x] Mention bot with a screenshot of a fake error → agent extracts text, posts to eng-triage with evidence.screenshot_text
- [x] Mention bot in a reply to another user's complaint → parent message content is what gets classified
- [x] Post "you're doing it wrong, pokedex" → routed to #pokedex-testing
- [x] Reporter says "solved" in thread → auto-resolved
- [x] Non-reporter says "fixed" in thread → no auto-resolve
- [x] Follow-up screenshot in thread → read and merged into evidence
- [x] Two bugs produce same gap → second edits existing post (count=2), no re-ping
- [x] `/config set agent_enabled false` → fallback to single-shot classification
- [x] OpenRouter unreachable → issue still saved with "AI unavailable" note
- [x] 5 rapid-fire thread messages → bot replies at most 3 times

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace the `[x]` checkboxes with `[ ]` if you haven't actually run each manual test yet, then tick them as you complete them.

- [ ] **Step 3: Share the PR URL with the user**

Output: The URL returned by `gh pr create`.

---

## Self-review checklist (plan author performed before handoff)

**Spec coverage:**
- §2 goal 1 (screenshots) → Tasks 8, 9, 13, 15.
- §2 goal 2 (agent loop + tools) → Tasks 4-7, 9, 10.
- §2 goal 3 (pokedex-self routing) → Tasks 12, 13, 19.
- §2 goal 4 (smart thread replies) → Tasks 14, 15.
- §2 goal 5 (auto-resolve) → Tasks 14, 15, 16.
- §2 goal 6 (mention context) → Tasks 17, 18.
- §2 goal 7 (capability-gap backlog) → Tasks 11, 13, 19.
- §6 config keys → Task 2.
- §11 graceful degradation → Tasks 10, 13 (agent_enabled fallback), 15 (thread error handling).
- §14 ship process → Tasks 20, 22.

**Placeholder scan:** All steps contain actual code blocks, concrete paths, and runnable commands. No TBDs.

**Type consistency:** `searchIssues` signature `(args, ctx) → array`; `dispatch(name, args, ctx)`; `agentTriage.triageIssue({text, images, ctx, openrouter, parentMessage})`; `capabilityGap.record({gap, issueId, guild, firestore, ownerId, channelName})`; `findTriageChannel(guild, target)`. Consistent across tasks.

**Known soft spots for reviewer attention during execution:**
- Task 5 adjusts `statusFetcher` export name if the actual function name differs — read the file first.
- Task 12 Step 3 (config init in tests) may need adjustment based on the exact shape of `src/config/config.js` exports. Fall back to a `describe`/`before` block if the top-level `before` isn't honored.
- Task 15's unified thread handler is the largest single patch in the plan — review carefully to preserve all existing behavior (debounce, forum-specific context fetch loop).
