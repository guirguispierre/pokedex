// Hard edge-case tests for the vision-based image scam scanner.
// Covers PURE exported helpers only — no sharp, no network, no Discord.
// Firestore is stubbed by swapping admin.firestore() with an in-memory fake
// (the real firestore() callable carries .FieldValue, which we preserve).

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Mock firebase-admin/firestore BEFORE requiring scamscan: the service does
// `const { getFirestore, FieldValue } = require('firebase-admin/firestore')` at
// load time, so the fake must be in the module cache first. getFirestore()
// returns a swappable in-memory db; FieldValue provides inert sentinels.
const _holder = { db: null };
const _FieldValue = {
  arrayUnion: (...els) => ({ __op: 'arrayUnion', els }),
  arrayRemove: (...els) => ({ __op: 'arrayRemove', els }),
  serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  increment: (n) => ({ __op: 'increment', n }),
};
const _fsPath = require.resolve('firebase-admin/firestore');
require.cache[_fsPath] = {
  id: _fsPath, filename: _fsPath, loaded: true,
  exports: { getFirestore: () => _holder.db, FieldValue: _FieldValue },
};

const scamscan = require('../src/services/scamscan');
const {
  DEFAULT_CONFIG,
  getScamScanConfig,
  updateScamScanConfig,
  getKnownScamHashes,
  recordScamHash,
  isNewMember,
  isExemptRole,
  selectScannableAttachments,
  matchKnownScam,
  planAction,
  parseVerdict,
} = scamscan;

const { dhashFromGrayscale, hammingDistance, isHashMatch } = require('../src/services/phash');

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Firestore stub: point the mocked getFirestore() at an in-memory fake db so the
// module's getDb()/CONFIG_DOC()/HASHES() work against in-memory data.
// ---------------------------------------------------------------------------
function installFakeFirestore({ configData = undefined, configThrows = false, hashDocs = [], hashesThrow = false } = {}) {
  // Track the last write so we can assert merge/set payloads.
  const state = { lastSet: null, added: [], configData };

  const configDoc = {
    async get() {
      if (configThrows) throw new Error('firestore down');
      return {
        exists: state.configData !== undefined,
        data: () => state.configData,
      };
    },
    async set(payload, opts) {
      state.lastSet = { payload, opts };
      // emulate merge
      state.configData = { ...(state.configData || {}), ...payload };
    },
  };

  const hashesCollection = {
    where(field, op, value) {
      return {
        async get() {
          if (hashesThrow) throw new Error('hash query failed');
          // The real query is expiresAt > value; emulate so our test data is
          // filtered the same way Firestore would filter it.
          const docs = hashDocs
            .filter(d => op === '>' ? d[field] > value : true)
            .map(d => ({ id: d.id, data: () => { const { id, ...rest } = d; return rest; } }));
          return { docs };
        },
      };
    },
    async add(data) {
      state.added.push(data);
      return { id: `hash_${state.added.length}` };
    },
    doc() {
      return { async set() {} };
    },
  };

  const fakeDb = {
    collection(name) {
      if (name === 'automod') {
        return { doc: () => configDoc };
      }
      if (name === 'scamHashes') {
        return hashesCollection;
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };

  _holder.db = fakeDb;
  return state;
}

function restoreFirestore() {
  _holder.db = null;
}

// Bust the module-level config cache between config tests by stubbing then
// calling updateScamScanConfig (which sets cachedConfig = null after a write).
async function bustConfigCache() {
  installFakeFirestore({ configData: {} });
  await updateScamScanConfig({}); // sets cachedConfig = null
  restoreFirestore();
}

// =====================================================================
// selectScannableAttachments — hard edge cases
// =====================================================================

test('selectScannableAttachments: empty array -> []', () => {
  assert.deepEqual(selectScannableAttachments([], { minDimension: 64, maxAttachments: 4 }), []);
});

test('selectScannableAttachments: null / undefined input -> []', () => {
  assert.deepEqual(selectScannableAttachments(null, { minDimension: 64, maxAttachments: 4 }), []);
  assert.deepEqual(selectScannableAttachments(undefined, { minDimension: 64, maxAttachments: 4 }), []);
});

test('selectScannableAttachments: missing width/height filtered out', () => {
  const atts = [
    { contentType: 'image/png', width: 200, url: 'noheight' },           // height undefined
    { contentType: 'image/png', height: 200, url: 'nowidth' },           // width undefined
    { contentType: 'image/png', width: 200, height: 200, url: 'ok' },
    { contentType: 'image/png', width: NaN, height: 200, url: 'nan' },   // NaN not finite
    { contentType: 'image/png', width: null, height: 200, url: 'nullw' },// null not finite
  ];
  const out = selectScannableAttachments(atts, { minDimension: 64, maxAttachments: 4 });
  assert.deepEqual(out.map(a => a.url), ['ok']);
});

test('selectScannableAttachments: width exactly == minDimension is accepted (>=)', () => {
  const atts = [
    { contentType: 'image/png', width: 64, height: 64, url: 'exact' },
    { contentType: 'image/png', width: 63, height: 64, url: 'under' },
  ];
  const out = selectScannableAttachments(atts, { minDimension: 64, maxAttachments: 4 });
  assert.deepEqual(out.map(a => a.url), ['exact']);
});

test('selectScannableAttachments: non-image content types rejected (incl. missing contentType)', () => {
  const atts = [
    { contentType: 'application/octet-stream', width: 200, height: 200, url: 'bin' },
    { contentType: 'video/mp4', width: 200, height: 200, url: 'vid' },
    { width: 200, height: 200, url: 'nocontenttype' },     // contentType undefined
    { contentType: null, width: 200, height: 200, url: 'nullct' },
    { contentType: 'image/png', width: 200, height: 200, url: 'good' },
  ];
  const out = selectScannableAttachments(atts, { minDimension: 64, maxAttachments: 4 });
  assert.deepEqual(out.map(a => a.url), ['good']);
});

test('selectScannableAttachments: null entries in the list are skipped', () => {
  const atts = [null, undefined, { contentType: 'image/png', width: 100, height: 100, url: 'a' }];
  const out = selectScannableAttachments(atts, { minDimension: 64, maxAttachments: 4 });
  assert.deepEqual(out.map(a => a.url), ['a']);
});

test('selectScannableAttachments: maxAttachments cap is exact (5 scannable, cap 4)', () => {
  const atts = Array.from({ length: 5 }, (_, i) => ({
    contentType: 'image/png', width: 100, height: 100, url: `u${i}`,
  }));
  const out = selectScannableAttachments(atts, { minDimension: 64, maxAttachments: 4 });
  assert.equal(out.length, 4);
  assert.deepEqual(out.map(a => a.url), ['u0', 'u1', 'u2', 'u3']);
});

test('selectScannableAttachments: maxAttachments 0 -> [] (slice(0,0))', () => {
  const atts = [{ contentType: 'image/png', width: 100, height: 100, url: 'a' }];
  const out = selectScannableAttachments(atts, { minDimension: 64, maxAttachments: 0 });
  assert.deepEqual(out, []);
});

test('selectScannableAttachments: filtering happens before the cap (cap counts only scannable)', () => {
  // Two non-images first; cap of 2 should still yield the two valid images,
  // proving the slice is applied to the filtered list, not the raw list.
  const atts = [
    { contentType: 'text/plain', width: 100, height: 100, url: 'bad1' },
    { contentType: 'text/plain', width: 100, height: 100, url: 'bad2' },
    { contentType: 'image/png', width: 100, height: 100, url: 'img1' },
    { contentType: 'image/png', width: 100, height: 100, url: 'img2' },
  ];
  const out = selectScannableAttachments(atts, { minDimension: 64, maxAttachments: 2 });
  assert.deepEqual(out.map(a => a.url), ['img1', 'img2']);
});

test('selectScannableAttachments: discord.js Collection preserves insertion order and cap', () => {
  const coll = new Map([
    ['1', { contentType: 'image/png', width: 100, height: 100, url: 'a' }],
    ['2', { contentType: 'image/png', width: 100, height: 100, url: 'b' }],
    ['3', { contentType: 'image/png', width: 100, height: 100, url: 'c' }],
  ]);
  const out = selectScannableAttachments(coll, { minDimension: 64, maxAttachments: 2 });
  assert.deepEqual(out.map(a => a.url), ['a', 'b']);
});

test('selectScannableAttachments: empty Collection -> []', () => {
  assert.deepEqual(selectScannableAttachments(new Map(), { minDimension: 64, maxAttachments: 4 }), []);
});

// =====================================================================
// matchKnownScam / hamming boundary
// =====================================================================

test('matchKnownScam: distance exactly == maxDistance matches (<=)', () => {
  const known = [{ id: 'h1', hash: '0000000000000000' }];
  // 0x...3 -> 2 differing bits. maxDistance 2 -> match.
  assert.equal(matchKnownScam('0000000000000003', known, 2).id, 'h1');
  // 3 bits with maxDistance 2 -> no match.
  assert.equal(matchKnownScam('0000000000000007', known, 2), null);
});

test('matchKnownScam: returns first match when several are within threshold', () => {
  const known = [
    { id: 'first', hash: '0000000000000001' }, // 1 bit from target
    { id: 'second', hash: '0000000000000000' }, // 0 bits from target
  ];
  assert.equal(matchKnownScam('0000000000000000', known, 5).id, 'first');
});

test('matchKnownScam: record with missing/invalid hash is skipped (Infinity distance)', () => {
  const known = [
    { id: 'bad', hash: undefined },
    { id: 'badlen', hash: 'ff' },
    { id: 'good', hash: '0000000000000000' },
  ];
  assert.equal(matchKnownScam('0000000000000000', known, 5).id, 'good');
});

test('matchKnownScam: null entries in known list are skipped', () => {
  const known = [null, { id: 'ok', hash: '0000000000000000' }];
  assert.equal(matchKnownScam('0000000000000000', known, 5).id, 'ok');
});

test('matchKnownScam: maxDistance 0 requires exact hash equality', () => {
  const known = [{ id: 'h1', hash: '0000000000000000' }];
  assert.equal(matchKnownScam('0000000000000000', known, 0).id, 'h1');
  assert.equal(matchKnownScam('0000000000000001', known, 0), null);
});

test('hammingDistance: max distance of 64 between all-zero and all-one', () => {
  assert.equal(hammingDistance('0'.repeat(16), 'f'.repeat(16)), 64);
});

test('isHashMatch: default hammingThreshold (10) — 10 bits matches, 11 does not', () => {
  // Build a hash differing from zero by N bits. Each '7' nibble = 3 bits.
  const tenBits = '0000000000000000'.split('');
  // set 10 bits: three '7' (9 bits) + one '1' (1 bit) = 10 bits
  tenBits[15] = '7'; tenBits[14] = '7'; tenBits[13] = '7'; tenBits[12] = '1';
  const ten = tenBits.join('');
  assert.equal(hammingDistance('0000000000000000', ten), 10);
  assert.equal(isHashMatch('0000000000000000', ten, 10), true);

  const elevenBits = '0000000000000000'.split('');
  elevenBits[15] = '7'; elevenBits[14] = '7'; elevenBits[13] = '7'; elevenBits[12] = '3'; // 9+2 = 11
  const eleven = elevenBits.join('');
  assert.equal(hammingDistance('0000000000000000', eleven), 11);
  assert.equal(isHashMatch('0000000000000000', eleven, 10), false);
});

// =====================================================================
// planAction — boundary / precedence
// =====================================================================

test('planAction: confidence just below threshold (0.7999...) -> none', () => {
  const p = planAction({ isScam: true, confidence: 0.8 - 1e-9 }, { threshold: 0.8 }, {});
  assert.equal(p.action, 'none');
});

test('planAction: NaN confidence never acts', () => {
  const p = planAction({ isScam: true, confidence: NaN }, { threshold: 0.8 }, {});
  assert.equal(p.action, 'none');
});

test('planAction: known-scam match overrides a non-scam verdict', () => {
  const p = planAction(
    { isScam: false, confidence: 0 },
    { threshold: 0.8 },
    { matchedKnownScam: { id: 'h1' } },
  );
  assert.deepEqual(p, { action: 'scam', delete: true, mute: true, recordHash: false, alert: true });
});

test('planAction: null verdict with no known match -> none (no throw)', () => {
  const p = planAction(null, { threshold: 0.8 }, {});
  assert.deepEqual(p, { action: 'none', delete: false, mute: false, recordHash: false, alert: false });
});

test('planAction: threshold 0 with confidence 0 and isScam true still acts (0 >= 0)', () => {
  const p = planAction({ isScam: true, confidence: 0 }, { threshold: 0 }, {});
  assert.equal(p.action, 'scam');
});

// =====================================================================
// isNewMember — boundary / off-by-one
// =====================================================================

test('isNewMember: exactly at the window boundary is NOT new (strict <)', () => {
  const now = 1_000_000_000;
  // now - joined === windowMs -> not < windowMs -> false
  assert.equal(isNewMember({ joinedTimestamp: now - 3 * DAY }, now, 3 * DAY), false);
  // one ms inside -> true
  assert.equal(isNewMember({ joinedTimestamp: now - 3 * DAY + 1 }, now, 3 * DAY), true);
});

test('isNewMember: joinedTimestamp of 0 is treated as falsy -> not new', () => {
  // joinedTimestamp === 0 is falsy, so the guard returns false even though
  // mathematically now-0 could be inside the window. Documented behavior.
  assert.equal(isNewMember({ joinedTimestamp: 0 }, 1000, 3 * DAY), false);
});

test('isNewMember: future joinedTimestamp (clock skew) -> new (negative diff < window)', () => {
  const now = 1_000_000_000;
  assert.equal(isNewMember({ joinedTimestamp: now + DAY }, now, 3 * DAY), true);
});

// =====================================================================
// isExemptRole — hard cases
// =====================================================================

test('isExemptRole: empty exempt list -> false', () => {
  const member = { roles: { cache: new Map([['r1', {}]]) } };
  assert.equal(isExemptRole(member, []), false);
});

test('isExemptRole: default param (no list given) -> false, no throw', () => {
  const member = { roles: { cache: new Map([['r1', {}]]) } };
  assert.equal(isExemptRole(member), false);
});

test('isExemptRole: member without roles.cache -> false', () => {
  assert.equal(isExemptRole({ roles: {} }, ['r1']), false);
  assert.equal(isExemptRole({}, ['r1']), false);
  assert.equal(isExemptRole(null, ['r1']), false);
});

// =====================================================================
// phash dhashFromGrayscale — boundary
// =====================================================================

test('dhashFromGrayscale: exactly 72 pixels works (boundary length)', () => {
  const px = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) px.push(c);
  assert.equal(px.length, 72);
  assert.equal(dhashFromGrayscale(px), '0000000000000000');
});

test('dhashFromGrayscale: extra pixels beyond 72 are ignored', () => {
  const px = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) px.push(c);
  for (let i = 0; i < 50; i++) px.push(255); // trailing junk
  assert.equal(dhashFromGrayscale(px), '0000000000000000');
});

test('dhashFromGrayscale: exactly 71 pixels throws (off-by-one under length)', () => {
  const px = new Array(71).fill(0);
  assert.throws(() => dhashFromGrayscale(px));
});

test('dhashFromGrayscale: equal neighbours produce 0 bits (left > right is strict)', () => {
  const px = new Array(72).fill(128); // all equal -> no "left > right" -> all zero
  assert.equal(dhashFromGrayscale(px), '0000000000000000');
});

test('dhashFromGrayscale: non-array input throws', () => {
  assert.throws(() => dhashFromGrayscale('not an array'));
  assert.throws(() => dhashFromGrayscale(null));
});

test('hammingDistance: empty strings -> Infinity (HEX_RE requires >=1 char)', () => {
  // Same length and both strings, but /^[0-9a-f]+$/ needs >=1 char, so '' fails
  // the regex and is treated as "no match" (Infinity) rather than distance 0.
  assert.equal(hammingDistance('', ''), Infinity);
});

// =====================================================================
// parseVerdict — hard cases the existing suite skips
// =====================================================================

test('parseVerdict: non-string (object) -> safe fail', () => {
  const v = parseVerdict({ isScam: true });
  assert.equal(v.parseFailed, true);
  assert.equal(v.isScam, false);
});

test('parseVerdict: JSON array -> fail (must be object, not array)', () => {
  const v = parseVerdict('[{"isScam":true}]');
  assert.equal(v.parseFailed, true);
  assert.equal(v.isScam, false);
});

test('parseVerdict: confidence as numeric string is coerced via Number()', () => {
  const v = parseVerdict('{"isScam":true,"confidence":"0.9","category":"x","reason":"y"}');
  assert.equal(v.confidence, 0.9);
  assert.equal(v.isScam, true);
});

test('parseVerdict: isScam truthy-but-not-true ("true" string) -> isScam false', () => {
  const v = parseVerdict('{"isScam":"true","confidence":0.99,"category":"x","reason":"y"}');
  assert.equal(v.isScam, false); // strict === true required
});

test('parseVerdict: missing category/reason default to unknown/empty', () => {
  const v = parseVerdict('{"isScam":true,"confidence":0.9}');
  assert.equal(v.category, 'unknown');
  assert.equal(v.reason, '');
});

test('parseVerdict: whitespace-only category/reason fall back to defaults', () => {
  const v = parseVerdict('{"isScam":true,"confidence":0.9,"category":"   ","reason":"  "}');
  assert.equal(v.category, 'unknown');
  assert.equal(v.reason, '');
});

// =====================================================================
// getScamScanConfig / updateScamScanConfig — merge, partial, unknown keys
// =====================================================================

test('getScamScanConfig: no config doc -> returns defaults (a copy)', async () => {
  await bustConfigCache();
  installFakeFirestore({ configData: undefined }); // doc.exists === false
  try {
    const cfg = await getScamScanConfig();
    assert.equal(cfg.scamScanEnabled, false);
    assert.equal(cfg.threshold, 0.8);
    assert.notEqual(cfg, DEFAULT_CONFIG); // must be a copy, not the shared object
  } finally {
    restoreFirestore();
  }
});

test('getScamScanConfig: partial override merges over defaults', async () => {
  await bustConfigCache();
  installFakeFirestore({ configData: { scamScanEnabled: true, threshold: 0.95 } });
  try {
    const cfg = await getScamScanConfig();
    assert.equal(cfg.scamScanEnabled, true);
    assert.equal(cfg.threshold, 0.95);
    assert.equal(cfg.muteMs, DEFAULT_CONFIG.muteMs); // untouched default preserved
    assert.deepEqual(cfg.monitorChannelIds, []);
  } finally {
    restoreFirestore();
  }
});

test('getScamScanConfig: unknown keys from Firestore are preserved (no schema filtering)', async () => {
  await bustConfigCache();
  installFakeFirestore({ configData: { somethingNew: 'hello' } });
  try {
    const cfg = await getScamScanConfig();
    assert.equal(cfg.somethingNew, 'hello');
  } finally {
    restoreFirestore();
  }
});

test('getScamScanConfig: stored value is NOT numerically coerced (string threshold stays string)', async () => {
  // getScamScanConfig does a plain spread with no coercion. A string threshold
  // remains a string — documenting actual behavior (the /config command is
  // expected to coerce before writing).
  await bustConfigCache();
  installFakeFirestore({ configData: { threshold: '0.9' } });
  try {
    const cfg = await getScamScanConfig();
    assert.equal(cfg.threshold, '0.9');
    assert.equal(typeof cfg.threshold, 'string');
  } finally {
    restoreFirestore();
  }
});

test('getScamScanConfig: Firestore error -> defaults (fail-safe)', async () => {
  await bustConfigCache();
  installFakeFirestore({ configThrows: true });
  try {
    const cfg = await getScamScanConfig();
    assert.equal(cfg.scamScanEnabled, false);
    assert.equal(cfg.threshold, 0.8);
  } finally {
    restoreFirestore();
  }
});

test('getScamScanConfig: caches within TTL (second read does not hit Firestore)', async () => {
  await bustConfigCache();
  const state = installFakeFirestore({ configData: { threshold: 0.5 } });
  try {
    const a = await getScamScanConfig();
    assert.equal(a.threshold, 0.5);
    // mutate underlying store; cached value should NOT change within TTL
    state.configData = { threshold: 0.99 };
    const b = await getScamScanConfig();
    assert.equal(b.threshold, 0.5); // served from cache
    assert.equal(a, b); // same cached object reference
  } finally {
    restoreFirestore();
  }
});

test('updateScamScanConfig: writes with merge:true and busts the cache', async () => {
  await bustConfigCache();
  // Seed cache with one value.
  let state = installFakeFirestore({ configData: { threshold: 0.5 } });
  try {
    const first = await getScamScanConfig();
    assert.equal(first.threshold, 0.5);

    // Now update — should set merge:true and clear the cache.
    state = installFakeFirestore({ configData: { threshold: 0.5 } });
    await updateScamScanConfig({ threshold: 0.9 });
    assert.equal(state.lastSet.opts.merge, true);
    assert.deepEqual(state.lastSet.payload, { threshold: 0.9 });

    // Next read must reflect the new (merged) value, not the stale cache.
    const after = await getScamScanConfig();
    assert.equal(after.threshold, 0.9);
  } finally {
    restoreFirestore();
  }
});

// =====================================================================
// getKnownScamHashes / recordScamHash — TTL pruning + record shape
// =====================================================================

test('getKnownScamHashes: only returns records with expiresAt > now (TTL prune)', async () => {
  const now = 1_000_000;
  installFakeFirestore({
    hashDocs: [
      { id: 'live', hash: 'aaaa', expiresAt: now + 1 },
      { id: 'expired', hash: 'bbbb', expiresAt: now - 1 },
      { id: 'boundary', hash: 'cccc', expiresAt: now }, // not > now -> excluded
    ],
  });
  try {
    const out = await getKnownScamHashes(now);
    assert.deepEqual(out.map(r => r.id), ['live']);
    assert.equal(out[0].hash, 'aaaa');
  } finally {
    restoreFirestore();
  }
});

test('getKnownScamHashes: query failure -> [] (fail-safe, no throw)', async () => {
  installFakeFirestore({ hashesThrow: true });
  try {
    const out = await getKnownScamHashes(Date.now());
    assert.deepEqual(out, []);
  } finally {
    restoreFirestore();
  }
});

test('getKnownScamHashes: empty store -> []', async () => {
  installFakeFirestore({ hashDocs: [] });
  try {
    assert.deepEqual(await getKnownScamHashes(Date.now()), []);
  } finally {
    restoreFirestore();
  }
});

test('recordScamHash: defaults applied for missing category/reason/confidence/channel', async () => {
  const state = installFakeFirestore({});
  try {
    await recordScamHash({ hash: 'deadbeef', expiresAt: 999 });
    assert.equal(state.added.length, 1);
    const rec = state.added[0];
    assert.equal(rec.hash, 'deadbeef');
    assert.equal(rec.category, 'unknown');
    assert.equal(rec.reason, '');
    assert.equal(rec.confidence, null);
    assert.deepEqual(rec.seenChannels, []);
    assert.equal(rec.firstUserId, null);
    assert.equal(rec.expiresAt, 999);
  } finally {
    restoreFirestore();
  }
});

test('recordScamHash: confidence 0 is preserved (typeof number, not coerced to null)', async () => {
  const state = installFakeFirestore({});
  try {
    await recordScamHash({ hash: 'h', confidence: 0, channelId: 'c1', userId: 'u1', expiresAt: 1 });
    const rec = state.added[0];
    assert.equal(rec.confidence, 0); // 0 is a valid number, must NOT become null
    assert.deepEqual(rec.seenChannels, ['c1']);
    assert.equal(rec.firstUserId, 'u1');
  } finally {
    restoreFirestore();
  }
});
