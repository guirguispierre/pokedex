# Image Anti-Scam Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan images posted by recently-joined members in monitored channels with OpenRouter's vision model; log every scan, delete/mute/alert on scams, and nuke reposts of known-scam images anywhere via a perceptual hash without paying for a second scan.

**Architecture:** A pure perceptual-hash module (`phash.js`) plus a feature service (`scamscan.js`) that mirrors `automod.js` (own `DEFAULT_CONFIG`, TTL-cached config in the `automod/scamscan` Firestore doc, pure planners, `takeAction`, config-channel logging). Reads swallow errors and return safe defaults; writes propagate (lockdown contract). The cheap perceptual-hash repost check runs before any paid vision call. Scans fail open: API/Discord errors never mute or delete.

**Tech Stack:** Node 18+ CommonJS, discord.js 14, firebase-admin, `sharp` (new — image decode), OpenRouter via existing `callWithTools`, `node --test`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/phash.js` (create) | Pure dHash math: `dhashFromGrayscale`, `hammingDistance`, `isHashMatch`. No I/O. |
| `src/services/scamscan.js` (create) | Config, hash store, pure planners, vision scan, decode, logging, `takeAction`, `handleMessage`. |
| `src/commands/mute.js` (modify) | Extract `applyTimeout(member, durationMs, reason)`; `/mute` reuses it. |
| `src/commands/automod.js` (modify) | New `scamscan` subcommand group + handlers + autocomplete-free. |
| `src/index.js` (modify) | Require scamscan; call in `messageCreate`. |
| `package.json` (modify) | Add `sharp`; bump version `2.12.0 → 2.13.0`. |
| `CHANGELOG.md` (modify) | `[2.13.0]` entry. |
| `src/commands/changelog.js` (modify) | New `2.13.0` array entry. |
| `test/phash.test.js` (create) | dHash math unit tests. |
| `test/scamScan.test.js` (create) | Planner unit tests (network-free, Discord/OpenRouter mocked). |
| `test/applyTimeout.test.js` (create) | `applyTimeout` unit test. |

---

## Task 0: Add the `sharp` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install sharp**

Run: `npm install sharp@^0.33.0`
Expected: `package.json` `dependencies` gains `"sharp": "^0.33.0"`; `node -e "require('sharp')"` exits 0.

- [ ] **Step 2: Verify the existing suite still passes**

Run: `npm test`
Expected: all current tests pass (243).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(scamscan): add sharp for perceptual-hash image decode"
```

---

## Task 1: Pure perceptual-hash module (`phash.js`)

**Files:**
- Create: `src/services/phash.js`
- Test: `test/phash.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/phash.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dhashFromGrayscale, hammingDistance, isHashMatch } = require('../src/services/phash');

// 9x8 grid = 72 pixels. Each row strictly increasing left->right: every
// "left > right" comparison is false -> all 64 bits are 0 -> 16 hex zeros.
function increasingGrid() {
  const px = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) px.push(c);
  return px;
}
// Each row strictly decreasing: every comparison true -> all bits 1 -> all f.
function decreasingGrid() {
  const px = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) px.push(8 - c);
  return px;
}

test('dhashFromGrayscale: increasing rows -> all-zero hash', () => {
  assert.equal(dhashFromGrayscale(increasingGrid()), '0000000000000000');
});

test('dhashFromGrayscale: decreasing rows -> all-one hash', () => {
  assert.equal(dhashFromGrayscale(decreasingGrid()), 'ffffffffffffffff');
});

test('dhashFromGrayscale: too few pixels throws', () => {
  assert.throws(() => dhashFromGrayscale([1, 2, 3]));
});

test('hammingDistance: identical -> 0, opposite -> 64', () => {
  assert.equal(hammingDistance('ffffffffffffffff', 'ffffffffffffffff'), 0);
  assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
});

test('hammingDistance: one differing nibble bit -> 1', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000001'), 1);
});

test('hammingDistance: length mismatch or non-hex -> Infinity', () => {
  assert.equal(hammingDistance('ff', 'ffff'), Infinity);
  assert.equal(hammingDistance('zz', 'zz'), Infinity);
  assert.equal(hammingDistance(null, 'ff'), Infinity);
});

test('isHashMatch: respects the max distance boundary', () => {
  assert.equal(isHashMatch('0000000000000000', '0000000000000003', 2), true);  // 2 bits
  assert.equal(isHashMatch('0000000000000000', '0000000000000007', 2), false); // 3 bits
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/phash.test.js`
Expected: FAIL — `Cannot find module '../src/services/phash'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/phash.js`:

```js
// Perceptual-hash math (dHash). Pure: no I/O, no native deps — safe to unit-test
// without sharp installed. The decode step (image bytes -> 9x8 grayscale grid)
// lives in scamscan.js, which feeds dhashFromGrayscale a plain pixel array.

// Build a 64-bit difference hash from a 9-wide x 8-tall grayscale grid (row-major,
// length >= 72). For each of the 8 rows compare each pixel to its right neighbour
// (9 cols -> 8 comparisons), MSB-first -> 64 bits -> 16 hex chars.
function dhashFromGrayscale(pixels, width = 9, height = 8) {
  if (!Array.isArray(pixels) || pixels.length < width * height) {
    throw new Error(`dhashFromGrayscale: expected >= ${width * height} pixels, got ${pixels && pixels.length}`);
  }
  let bits = '';
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width - 1; col++) {
      const left = pixels[row * width + col];
      const right = pixels[row * width + col + 1];
      bits += left > right ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

const HEX_RE = /^[0-9a-f]+$/i;

// Count differing bits between two equal-length hex hashes. Mismatched length or
// non-hex input -> Infinity (callers treat that as "no match").
function hammingDistance(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return Infinity;
  if (hexA.length !== hexB.length) return Infinity;
  if (!HEX_RE.test(hexA) || !HEX_RE.test(hexB)) return Infinity;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    let xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (xor) { dist += xor & 1; xor >>= 1; }
  }
  return dist;
}

function isHashMatch(hexA, hexB, maxDistance) {
  return hammingDistance(hexA, hexB) <= maxDistance;
}

module.exports = { dhashFromGrayscale, hammingDistance, isHashMatch };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/phash.test.js`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add src/services/phash.js test/phash.test.js
git commit -m "feat(scamscan): pure dHash perceptual-hash module + tests"
```

---

## Task 2: scamscan service — config block + pure planners + tests

**Files:**
- Create: `src/services/scamscan.js`
- Test: `test/scamScan.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scamScan.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const scamscan = require('../src/services/scamscan');
const {
  DEFAULT_CONFIG, isNewMember, isExemptRole, selectScannableAttachments,
  parseVerdict, matchKnownScam, planAction,
} = scamscan;

const DAY = 24 * 60 * 60 * 1000;

test('DEFAULT_CONFIG: feature off by default, channels unset', () => {
  assert.equal(DEFAULT_CONFIG.scamScanEnabled, false);
  assert.deepEqual(DEFAULT_CONFIG.monitorChannelIds, []);
  assert.equal(DEFAULT_CONFIG.reviewChannelId, null);
  assert.equal(DEFAULT_CONFIG.adminChannelId, null);
  assert.equal(DEFAULT_CONFIG.joinWindowMs, 3 * DAY);
  assert.equal(DEFAULT_CONFIG.muteMs, 7 * DAY);
  assert.equal(DEFAULT_CONFIG.threshold, 0.8);
});

test('isNewMember: inside, outside, and missing joinedTimestamp', () => {
  const now = 1_000_000_000;
  assert.equal(isNewMember({ joinedTimestamp: now - DAY }, now, 3 * DAY), true);
  assert.equal(isNewMember({ joinedTimestamp: now - 5 * DAY }, now, 3 * DAY), false);
  assert.equal(isNewMember({ joinedTimestamp: null }, now, 3 * DAY), false);
  assert.equal(isNewMember(null, now, 3 * DAY), false);
});

test('isExemptRole: true only when a member role is in the list', () => {
  const member = { roles: { cache: new Map([['modRole', {}]]) } };
  assert.equal(isExemptRole(member, ['modRole', 'adminRole']), true);
  assert.equal(isExemptRole(member, ['adminRole']), false);
  assert.equal(isExemptRole({ roles: null }, ['modRole']), false);
});

test('selectScannableAttachments: MIME, min-dimension, and count cap', () => {
  const atts = [
    { contentType: 'image/png', width: 200, height: 200, url: 'a' },
    { contentType: 'text/plain', width: 200, height: 200, url: 'b' },   // not image
    { contentType: 'image/jpeg', width: 10, height: 200, url: 'c' },    // too small
    { contentType: 'image/webp', width: 200, height: 200, url: 'd' },
    { contentType: 'image/gif', width: 200, height: 200, url: 'e' },
  ];
  const out = selectScannableAttachments(atts, { minDimension: 64, maxAttachments: 2 });
  assert.deepEqual(out.map(a => a.url), ['a', 'd']);
});

test('parseVerdict: clean JSON', () => {
  const v = parseVerdict('{"isScam": true, "confidence": 0.91, "category": "crypto", "reason": "airdrop"}');
  assert.deepEqual(v, { isScam: true, confidence: 0.91, category: 'crypto', reason: 'airdrop', parseFailed: false });
});

test('parseVerdict: fenced JSON', () => {
  const v = parseVerdict('```json\n{"isScam": false, "confidence": 0.2, "category": "meme", "reason": "ok"}\n```');
  assert.equal(v.isScam, false);
  assert.equal(v.confidence, 0.2);
  assert.equal(v.parseFailed, false);
});

test('parseVerdict: garbage -> safe non-scam with parseFailed', () => {
  const v = parseVerdict('the image looks fine to me');
  assert.deepEqual(v, { isScam: false, confidence: 0, category: 'unknown', reason: 'unparseable', parseFailed: true });
});

test('parseVerdict: clamps out-of-range confidence', () => {
  assert.equal(parseVerdict('{"isScam":true,"confidence":5,"category":"x","reason":"y"}').confidence, 1);
  assert.equal(parseVerdict('{"isScam":true,"confidence":-3,"category":"x","reason":"y"}').confidence, 0);
});

test('matchKnownScam: within / outside Hamming threshold / empty', () => {
  const known = [{ id: 'h1', hash: '0000000000000000' }];
  assert.equal(matchKnownScam('0000000000000003', known, 4).id, 'h1'); // 2 bits
  assert.equal(matchKnownScam('00000000000000ff', known, 4), null);    // 8 bits
  assert.equal(matchKnownScam('0000000000000000', [], 4), null);
});

test('planAction: below threshold -> none', () => {
  const p = planAction({ isScam: true, confidence: 0.5 }, { threshold: 0.8 }, {});
  assert.deepEqual(p, { action: 'none', delete: false, mute: false, recordHash: false, alert: false });
});

test('planAction: at/above threshold -> scam, records hash', () => {
  const p = planAction({ isScam: true, confidence: 0.8 }, { threshold: 0.8 }, {});
  assert.deepEqual(p, { action: 'scam', delete: true, mute: true, recordHash: true, alert: true });
});

test('planAction: isScam false never acts even at high confidence', () => {
  assert.equal(planAction({ isScam: false, confidence: 0.99 }, { threshold: 0.8 }, {}).action, 'none');
});

test('planAction: known-scam match -> scam regardless of verdict, no re-record', () => {
  const p = planAction(null, { threshold: 0.8 }, { matchedKnownScam: { id: 'h1' } });
  assert.deepEqual(p, { action: 'scam', delete: true, mute: true, recordHash: false, alert: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scamScan.test.js`
Expected: FAIL — `Cannot find module '../src/services/scamscan'`.

- [ ] **Step 3: Write the implementation (config block + planners)**

Create `src/services/scamscan.js`:

```js
const admin = require('firebase-admin');
const phash = require('./phash');
const { callWithTools } = require('./openrouter');

function getDb() {
  return admin.firestore();
}

// Single-guild bot (DISCORD_GUILD_ID is required), so the scam-scan config doc
// (automod/scamscan) and the scamHashes collection are global, not per-guild.
const CONFIG_DOC = () => getDb().collection('automod').doc('scamscan');
const HASHES = () => getDb().collection('scamHashes');

const DAY = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  scamScanEnabled: false,            // master block flag — feature off by default
  monitorChannelIds: [],             // watched channels; empty = effectively off
  reviewChannelId: null,             // EVERY scan logged here
  adminChannelId: null,              // confirmed-scam alerts
  exemptRoleIds: [],                 // mods/admins skip scanning
  visionModel: 'openai/gpt-4o-mini', // vision-capable; not hardcoded at call site
  joinWindowMs: 3 * DAY,             // new-member window
  muteMs: 7 * DAY,                   // confirmed-scam mute duration
  threshold: 0.8,                    // act at/above this confidence
  hammingThreshold: 10,              // dHash match distance (0..64)
  hashTtlMs: 30 * DAY,               // known-scam hash lifetime
  minDimension: 64,                  // ignore tiny images (px)
  maxAttachments: 4,                 // cap scans per message
  dmOnAction: false,                 // gated DM, like automod's dmOnAction
};

// --- Pure planners (unit-tested) ---

function isNewMember(member, now, windowMs) {
  const joined = member && member.joinedTimestamp;
  if (!joined) return false;
  return now - joined < windowMs;
}

function isExemptRole(member, exemptRoleIds = []) {
  if (!member || !member.roles || !member.roles.cache) return false;
  return exemptRoleIds.some(id => member.roles.cache.has(id));
}

// `attachments` may be an array or a discord.js Collection.
function selectScannableAttachments(attachments, { minDimension, maxAttachments }) {
  const list = Array.isArray(attachments)
    ? attachments
    : Array.from((attachments && attachments.values && attachments.values()) || []);
  const scannable = list.filter(a =>
    a && typeof a.contentType === 'string' && a.contentType.startsWith('image/') &&
    Number.isFinite(a.width) && Number.isFinite(a.height) &&
    a.width >= minDimension && a.height >= minDimension);
  return scannable.slice(0, maxAttachments);
}

// Defensive parse of the vision model's JSON verdict (mirrors normalizeEvaluation).
function parseVerdict(raw) {
  const fail = { isScam: false, confidence: 0, category: 'unknown', reason: 'unparseable', parseFailed: true };
  if (typeof raw !== 'string') return fail;
  let content = raw.trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  let parsed;
  try { parsed = JSON.parse(content); } catch { return fail; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail;
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    isScam: parsed.isScam === true,
    confidence,
    category: typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category : 'unknown',
    reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason : '',
    parseFailed: false,
  };
}

function matchKnownScam(hash, knownHashes = [], maxDistance) {
  for (const rec of knownHashes) {
    if (rec && phash.isHashMatch(hash, rec.hash, maxDistance)) return rec;
  }
  return null;
}

// Decide what to do. Known-scam repost is the cheap path: act regardless of any
// (absent) verdict and do NOT re-record the hash. Otherwise gate on confidence.
function planAction(verdict, { threshold }, opts = {}) {
  if (opts.matchedKnownScam) {
    return { action: 'scam', delete: true, mute: true, recordHash: false, alert: true };
  }
  const scam = !!(verdict && verdict.isScam && verdict.confidence >= threshold);
  if (scam) {
    return { action: 'scam', delete: true, mute: true, recordHash: true, alert: true };
  }
  return { action: 'none', delete: false, mute: false, recordHash: false, alert: false };
}

module.exports = {
  DEFAULT_CONFIG,
  isNewMember,
  isExemptRole,
  selectScannableAttachments,
  parseVerdict,
  matchKnownScam,
  planAction,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scamScan.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/scamscan.js test/scamScan.test.js
git commit -m "feat(scamscan): config block + pure detection planners + tests"
```

---

## Task 3: scamscan config read/write helpers (Firestore)

**Files:**
- Modify: `src/services/scamscan.js`

No unit test — Firestore-backed, following the proven `automod.getAutomodConfig` pattern. Reads swallow errors → safe defaults; writes propagate (lockdown contract).

- [ ] **Step 1: Add the config helpers**

In `src/services/scamscan.js`, after the `DEFAULT_CONFIG` block and before the planners, add:

```js
let cachedConfig = null;
let configLoadedAt = 0;
const CONFIG_TTL = 30000; // 30s cache, matching automod

async function getScamScanConfig() {
  if (cachedConfig && Date.now() - configLoadedAt < CONFIG_TTL) {
    return cachedConfig;
  }
  try {
    const doc = await CONFIG_DOC().get();
    cachedConfig = doc.exists ? { ...DEFAULT_CONFIG, ...doc.data() } : { ...DEFAULT_CONFIG };
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  configLoadedAt = Date.now();
  return cachedConfig;
}

async function updateScamScanConfig(updates) {
  await CONFIG_DOC().set(updates, { merge: true });
  cachedConfig = null; // bust cache
}

// arrayUnion/arrayRemove for monitorChannelIds and exemptRoleIds.
async function addConfigArrayItem(field, id) {
  await CONFIG_DOC().set(
    { [field]: admin.firestore.FieldValue.arrayUnion(id) },
    { merge: true },
  );
  cachedConfig = null;
}

async function removeConfigArrayItem(field, id) {
  await CONFIG_DOC().set(
    { [field]: admin.firestore.FieldValue.arrayRemove(id) },
    { merge: true },
  );
  cachedConfig = null;
}
```

- [ ] **Step 2: Export the helpers**

Extend `module.exports` in `src/services/scamscan.js`:

```js
module.exports = {
  DEFAULT_CONFIG,
  getScamScanConfig,
  updateScamScanConfig,
  addConfigArrayItem,
  removeConfigArrayItem,
  isNewMember,
  isExemptRole,
  selectScannableAttachments,
  parseVerdict,
  matchKnownScam,
  planAction,
};
```

- [ ] **Step 3: Verify the suite still passes (planner tests unaffected)**

Run: `node --test test/scamScan.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/scamscan.js
git commit -m "feat(scamscan): TTL-cached config read/write helpers (automod/scamscan doc)"
```

---

## Task 4: Known-scam hash store (Firestore)

**Files:**
- Modify: `src/services/scamscan.js`

Reads swallow errors → `[]`; writes propagate.

- [ ] **Step 1: Add the hash-store helpers**

In `src/services/scamscan.js`, after the config helpers, add:

```js
// --- Known-scam hash store (scamHashes collection, global/single-guild) ---

// Returns non-expired records as { id, ...data }. The scam-hash set is small, so
// an in-memory Hamming compare against all of them is cheap.
async function getKnownScamHashes(now) {
  try {
    const snap = await HASHES().where('expiresAt', '>', now).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    return [];
  }
}

async function recordScamHash({ hash, category, reason, confidence, channelId, userId, expiresAt }) {
  await HASHES().add({
    hash,
    category: category || 'unknown',
    reason: reason || '',
    confidence: typeof confidence === 'number' ? confidence : null,
    seenChannels: channelId ? [channelId] : [],
    firstUserId: userId || null,
    expiresAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function addHashSeenChannel(docId, channelId) {
  await HASHES().doc(docId).set(
    { seenChannels: admin.firestore.FieldValue.arrayUnion(channelId) },
    { merge: true },
  );
}
```

- [ ] **Step 2: Export the helpers**

Add `getKnownScamHashes`, `recordScamHash`, `addHashSeenChannel` to `module.exports`.

- [ ] **Step 3: Verify planner tests still pass**

Run: `node --test test/scamScan.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/scamscan.js
git commit -m "feat(scamscan): TTL'd known-scam hash store helpers"
```

---

## Task 5: Vision scan, image decode, logging, and the main handler

**Files:**
- Modify: `src/services/scamscan.js`

Orchestration mirrors `automod.handleMessage`/`takeAction`. Not unit-tested (matches repo convention for the Firestore/Discord-bound handler); all branching logic lives in the Task 2 planners.

- [ ] **Step 1: Add the vision scan + decode helpers**

In `src/services/scamscan.js`, after the hash store, add:

```js
// --- Vision scan (paid path) ---

const SCAM_SCAN_SYSTEM_PROMPT = `You are an image-safety classifier for a Discord community for poke.com.
Look at the attached image and decide whether it is a SCAM image — e.g. fake crypto/NFT airdrops or giveaways, free-Nitro/gift-card bait, phishing or wallet-drainer screenshots, impersonation of staff or brands, "double your money" schemes, or fake login/QR pages.
Ordinary memes, screenshots, photos, art, and product images are NOT scams.
Return ONLY strict JSON, no prose, no code fences:
{"isScam": boolean, "confidence": number between 0 and 1, "category": string, "reason": string}`;

// Throws on API error/timeout — the caller fails open.
async function scanImage(imageUrl, config) {
  const res = await callWithTools({
    messages: [
      { role: 'system', content: SCAM_SCAN_SYSTEM_PROMPT },
      { role: 'user', content: 'Analyze the attached image and decide if it is a scam.' },
    ],
    images: [imageUrl],
    model: config.visionModel,
  });
  return parseVerdict(res.content);
}

// --- Image decode (sharp lazy-required so planner tests never load the binary) ---

async function fetchImageBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch image failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function computeImageHash(buffer) {
  const sharp = require('sharp');
  const { data, info } = await sharp(buffer)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // grayscale().raw() may emit info.channels bytes/pixel (b-w keeps R=G=B); take
  // the first channel of each pixel to get the 72 grayscale values.
  const pixels = [];
  for (let i = 0; i < data.length; i += info.channels) pixels.push(data[i]);
  return phash.dhashFromGrayscale(pixels);
}
```

- [ ] **Step 2: Add logging + DM helpers**

Append to `src/services/scamscan.js`:

```js
// --- Logging / alerts ---

function resolveChannel(guild, idOrNull) {
  if (!idOrNull) return null;
  return guild.channels.cache.get(idOrNull) || null;
}

// Posts to the review channel for EVERY scan and every decode/scan failure.
async function logScan(guild, config, { userId, username, channelId, imageUrl, verdict, acted, error }) {
  const channel = resolveChannel(guild, config.reviewChannelId);
  if (!channel) return;
  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder()
    .setTitle('🔍 Scam Scan')
    .setColor(error ? 0x95a5a6 : acted ? 0xe74c3c : 0x2ecc71)
    .addFields(
      { name: 'User', value: `<@${userId}> (${username})`, inline: true },
      { name: 'Channel', value: `<#${channelId}>`, inline: true },
      { name: 'Acted', value: acted ? 'Yes — removed & muted' : 'No', inline: true },
    )
    .setTimestamp();
  if (error) {
    embed.addFields({ name: 'Scan error (failed open)', value: String(error).slice(0, 1024) });
  } else if (verdict) {
    embed.addFields({ name: 'Verdict', value: '```json\n' + JSON.stringify(verdict).slice(0, 1000) + '\n```' });
  }
  if (imageUrl) embed.setImage(imageUrl);
  try { await channel.send({ embeds: [embed] }); } catch (err) { console.error('scamscan: review log failed:', err.message); }
}

async function alertAdmins(guild, config, { userId, username, channelId, category, reason, confidence, imageUrl, seenChannels }) {
  const channel = resolveChannel(guild, config.adminChannelId);
  if (!channel) return;
  const { EmbedBuilder } = require('discord.js');
  const seen = (seenChannels || []).map(c => `<#${c}>`).join(', ') || `<#${channelId}>`;
  const embed = new EmbedBuilder()
    .setTitle('🚨 Scam image removed')
    .setColor(0x8b0000)
    .addFields(
      { name: 'User', value: `<@${userId}> (${username})`, inline: true },
      { name: 'Posted in', value: `<#${channelId}>`, inline: true },
      { name: 'Category', value: category || 'unknown', inline: true },
      { name: 'Confidence', value: confidence != null ? `${Math.round(confidence * 100)}%` : 'n/a (repost)', inline: true },
      { name: 'Reason', value: (reason || 'n/a').slice(0, 1024) },
      { name: 'Seen in channels', value: seen.slice(0, 1024) },
    )
    .setTimestamp();
  if (imageUrl) embed.setImage(imageUrl);
  try { await channel.send({ embeds: [embed] }); } catch (err) { console.error('scamscan: admin alert failed:', err.message); }
}

async function dmUser(user, guild, reason) {
  try {
    const { EmbedBuilder } = require('discord.js');
    await user.send({ embeds: [new EmbedBuilder()
      .setTitle(`🚫 Your image was removed in ${guild.name}`)
      .setColor(0xe74c3c)
      .setDescription(`It was flagged as a scam: **${reason || 'scam image'}**. If this was a mistake, contact the moderators.`)
      .setTimestamp()] });
  } catch {
    // Can't DM — fine.
  }
}
```

- [ ] **Step 3: Add `takeAction` and `handleMessage`**

Append to `src/services/scamscan.js`:

```js
// --- Action + main handler ---

const { applyTimeout } = require('../commands/mute');

// Executes a 'scam' plan: delete, mute, record/extend hash, alert, optional DM,
// review log. Each side effect is independently guarded so one failure (e.g. the
// message was already deleted) does not abort the rest.
async function takeAction(message, config, member, plan, ctx) {
  const { userId, username, channelId, imageUrl, hash, verdict, matchedKnownScam } = ctx;

  try { await message.delete(); } catch { /* already gone / no perms */ }

  if (plan.mute) {
    try { await applyTimeout(member, config.muteMs, `Scam image: ${ctx.reason || 'flagged'}`); }
    catch (err) { console.error('scamscan: mute failed:', err.message); }
  }

  let seenChannels = [channelId];
  if (matchedKnownScam) {
    try { await addHashSeenChannel(matchedKnownScam.id, channelId); } catch (err) { console.error('scamscan: seen-channel update failed:', err.message); }
    seenChannels = Array.from(new Set([...(matchedKnownScam.seenChannels || []), channelId]));
  } else if (plan.recordHash) {
    try {
      await recordScamHash({
        hash, category: ctx.category, reason: ctx.reason,
        confidence: verdict ? verdict.confidence : null,
        channelId, userId, expiresAt: Date.now() + config.hashTtlMs,
      });
    } catch (err) { console.error('scamscan: hash record failed:', err.message); }
  }

  if (plan.alert) {
    await alertAdmins(message.guild, config, {
      userId, username, channelId,
      category: ctx.category, reason: ctx.reason,
      confidence: verdict ? verdict.confidence : null,
      imageUrl, seenChannels,
    });
  }

  if (config.dmOnAction) await dmUser(message.author, message.guild, ctx.reason);

  await logScan(message.guild, config, { userId, username, channelId, imageUrl, verdict: verdict || { repost: true, category: ctx.category }, acted: true });

  return 'scam';
}

async function handleMessage(message) {
  if (message.author.bot || !message.guild) return null;
  if (!message.attachments || message.attachments.size === 0) return null;

  const config = await getScamScanConfig();
  if (!config.scamScanEnabled) return null;
  if (!config.monitorChannelIds.includes(message.channel.id)) return null;

  const scannable = selectScannableAttachments(message.attachments, {
    minDimension: config.minDimension,
    maxAttachments: config.maxAttachments,
  });
  if (scannable.length === 0) return null;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (isExemptRole(member, config.exemptRoleIds)) return null;

  const now = Date.now();
  const newMember = isNewMember(member, now, config.joinWindowMs);
  const known = await getKnownScamHashes(now);

  // Nothing the cheap path can match and the paid path only runs for new members.
  if (known.length === 0 && !newMember) return null;

  const userId = message.author.id;
  const username = message.author.username;
  const channelId = message.channel.id;

  for (const att of scannable) {
    const imageUrl = att.url;

    // Decode for the perceptual hash. Decode failure -> log, skip this image.
    let hash;
    try {
      hash = await computeImageHash(await fetchImageBytes(imageUrl));
    } catch (err) {
      await logScan(message.guild, config, { userId, username, channelId, imageUrl, error: `decode: ${err.message}` });
      continue;
    }

    // Repost short-circuit (applies to everyone) — no API call.
    const matchedKnownScam = matchKnownScam(hash, known, config.hammingThreshold);
    if (matchedKnownScam) {
      const plan = planAction(null, { threshold: config.threshold }, { matchedKnownScam });
      return await takeAction(message, config, member, plan, {
        userId, username, channelId, imageUrl, hash,
        verdict: null, matchedKnownScam,
        category: matchedKnownScam.category, reason: matchedKnownScam.reason || 'known scam image (repost)',
      });
    }

    // Paid path: new members only.
    if (!newMember) continue;

    let verdict;
    try {
      verdict = await scanImage(imageUrl, config);
    } catch (err) {
      // Fail open — never mute/delete on API error.
      await logScan(message.guild, config, { userId, username, channelId, imageUrl, error: `scan: ${err.message}` });
      continue;
    }

    const plan = planAction(verdict, { threshold: config.threshold }, {});
    if (plan.action !== 'scam') {
      await logScan(message.guild, config, { userId, username, channelId, imageUrl, verdict, acted: false });
      continue;
    }

    return await takeAction(message, config, member, plan, {
      userId, username, channelId, imageUrl, hash,
      verdict, matchedKnownScam: null,
      category: verdict.category, reason: verdict.reason || 'scam image',
    });
  }

  return null;
}
```

- [ ] **Step 4: Export the handler**

Add `handleMessage` (and, for completeness, `scanImage`, `computeImageHash`) to `module.exports`.

- [ ] **Step 5: Verify the full suite passes**

Run: `npm test`
Expected: all tests pass (existing + phash + scamscan planners). Note: `handleMessage` requires `../commands/mute`, which must export `applyTimeout` — implemented in Task 6, so run this step after Task 6 if executing strictly in order. If running now, temporarily expect the `applyTimeout` import to be `undefined` only at call time (not import time), so tests that don't call `handleMessage` still pass.

> **Ordering note:** Task 6 (mute `applyTimeout`) has no dependency on this task and can be done first. Recommended order: Task 6 before Task 5 Step 3. The plan lists Task 6 next.

- [ ] **Step 6: Commit**

```bash
git add src/services/scamscan.js
git commit -m "feat(scamscan): vision scan, sharp decode, logging, takeAction + handleMessage"
```

---

## Task 6: Extract `applyTimeout` in mute.js

**Files:**
- Modify: `src/commands/mute.js`
- Test: `test/applyTimeout.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/applyTimeout.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyTimeout } = require('../src/commands/mute');

test('applyTimeout: non-moderatable member -> false, no timeout call', async () => {
  let called = false;
  const member = { moderatable: false, timeout: async () => { called = true; } };
  assert.equal(await applyTimeout(member, 1000, 'r'), false);
  assert.equal(called, false);
});

test('applyTimeout: null member -> false', async () => {
  assert.equal(await applyTimeout(null, 1000, 'r'), false);
});

test('applyTimeout: moderatable member -> calls timeout, returns true', async () => {
  let args = null;
  const member = { moderatable: true, timeout: async (ms, reason) => { args = { ms, reason }; } };
  assert.equal(await applyTimeout(member, 5000, 'spam'), true);
  assert.deepEqual(args, { ms: 5000, reason: 'spam' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/applyTimeout.test.js`
Expected: FAIL — `applyTimeout is not a function`.

- [ ] **Step 3: Add `applyTimeout` and refactor `execute`**

In `src/commands/mute.js`, add the helper above `execute`:

```js
// Reusable Discord-timeout path (also used by the scam scanner). Returns false
// without calling timeout when the member is missing or not moderatable.
async function applyTimeout(member, durationMs, reason) {
  if (!member || !member.moderatable) return false;
  await member.timeout(durationMs, reason);
  return true;
}
```

Then replace the existing timeout block in `execute`:

```js
  if (!member.moderatable) return interaction.editReply('I cannot mute this user. They may have higher permissions than me.');

  try {
    await member.timeout(durationMs, reason);
  } catch (err) {
    console.error('Failed to mute:', err);
    return interaction.editReply('Failed to mute this user. Please check bot permissions and try again.');
  }
```

with:

```js
  if (!member.moderatable) return interaction.editReply('I cannot mute this user. They may have higher permissions than me.');

  try {
    await applyTimeout(member, durationMs, reason);
  } catch (err) {
    console.error('Failed to mute:', err);
    return interaction.editReply('Failed to mute this user. Please check bot permissions and try again.');
  }
```

Update the exports line:

```js
module.exports = { data: commandData, execute, applyTimeout };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/applyTimeout.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/mute.js test/applyTimeout.test.js
git commit -m "refactor(mute): extract reusable applyTimeout for scamscan reuse"
```

---

## Task 7: `/automod scamscan` subcommand group

**Files:**
- Modify: `src/commands/automod.js`

- [ ] **Step 1: Add the `scamscan` subcommand group to the builder**

In `src/commands/automod.js`, require scamscan at the top (after the existing `automod` require):

```js
const scamscan = require('../services/scamscan');
```

Add this group to the `commandData` chain (before the final `;`):

```js
  // image scam scanner
  .addSubcommandGroup(group =>
    group.setName('scamscan')
      .setDescription('Vision-based image scam scanner')
      .addSubcommand(sub => sub.setName('enable').setDescription('Enable the image scam scanner'))
      .addSubcommand(sub => sub.setName('disable').setDescription('Disable the image scam scanner'))
      .addSubcommand(sub => sub.setName('config').setDescription('View scam-scanner settings'))
      .addSubcommand(sub =>
        sub.setName('monitor').setDescription('Add/remove a monitored channel')
          .addStringOption(opt => opt.setName('action').setDescription('add or remove').setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
          .addChannelOption(opt => opt.setName('channel').setDescription('Channel to monitor')
            .addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('review').setDescription('Set the review/audit channel (every scan logged here)')
          .addChannelOption(opt => opt.setName('channel').setDescription('Review channel')
            .addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('admin').setDescription('Set the admin alert channel (confirmed scams)')
          .addChannelOption(opt => opt.setName('channel').setDescription('Admin channel')
            .addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('exempt').setDescription('Add/remove an exempt role (skips scanning)')
          .addStringOption(opt => opt.setName('action').setDescription('add or remove').setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
          .addRoleOption(opt => opt.setName('role').setDescription('Role to exempt').setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('dm').setDescription('Toggle DMing users when their image is removed')
          .addBooleanOption(opt => opt.setName('enabled').setDescription('Send DMs?').setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('model').setDescription('Set the vision model id')
          .addStringOption(opt => opt.setName('name').setDescription('OpenRouter vision model id').setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('settings').setDescription('Tune thresholds and limits')
          .addIntegerOption(opt => opt.setName('join_days').setDescription('New-member window (days)').setMinValue(1).setMaxValue(90))
          .addIntegerOption(opt => opt.setName('mute_days').setDescription('Mute duration (days)').setMinValue(1).setMaxValue(28))
          .addIntegerOption(opt => opt.setName('threshold').setDescription('Confidence to act, percent').setMinValue(50).setMaxValue(100))
          .addIntegerOption(opt => opt.setName('hamming').setDescription('Repost match distance (0-64)').setMinValue(0).setMaxValue(64))
          .addIntegerOption(opt => opt.setName('min_dimension').setDescription('Ignore images smaller than (px)').setMinValue(1).setMaxValue(4096))
          .addIntegerOption(opt => opt.setName('max_attachments').setDescription('Max images scanned per message').setMinValue(1).setMaxValue(10))))
```

- [ ] **Step 2: Route the group in `execute`**

In `execute`, add to the group routing (alongside `blocklist`/`links`/`exempt`):

```js
  if (group === 'scamscan') return handleScamScan(interaction, sub);
```

- [ ] **Step 3: Add the `handleScamScan` handler**

Add this function in `src/commands/automod.js` (e.g. after `handleExempt`):

```js
async function handleScamScan(interaction, sub) {
  await interaction.deferReply({ ephemeral: true });
  const DAY = 24 * 60 * 60 * 1000;

  if (sub === 'enable' || sub === 'disable') {
    await scamscan.updateScamScanConfig({ scamScanEnabled: sub === 'enable' });
    return interaction.editReply(`${sub === 'enable' ? '✅' : '⛔'} Image scam scanner **${sub === 'enable' ? 'enabled' : 'disabled'}**.`);
  }

  if (sub === 'monitor') {
    const action = interaction.options.getString('action');
    const channel = interaction.options.getChannel('channel');
    if (action === 'add') await scamscan.addConfigArrayItem('monitorChannelIds', channel.id);
    else await scamscan.removeConfigArrayItem('monitorChannelIds', channel.id);
    return interaction.editReply(`✅ ${action === 'add' ? 'Now monitoring' : 'Stopped monitoring'} ${channel}.`);
  }

  if (sub === 'review') {
    const channel = interaction.options.getChannel('channel');
    await scamscan.updateScamScanConfig({ reviewChannelId: channel.id });
    return interaction.editReply(`📋 Scan reviews will be logged to ${channel}.`);
  }

  if (sub === 'admin') {
    const channel = interaction.options.getChannel('channel');
    await scamscan.updateScamScanConfig({ adminChannelId: channel.id });
    return interaction.editReply(`🚨 Scam alerts will be sent to ${channel}.`);
  }

  if (sub === 'exempt') {
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('role');
    if (action === 'add') await scamscan.addConfigArrayItem('exemptRoleIds', role.id);
    else await scamscan.removeConfigArrayItem('exemptRoleIds', role.id);
    return interaction.editReply(`✅ ${action === 'add' ? 'Exempted' : 'Un-exempted'} ${role} from scam scanning.`);
  }

  if (sub === 'dm') {
    const enabled = interaction.options.getBoolean('enabled');
    await scamscan.updateScamScanConfig({ dmOnAction: enabled });
    return interaction.editReply(`${enabled ? '✅' : '⛔'} User DMs on removal **${enabled ? 'enabled' : 'disabled'}**.`);
  }

  if (sub === 'model') {
    const name = interaction.options.getString('name').trim();
    await scamscan.updateScamScanConfig({ visionModel: name });
    return interaction.editReply(`✅ Vision model set to \`${name}\`.`);
  }

  if (sub === 'settings') {
    const updates = {};
    const joinDays = interaction.options.getInteger('join_days');
    const muteDays = interaction.options.getInteger('mute_days');
    const threshold = interaction.options.getInteger('threshold');
    const hamming = interaction.options.getInteger('hamming');
    const minDim = interaction.options.getInteger('min_dimension');
    const maxAtt = interaction.options.getInteger('max_attachments');
    if (joinDays !== null) updates.joinWindowMs = joinDays * DAY;
    if (muteDays !== null) updates.muteMs = muteDays * DAY;
    if (threshold !== null) updates.threshold = threshold / 100;
    if (hamming !== null) updates.hammingThreshold = hamming;
    if (minDim !== null) updates.minDimension = minDim;
    if (maxAtt !== null) updates.maxAttachments = maxAtt;
    if (Object.keys(updates).length === 0) return interaction.editReply('No settings specified.');
    await scamscan.updateScamScanConfig(updates);
    const lines = Object.entries(updates).map(([k, v]) => `**${k}**: ${v}`);
    return interaction.editReply(`✅ Updated:\n${lines.join('\n')}`);
  }

  // sub === 'config'
  const cfg = await scamscan.getScamScanConfig();
  const embed = new EmbedBuilder()
    .setTitle('🔍 Image Scam Scanner')
    .setColor(cfg.scamScanEnabled ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: 'Status', value: cfg.scamScanEnabled ? '✅ Enabled' : '⛔ Disabled', inline: true },
      { name: 'Vision model', value: `\`${cfg.visionModel}\``, inline: true },
      { name: 'DM on action', value: cfg.dmOnAction ? 'Yes' : 'No', inline: true },
      { name: 'Monitored', value: cfg.monitorChannelIds.length ? cfg.monitorChannelIds.map(c => `<#${c}>`).join(', ') : 'None (off)' },
      { name: 'Review channel', value: cfg.reviewChannelId ? `<#${cfg.reviewChannelId}>` : 'Not set', inline: true },
      { name: 'Admin channel', value: cfg.adminChannelId ? `<#${cfg.adminChannelId}>` : 'Not set', inline: true },
      { name: 'Exempt roles', value: cfg.exemptRoleIds.length ? cfg.exemptRoleIds.map(r => `<@&${r}>`).join(', ') : 'None' },
      { name: 'Tuning', value: [
        `New-member window: ${Math.round(cfg.joinWindowMs / DAY)}d`,
        `Mute: ${Math.round(cfg.muteMs / DAY)}d`,
        `Act at: ${Math.round(cfg.threshold * 100)}% confidence`,
        `Repost match: ≤${cfg.hammingThreshold} bits`,
        `Min image: ${cfg.minDimension}px`,
        `Max/msg: ${cfg.maxAttachments}`,
      ].join('\n') },
    )
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}
```

- [ ] **Step 4: Sanity-check the command builds (no syntax/registration errors)**

Run: `node -e "const c=require('./src/commands/automod'); console.log('automod command loads:', !!c.data && !!c.execute)"`
Expected: `automod command loads: true`.

- [ ] **Step 5: Verify full suite still passes**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/automod.js
git commit -m "feat(scamscan): /automod scamscan config subcommands"
```

---

## Task 8: Wire scamscan into `messageCreate`

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Require the service**

In `src/index.js`, after `const automod = require('./services/automod');` (line ~44), add:

```js
const scamscan = require('./services/scamscan');
```

- [ ] **Step 2: Call it in `messageCreate`**

In the `messageCreate` handler, immediately after the automod block (after the `console.error('Error in automod:', err);` try/catch closes, ~line 156) and before the AFK block, insert:

```js
  // Image scam scanner — vision scan of new members' images + repost short-circuit
  try {
    const scamResult = await scamscan.handleMessage(message);
    if (scamResult) return; // image removed
  } catch (err) {
    console.error('Error in scam scan:', err);
  }
```

- [ ] **Step 3: Sanity-check index.js parses**

Run: `node -e "require('./src/services/scamscan'); console.log('scamscan loads ok')"`
Expected: `scamscan loads ok` (full `index.js` boot needs env/Discord, so just load the service).

- [ ] **Step 4: Verify full suite still passes**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat(scamscan): wire image scanner into messageCreate"
```

---

## Task 9: Version bump, changelog, and in-bot changelog entry

**Files:**
- Modify: `package.json`, `CHANGELOG.md`, `src/commands/changelog.js`

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "2.12.0"` to `"version": "2.13.0"`.

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md` (above `## [2.12.0]`), add:

```markdown
## [2.13.0] - 2026-06-14

### Added
- **Image scam scanner** — when a recently-joined member posts an image in a monitored channel, Pokedex scans it with an OpenRouter vision model. Every scan is logged to a review channel. If it's a scam (confidence ≥ threshold), the message is deleted, the user is muted, and admins are alerted with the evidence. Configure via `/automod scamscan enable|monitor|review|admin|exempt|settings|dm|model|config`. Off by default until channels are set. Requires **Manage Server**.
- **Repost nuking via perceptual hash** — confirmed scam images are fingerprinted with a dHash. If the same image (even re-encoded or resized) is reposted in any channel by anyone, it's removed immediately without a second paid scan, and the admin alert lists every channel the image has been seen in. Fingerprints expire after 30 days.

### Internal
- New pure, unit-tested helpers: `dhashFromGrayscale`/`hammingDistance`/`isHashMatch` (`phash.js`), and `isNewMember`/`isExemptRole`/`selectScannableAttachments`/`parseVerdict`/`matchKnownScam`/`planAction` (`scamscan.js`). New service `scamscan.js` (config in `automod/scamscan`, fingerprints in the `scamHashes` collection) following the lockdown Firestore error contract. Extracted `applyTimeout` from `mute.js` so the scanner reuses the existing Discord-timeout path. Added `sharp` for image decode. Scans **fail open**: API/Discord errors never mute or delete.
```

- [ ] **Step 3: Add the in-bot `/changelog` entry**

In `src/commands/changelog.js`, add as the first element of the `CHANGELOG` array (before the `2.12.0` object):

```js
  {
    version: '2.13.0',
    date: '2026-06-14',
    headline: 'Vision-based image scam scanner with repost nuking.',
    sections: {
      new: [
        '**Image scam scanner** — new members\' images in monitored channels are scanned by an OpenRouter vision model. Every scan is logged to a review channel; confirmed scams are deleted, the user muted, and admins alerted. Set it up with `/automod scamscan` (off until channels are configured)',
        '**Repost nuking** — confirmed scam images are fingerprinted (perceptual hash), so the same image reposted anywhere is removed instantly without a second scan, even if re-encoded or resized',
      ],
      internal: [
        'Scanner fails open (model/Discord errors never mute or delete), reuses the `/mute` timeout path, and ships with new pure unit-tested helpers for hashing, the new-member window, verdict parsing, and the action planner',
      ],
    },
  },
```

- [ ] **Step 4: Verify changelog command still loads and suite passes**

Run: `node -e "require('./src/commands/changelog'); console.log('ok')" && npm test`
Expected: `ok`, then all tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md src/commands/changelog.js
git commit -m "chore(scamscan): bump to 2.13.0, changelog entries"
```

---

## Final Verification

- [ ] **Run the entire suite**

Run: `npm test`
Expected: all tests pass (243 prior + new phash/scamscan/applyTimeout tests). Confirm the count went up and nothing regressed.

- [ ] **Confirm the feature is off by default**

Run: `node -e "const s=require('./src/services/scamscan'); console.log(s.DEFAULT_CONFIG.scamScanEnabled === false && s.DEFAULT_CONFIG.monitorChannelIds.length === 0 ? 'OFF by default: OK' : 'FAIL')"`
Expected: `OFF by default: OK`.
