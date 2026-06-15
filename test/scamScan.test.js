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

test('selectScannableAttachments: accepts a discord.js-style Collection (.values())', () => {
  // Production passes message.attachments, a Collection (Map-like) — not an array.
  const coll = new Map([
    ['1', { contentType: 'image/png', width: 200, height: 200, url: 'a' }],
    ['2', { contentType: 'text/plain', width: 200, height: 200, url: 'b' }],
  ]);
  const out = selectScannableAttachments(coll, { minDimension: 64, maxAttachments: 4 });
  assert.deepEqual(out.map(a => a.url), ['a']);
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
