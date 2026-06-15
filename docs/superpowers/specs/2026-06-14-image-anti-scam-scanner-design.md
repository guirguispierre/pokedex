# Image Anti-Scam Scanner — Design (v2.13.0)

**Date:** 2026-06-14
**Status:** Approved (pending spec review)

When a recently-joined member posts an image in a monitored channel, scan the
image with OpenRouter's vision model. Log every scan to a review channel. If
it is a scam, delete the message, mute the user, and alert admins. If the same
image is reposted anywhere (by that user or anyone), nuke it without paying for
a second scan, using a perceptual hash.

This feature mirrors the structure of `src/services/automod.js` (detection
function, `takeAction`, a `DEFAULT_CONFIG` block with block flags, config-channel
logging) and copies the documented Firestore error contract from
`src/services/lockdown.js` (read helpers swallow errors and return safe
defaults; write helpers let errors propagate).

**Single-guild assumption:** this bot is single-guild (`DISCORD_GUILD_ID` is
required), so the global Firestore documents (`automod/scamscan` config and the
`scamHashes` collection) are not namespaced per guild. A one-line comment marks
this in code.

---

## Decisions (confirmed)

- **Perceptual hash:** `sharp` decodes/resizes each image to a 9×8 grayscale
  grid; the dHash bit-extraction and Hamming-distance math are hand-rolled and
  unit-tested. `sharp` handles the png/jpeg/webp/avif formats Discord serves.
- **Channel configuration:** monitored / review / admin channels default to
  empty/null in `DEFAULT_CONFIG` and are set at runtime via new `/automod`
  subcommands. The feature stays off until they are configured.
- **New-member window default:** 3 days.
- **Mute duration default:** 7 days.

---

## Module layout

| File | Role |
|---|---|
| `src/services/phash.js` | **Pure** perceptual-hash math. No I/O, no `sharp`. Fully unit-testable. |
| `src/services/scamscan.js` | Feature service mirroring `automod.js`: own `DEFAULT_CONFIG`, TTL-cached config, detection + `takeAction`, pure planners, hash-store helpers, logging. `sharp` is lazy-required inside the decode function. |
| `src/commands/mute.js` | Extract `applyTimeout(member, durationMs, reason)`; both `/mute` and scamscan call it (reuse of the PR #63 timeout path). |
| `src/commands/automod.js` | New `scamscan` subcommand **group**. |
| `src/index.js` | `require` scamscan and call it in `messageCreate`, after the automod block, in its own try/catch. |

---

## `src/services/phash.js` (pure)

- `dhashFromGrayscale(pixels, width = 9, height = 8)` → 16-char hex string.
  `pixels` is a row-major grayscale array of length `width * height`. For each
  of the 8 rows, compare `pixels[x] > pixels[x+1]` across the 9 columns → 8
  bits/row → 64 bits → 16 hex chars.
- `hammingDistance(hexA, hexB)` → integer count of differing bits. Hashes of
  different length, or non-hex input, return `Infinity` (treated as "no match").
- `isHashMatch(hexA, hexB, maxDistance)` → `hammingDistance(...) <= maxDistance`.

No `sharp`, no `fetch`, no Firestore — importable in tests with zero native
dependencies.

---

## `src/services/scamscan.js`

### Config — `automod/scamscan` Firestore doc

A dedicated sub-document of the `automod` collection (which already holds
`config`, `blocklist`, `links`, `exemptions`). Own `DEFAULT_CONFIG`, own 30s TTL
cache, mirroring `automod.getAutomodConfig` / `updateAutomodConfig`.

```js
const DEFAULT_CONFIG = {
  scamScanEnabled: false,            // master block flag — feature off by default
  monitorChannelIds: [],             // watched channels; empty = effectively off
  reviewChannelId: null,             // EVERY scan logged here
  adminChannelId: null,              // confirmed-scam alerts
  exemptRoleIds: [],                 // mods/admins skip scanning
  visionModel: 'openai/gpt-4o-mini', // vision-capable; not hardcoded at call site
  joinWindowMs: 3 * 24 * 60 * 60 * 1000,   // 3 days (new-member window)
  muteMs: 7 * 24 * 60 * 60 * 1000,         // 7 days
  threshold: 0.8,                    // act at/above this confidence
  hammingThreshold: 10,              // dHash match distance (0..64)
  hashTtlMs: 30 * 24 * 60 * 60 * 1000,     // known-scam hash lifetime
  minDimension: 64,                  // ignore tiny images (px)
  maxAttachments: 4,                 // cap scans per message
  dmOnAction: false,                 // gated DM, like automod's dmOnAction
};
```

Config helpers (follow the lockdown error contract):
- `getScamScanConfig()` — TTL-cached read; on error returns `{ ...DEFAULT_CONFIG }`.
- `updateScamScanConfig(updates)` — `set(updates, { merge: true })`, busts cache; errors propagate.
- `addConfigArrayItem(field, id)` / `removeConfigArrayItem(field, id)` — `arrayUnion`/`arrayRemove` for `monitorChannelIds` and `exemptRoleIds`, busts cache; errors propagate.

### Known-scam hash store — `scamHashes` collection (global, single-guild)

Each document:
```js
{ hash, category, reason, confidence, seenChannels: [channelId],
  firstUserId, expiresAt /* ms epoch */, createdAt /* serverTimestamp */ }
```
Fuzzy matching needs Hamming distance, so we cannot key by document id. Helpers:
- `getKnownScamHashes(now)` — read; returns docs with `expiresAt > now` as
  `{ id, ...data }`; on error returns `[]` (swallowed). The scam-hash set is
  small, so an in-memory compare is fine.
- `recordScamHash({ hash, category, reason, confidence, channelId, userId, expiresAt })`
  — write; `add()` a new doc with `seenChannels: [channelId]`; errors propagate.
- `addHashSeenChannel(docId, channelId)` — write; `arrayUnion` the channel onto
  `seenChannels`; errors propagate.

### Pure planners (the unit-tested core)

- `isNewMember(member, now, windowMs)` → `member?.joinedTimestamp` truthy and
  `now - member.joinedTimestamp < windowMs`. Missing `joinedTimestamp` → `false`.
- `isExemptRole(member, exemptRoleIds)` → any of `member.roles.cache` is in the list.
- `selectScannableAttachments(attachments, { minDimension, maxAttachments })` →
  array. Keeps attachments whose `contentType` starts with `image/` and whose
  `width` and `height` are both `>= minDimension`; caps to `maxAttachments`.
  Uses Discord's attachment metadata — no decode needed.
- `parseVerdict(raw)` → `{ isScam, confidence, category, reason, parseFailed }`.
  Defensive like `normalizeEvaluation`: strips ```` ```json ```` fences, coerces
  types, clamps `confidence` to `0..1`. Unparseable or wrong-shape →
  `{ isScam: false, confidence: 0, category: 'unknown', reason: 'unparseable', parseFailed: true }`.
- `matchKnownScam(hash, knownHashes, maxDistance)` → the first record within
  `maxDistance` Hamming distance, else `null`.
- `planAction(verdict, { threshold }, { matchedKnownScam })` →
  `{ action: 'none' | 'scam', delete, mute, recordHash, alert }`.
  - **Known-scam match ⇒ `scam`** regardless of confidence, with
    `recordHash: false` (the hash already exists; the caller updates
    `seenChannels` instead). Safe to act on — this is the cheap short-circuit.
  - Otherwise `scam` iff `verdict.isScam && verdict.confidence >= threshold`,
    with `recordHash: true`.
  - `none` ⇒ all action flags `false`.

### Vision scan — paid path

`scanImage(imageUrl, config)`:
```js
const res = await callWithTools({
  messages: [
    { role: 'system', content: SCAM_SCAN_SYSTEM_PROMPT },
    { role: 'user', content: 'Analyze the attached image.' },
  ],
  images: [imageUrl],
  model: config.visionModel,
});
return parseVerdict(res.content);
```
`SCAM_SCAN_SYSTEM_PROMPT` demands strict JSON:
`{ "isScam": boolean, "confidence": 0..1, "category": string, "reason": string }`.
Errors/timeouts throw — the caller fails open.

### Image decode — `computeImageHash(buffer)`

Lazy-`require('sharp')` (so planner tests never load the native binary), then:
```js
const { data, info } = await sharp(buffer)
  .resize(9, 8, { fit: 'fill' })
  .grayscale()
  .raw()
  .toBuffer({ resolveWithObject: true });
// grayscale().raw() may still emit `info.channels` bytes/pixel (b-w colourspace
// keeps equal R=G=B); sample the first channel of each pixel to get 72 values.
const pixels = [];
for (let i = 0; i < data.length; i += info.channels) pixels.push(data[i]);
return dhashFromGrayscale(pixels);
```
A separate `fetchImageBytes(url)` uses global `fetch` → `arrayBuffer` → `Buffer`.

### Logging

- `logScan(guild, config, { userId, username, channelId, imageUrl, verdict, acted, error })`
  → posts to `reviewChannelId` for **every** scan (and every decode/scan
  failure). Embed shows the image (`setImage`), the verdict JSON, author,
  channel, and whether action was taken. Send errors are swallowed.
- `alertAdmins(guild, config, { userId, username, channelId, category, reason, confidence, imageUrl, seenChannels })`
  → posts to `adminChannelId` with evidence and the list of channels the image
  has been seen in. Send errors are swallowed.
- `dmUser(user, guild, reason)` — gated by `config.dmOnAction`. Swallows failures.

### Mute — reuse the PR #63 timeout path

`src/commands/mute.js` gains:
```js
async function applyTimeout(member, durationMs, reason) {
  if (!member?.moderatable) return false;
  await member.timeout(durationMs, reason);
  return true;
}
```
`execute` is refactored to call it (behavior unchanged). scamscan calls
`applyTimeout(member, config.muteMs, reason)` inside a try/catch.

### Main handler — `handleMessage(message)`

1. Return `null` if `message.author.bot`, no `message.guild`, or no attachments.
2. `config = await getScamScanConfig()`; return `null` unless `scamScanEnabled`
   and `monitorChannelIds.includes(message.channel.id)`.
3. `selectScannableAttachments(...)`; none → return `null`.
4. Resolve the member (`message.member ?? await guild.members.fetch(authorId)`).
   `isExemptRole` → return `null`.
5. `known = await getKnownScamHashes(now)`. **Early out:** if `known` is empty
   **and** the author is not a new member, return `null` (nothing the cheap path
   can match, and the paid path only runs for new members).
6. For each scannable attachment:
   a. `fetchImageBytes(url)` → `computeImageHash(buffer)`. On error: `logScan`
      with `error`, continue to next attachment.
   b. **Repost short-circuit (applies to everyone):** `matchKnownScam(hash, known, hammingThreshold)`.
      If matched → `takeAction` with `planAction(verdict=null-equivalent, ..., { matchedKnownScam })`:
      delete, mute, `addHashSeenChannel(match.id, channelId)`, `alertAdmins`
      (using the stored category/reason and the updated seen-channel list),
      `logScan(acted: true)`. **No API call.** Return the action.
   c. **Paid path (new members only):** if `isNewMember`, `scanImage(url, config)`:
      - On **error/timeout** → fail open: `logScan` with `error`, continue. Never
        mute or delete.
      - On success → **always** `logScan(verdict)`. `planAction(verdict, { threshold }, { matchedKnownScam: null })`.
        If `action === 'scam'`: delete, `applyTimeout`, `recordScamHash(...)`
        (TTL = `now + hashTtlMs`), `alertAdmins`, optional `dmUser`. Return the action.
   d. Not new member and no hash match → continue (skip).
7. Return the action taken, or `null`.

`takeAction(message, config, member, plan, context)` centralizes delete + mute +
hash bookkeeping + alert + DM + review log, mirroring `automod.takeAction`. Each
side effect is independently try/caught so one failure (e.g. message already
deleted) does not abort the rest.

### Anti-false-positive (the v2.12.0 lesson)

The text scam detector hard-skips on any message containing "PSA"/"beware",
which an attacker can prefix to bypass detection. We do **not** add any
attacker-controlled keyword or caption escape hatch. Image gating relies only
on: the model's confidence vs `threshold`, the review-channel audit trail, and
the manual `exemptRoleIds` list (mods/admins, controlled by staff).

---

## Wiring — `src/index.js`

In `messageCreate`, after the existing automod block and before the AFK block:
```js
try {
  const scamResult = await scamscan.handleMessage(message);
  if (scamResult) return;
} catch (err) {
  console.error('Error in scam scan:', err);
}
```
No new gateway intents are required (`GuildMessages` + `MessageContent` already
present; attachments arrive with the message).

---

## `/automod scamscan` subcommands

A new `scamscan` subcommand group on the existing `/automod` command
(`ManageGuild` permission), consistent with the `blocklist`/`links`/`exempt`
groups. Discord allows group → subcommand (2 levels), so add/remove operations
that need a target use an `action` choice option rather than a third nesting
level.

- `enable` / `disable` — toggle `scamScanEnabled`.
- `config` — view current settings (status, channels, window/mute/threshold, counts).
- `monitor <action: add|remove> <channel>` — manage `monitorChannelIds`.
- `review <channel>` — set `reviewChannelId`.
- `admin <channel>` — set `adminChannelId`.
- `exempt <action: add|remove> <role>` — manage `exemptRoleIds`.
- `settings` — optional integers: `join_days`, `mute_days`, `threshold` (0–100 →
  /100), `hamming` (0–64), `min_dimension`, `max_attachments`.
- `dm <enabled: bool>` — toggle `dmOnAction`.
- `model <name: string>` — set `visionModel`.

Channel options restrict to `GuildText`. Array writes go through
`addConfigArrayItem`/`removeConfigArrayItem`.

---

## Tests (`node --test`, network-free)

`test/phash.test.js`:
- `dhashFromGrayscale` on synthetic gradient/flat/checker grids → known bits.
- `hammingDistance` (identical → 0, all-different, length mismatch → Infinity).
- `isHashMatch` at/above/below the boundary.

`test/scamScan.test.js` (OpenRouter + Discord fully mocked / not called):
- `isNewMember` — inside window, outside window, null `joinedTimestamp`.
- `isExemptRole` — exempt vs non-exempt member.
- `selectScannableAttachments` — MIME filter, min-dimension filter, max cap.
- `parseVerdict` — clean JSON, fenced JSON, garbage (→ `parseFailed`),
  out-of-range confidence clamped.
- `matchKnownScam` — within / outside Hamming threshold, empty store.
- `planAction` — below threshold → `none`; at/above threshold → `scam` with
  `recordHash: true`; known-scam short-circuit → `scam` with `recordHash: false`
  regardless of (absent) confidence.

Target: full suite stays green (currently 243 tests; this adds more).

---

## Ship

- Add `sharp` to `dependencies`.
- Bump `package.json` `2.12.0 → 2.13.0`.
- `CHANGELOG.md` `[2.13.0]` entry (Added / Internal).
- New `/changelog` array entry for `2.13.0`.
- Small, one-concern-each commits: (1) phash + tests, (2) scamscan service +
  tests, (3) mute `applyTimeout` extraction, (4) `/automod scamscan` command,
  (5) index wiring, (6) version/changelog/dep bump.

---

## Out of scope

- Cross-guild hash sharing (bot is single-guild).
- Scanning non-image attachments (video/audio/docs).
- A Firestore TTL policy for `scamHashes` (read-time `expiresAt` filtering is the
  contract; a server-side TTL policy can be added later as pure cleanup).
- Re-scanning on message edit (only `messageCreate` triggers).
