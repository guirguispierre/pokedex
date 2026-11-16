const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PAGE_SIZE, readLastXPAt, computeFloor, replayAwards, planUserReplay,
  buildLevelUpdate, scanGuildMessages, parseSince, runReindex,
} = require('../src/services/xpReindex');

const COOLDOWN = 60_000;
const CFG = { cooldownMs: COOLDOWN, minGain: 15, maxGain: 25, rng: () => 0 };
const CUT = 1_700_000_000_000; // bot process start
const A0 = CUT - 3 * 3600_000; // last award before the outage
const H = 3600_000;
const S = 1000;

// Fake Firestore: collection/doc/where/get, getAll, runTransaction with merge.
function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const snapFor = (id) => ({
    exists: store.has(id),
    data: () => (store.has(id) ? { ...store.get(id) } : undefined),
  });
  return {
    store,
    collection() {
      return {
        doc: (id) => ({ id }),
        where: (field, _op, value) => ({
          get: async () => ({
            docs: [...store.entries()]
              .filter(([, d]) => d[field] === value)
              .map(([id, d]) => ({ id, data: () => ({ ...d }) })),
          }),
        }),
      };
    },
    async getAll(...refs) { return refs.map(r => snapFor(r.id)); },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: async (r) => snapFor(r.id),
        set: (r, data, opts) => writes.push({ id: r.id, data, opts }),
      };
      const out = await fn(tx);
      for (const w of writes) {
        const prev = store.get(w.id);
        if (w.opts?.merge && prev) {
          const merged = { ...prev, ...w.data };
          if (w.data.xpByDay) merged.xpByDay = { ...(prev.xpByDay || {}), ...w.data.xpByDay };
          store.set(w.id, merged);
        } else {
          store.set(w.id, { ...w.data });
        }
      }
      return out;
    },
  };
}

// One channel, messages given newest first, paginated like discord.js.
function makeSource(id, messages) {
  return {
    id,
    fetchPage: async (before) => {
      let start = 0;
      if (before) {
        const idx = messages.findIndex(m => m.id === before);
        start = idx === -1 ? messages.length : idx + 1;
      }
      return messages.slice(start, start + PAGE_SIZE);
    },
  };
}
const msg = (id, ts, authorId, authorName = authorId, authorIsBot = false) => ({
  id, createdTimestamp: ts, authorId, authorIsBot, authorName,
});

describe('readLastXPAt / computeFloor', () => {
  test('prefers lastXPAt, falls back to updatedAt for legacy docs', () => {
    assert.equal(readLastXPAt({ lastXPAt: 5 }), 5);
    assert.equal(readLastXPAt({ updatedAt: { toMillis: () => 7 } }), 7);
    assert.equal(readLastXPAt({}), null);
    assert.equal(readLastXPAt(null), null);
  });

  test('floor is the newest award before the cutoff, ignoring post-boot awards', () => {
    const docs = [
      { lastXPAt: A0 },
      { lastXPAt: CUT - H },
      { lastXPAt: CUT + 5 * S }, // awarded live after boot
    ];
    assert.equal(computeFloor(docs, CUT), CUT - H);
  });

  test('floor is null when there is no pre-boot award', () => {
    assert.equal(computeFloor([{ lastXPAt: CUT + 1 }], CUT), null);
  });
});

describe('replayAwards', () => {
  test('applies the live 60s cooldown from the anchor', () => {
    const t = [0, 30 * S, 61 * S, 100 * S, 130 * S, 200 * S];
    const { awards, lastAwardMs } = replayAwards({
      anchorMs: null, timestamps: t, cooldownMs: COOLDOWN, minGain: 15, maxGain: 25, rng: () => 0,
    });
    assert.deepEqual(awards.map(a => a.ts), [0, 61 * S, 130 * S, 200 * S]);
    assert.equal(lastAwardMs, 200 * S);
  });

  test('gain stays within the live range', () => {
    const lo = replayAwards({ anchorMs: null, timestamps: [0], cooldownMs: COOLDOWN, minGain: 15, maxGain: 25, rng: () => 0 });
    const hi = replayAwards({ anchorMs: null, timestamps: [0], cooldownMs: COOLDOWN, minGain: 15, maxGain: 25, rng: () => 0.999999 });
    assert.equal(lo.awards[0].gain, 15);
    assert.equal(hi.awards[0].gain, 25);
  });

  test('no messages means no awards and no last award', () => {
    const r = replayAwards({ anchorMs: A0, timestamps: [], cooldownMs: COOLDOWN, minGain: 15, maxGain: 25 });
    assert.deepEqual(r.awards, []);
    assert.equal(r.lastAwardMs, null);
  });
});

describe('planUserReplay', () => {
  test('exact anchor: window starts after the last award, cooldown from it', () => {
    const doc = { lastXPAt: A0, xp: 500 };
    const timestamps = [A0 - H, A0 + 30 * S, A0 + 120 * S, A0 + 150 * S, CUT - H, CUT + S];
    const plan = planUserReplay({ doc, cutoffMs: CUT, scanFromMs: A0 - 4 * H, floorMs: A0, timestamps, ...CFG });
    assert.equal(plan.exact, true);
    assert.deepEqual(plan.awards.map(a => a.ts), [A0 + 120 * S, CUT - H]);
  });

  test('post-boot award: falls back to the floor and never counts post-boot messages', () => {
    const doc = { lastXPAt: CUT + 5 * S, xp: 300 };
    const timestamps = [CUT - 30 * 60_000, CUT + 8 * S];
    const plan = planUserReplay({ doc, cutoffMs: CUT, scanFromMs: A0, floorMs: A0, timestamps, ...CFG });
    assert.equal(plan.exact, false);
    assert.deepEqual(plan.awards.map(a => a.ts), [CUT - 30 * 60_000]);
  });

  test('no doc: uses the floor as the baseline', () => {
    const timestamps = [CUT - 2 * H, CUT - 2 * H + 10 * S, CUT - H];
    const plan = planUserReplay({ doc: null, cutoffMs: CUT, scanFromMs: A0, floorMs: A0, timestamps, ...CFG });
    assert.deepEqual(plan.awards.map(a => a.ts), [CUT - 2 * H, CUT - H]);
  });
});

describe('buildLevelUpdate', () => {
  test('returns null when there is nothing to award', () => {
    const plan = { exact: true, awards: [], lastAwardMs: null };
    assert.equal(buildLevelUpdate({ plan, doc: { xp: 1 }, userId: 'u', guildId: 'g' }), null);
  });

  test('exact plans rewrite xpByDay with running totals; approximate plans do not', () => {
    const awards = [{ ts: CUT - 2 * H, gain: 20 }, { ts: CUT - H, gain: 10 }];
    const exact = buildLevelUpdate({
      plan: { exact: true, xpIsAtAnchor: true, awards, lastAwardMs: CUT - H },
      doc: { xp: 100, messages: 4 }, userId: 'u', guildId: 'g',
    });
    assert.equal(exact.xp, 130);
    assert.equal(exact.messages, 6);
    assert.equal(exact.lastXPAt, CUT - H);
    assert.ok(exact.xpByDay);
    const approx = buildLevelUpdate({
      plan: { exact: false, xpIsAtAnchor: false, awards, lastAwardMs: CUT - H },
      doc: { xp: 100 }, userId: 'u', guildId: 'g',
    });
    assert.equal(approx.xp, 130);
    assert.equal(approx.xpByDay, undefined);
  });
});

describe('parseSince', () => {
  test('accepts hours, days, and dates; rejects junk', () => {
    assert.equal(parseSince('36h', CUT), CUT - 36 * H);
    assert.equal(parseSince('2d', CUT), CUT - 48 * H);
    assert.equal(parseSince('2026-11-14T18:00:00Z', CUT), Date.parse('2026-11-14T18:00:00Z'));
    assert.equal(parseSince('last tuesday-ish', CUT), null);
  });
});

describe('scanGuildMessages', () => {
  test('keeps only non-bot messages inside [since, cutoff)', async () => {
    const source = makeSource('general', [
      msg('5', CUT + S, 'late'),           // after cutoff
      msg('4', CUT - S, 'bot', 'bot', true), // bot
      msg('3', CUT - 2 * S, 'alice'),
      msg('2', A0 + S, 'bob'),
      msg('1', A0 - H, 'old'),             // before since
    ]);
    const { byUser, stats } = await scanGuildMessages({
      sources: [source], sinceMs: A0, cutoffMs: CUT, deadlineMs: Infinity,
    });
    assert.deepEqual([...byUser.keys()].sort(), ['alice', 'bob']);
    assert.equal(stats.messagesInWindow, 2);
    assert.equal(stats.scannedSources, 1);
  });

  test('paginates past PAGE_SIZE', async () => {
    const msgs = Array.from({ length: 250 }, (_, i) => msg(String(1000 - i), CUT - (i + 1) * S, 'alice'));
    const { byUser, stats } = await scanGuildMessages({
      sources: [makeSource('c', msgs)], sinceMs: CUT - 10_000 * S, cutoffMs: CUT, deadlineMs: Infinity,
    });
    assert.equal(byUser.get('alice').timestamps.length, 250);
    assert.equal(stats.messagesInWindow, 250);
  });

  test('a source that throws is skipped, not fatal', async () => {
    const broken = { id: 'x', fetchPage: async () => { throw new Error('Missing Access'); } };
    const ok = makeSource('ok', [msg('1', CUT - S, 'alice')]);
    const { stats } = await scanGuildMessages({
      sources: [broken, ok], sinceMs: A0, cutoffMs: CUT, deadlineMs: Infinity,
    });
    assert.equal(stats.skippedSources, 1);
    assert.equal(stats.scannedSources, 1);
  });

  test('stops with aborted when the deadline passes', async () => {
    const { stats } = await scanGuildMessages({
      sources: [makeSource('ok', [])], sinceMs: A0, cutoffMs: CUT, deadlineMs: 0, now: () => 1,
    });
    assert.equal(stats.aborted, true);
  });
});

// Shared scenario: three users plus a bot, around one outage.
function scenario() {
  const seed = {
    'g_alice': { userId: 'alice', guildId: 'g', xp: 500, messages: 10, lastXPAt: A0, xpByDay: {} },
    'g_carol': { userId: 'carol', guildId: 'g', xp: 300, messages: 5, lastXPAt: CUT + 5 * S },
  };
  const source = makeSource('general', [
    msg('m9', CUT - 30 * 60_000, 'carol', 'carol'),   // carol, downtime, after her post-boot award's floor
    msg('m8', CUT + 8 * S, 'carol', 'carol'),          // post-boot: live path owns it
    msg('m8a', CUT + 5 * S, 'carol', 'carol'),         // the post-boot message live already paid (lastXPAt)
    msg('m7', CUT - H, 'alice', 'alice'),
    msg('m6', CUT - H + 0, 'bob', 'bob'),              // (same ms as alice; order by id only)
    msg('m5', CUT - 2 * H + 10 * S, 'bob', 'bob'),
    msg('m4', CUT - 2 * H, 'bob', 'bob'),
    msg('m3', A0 + 150 * S, 'alice', 'alice'),
    msg('m2', A0 + 120 * S, 'alice', 'alice'),
    msg('m1', A0 + 30 * S, 'alice', 'alice'),
    msg('m0', A0 - H, 'alice', 'alice'),               // before the anchor
    msg('mb', CUT - H, 'dave', 'dave', true),          // bot
  ]);
  return { db: fakeDb(seed), sources: [source] };
}

describe('runReindex', () => {
  test('dry run reports the work and writes nothing', async () => {
    const { db, sources } = scenario();
    const before = JSON.stringify([...db.store.entries()]);
    const r = await runReindex({
      db, guildId: 'g', sources, sinceMs: null, cutoffMs: CUT, dryRun: true,
      deadlineMs: Infinity, ...CFG,
    });
    assert.equal(r.error, null);
    assert.equal(r.dryRun, true);
    assert.equal(r.floorMs, A0);
    // alice: 2 awards (A0+120s, CUT-1h); bob (no doc): 2 (CUT-2h, CUT-1h); carol: 1 (CUT-30m)
    assert.equal(r.awardsGranted, 5);
    assert.equal(r.xpGranted, 5 * 15);
    assert.equal(r.usersWithWork, 3);
    assert.equal(JSON.stringify([...db.store.entries()]), before);
  });

  test('apply writes the replayed XP and anchors', async () => {
    const { db, sources } = scenario();
    const r = await runReindex({
      db, guildId: 'g', sources, sinceMs: null, cutoffMs: CUT, dryRun: false,
      deadlineMs: Infinity, ...CFG,
    });
    assert.equal(r.applied, true);
    assert.equal(r.awardsGranted, 5);
    assert.equal(db.store.get('g_alice').xp, 530);
    assert.equal(db.store.get('g_alice').messages, 12);
    assert.equal(db.store.get('g_alice').lastXPAt, CUT - H);
    assert.equal(db.store.get('g_bob').xp, 30);
    assert.equal(db.store.get('g_carol').xp, 315);
    // Post-boot live award stays the anchor; it must never move backwards.
    assert.equal(db.store.get('g_carol').lastXPAt, CUT + 5 * S);
    assert.equal(db.store.get('g_carol').lastReplayedXPAt, CUT - 30 * 60_000);
    assert.equal(db.store.get('g_carol').xpByDay, undefined);
  });

  test('running it again awards nothing (no double count)', async () => {
    const { db, sources } = scenario();
    const cfg = { db, guildId: 'g', sources, sinceMs: null, cutoffMs: CUT, dryRun: false, deadlineMs: Infinity, ...CFG };
    await runReindex(cfg);
    const after1 = JSON.stringify([...db.store.entries()]);
    const second = await runReindex(cfg);
    assert.equal(second.awardsGranted, 0);
    assert.equal(second.usersWithWork, 0);
    assert.equal(JSON.stringify([...db.store.entries()]), after1);
  });

  test('a dry run followed by apply gives the same totals', async () => {
    const { db, sources } = scenario();
    const base = { db, guildId: 'g', sources, sinceMs: null, cutoffMs: CUT, deadlineMs: Infinity, ...CFG };
    const dry = await runReindex({ ...base, dryRun: true });
    const applied = await runReindex({ ...base, dryRun: false });
    assert.equal(dry.awardsGranted, applied.awardsGranted);
    assert.equal(dry.xpGranted, applied.xpGranted);
  });

  test('no baseline and no since: refuses instead of scanning all history', async () => {
    const db = fakeDb({});
    const r = await runReindex({
      db, guildId: 'g', sources: [], sinceMs: null, cutoffMs: CUT, dryRun: true, deadlineMs: Infinity, ...CFG,
    });
    assert.equal(r.error, 'no-baseline');
  });

  test('scan timeout returns an error and writes nothing', async () => {
    const { db, sources } = scenario();
    const r = await runReindex({
      db, guildId: 'g', sources, sinceMs: null, cutoffMs: CUT, dryRun: false,
      deadlineMs: 0, now: () => 1, ...CFG,
    });
    assert.equal(r.error, 'scan-timeout');
    assert.equal(db.store.get('g_alice').xp, 500);
  });

  test('after a second restart, messages the live path already paid for are not re-awarded', async () => {
    const { db, sources } = scenario();
    await runReindex({ db, guildId: 'g', sources, sinceMs: null, cutoffMs: CUT, dryRun: false, deadlineMs: Infinity, ...CFG });
    // Live already paid carol at CUT+5s (m8a). Bot restarts before she chats again.
    const xpBefore = db.store.get('g_carol').xp;
    const r = await runReindex({ db, guildId: 'g', sources, sinceMs: null, cutoffMs: CUT + H, dryRun: false, deadlineMs: Infinity, ...CFG });
    assert.equal(r.awardsGranted, 0);
    assert.equal(db.store.get('g_carol').xp, xpBefore);
  });

  test('getSources receives the scan start', async () => {
    const { db, sources } = scenario();
    let seen;
    const r = await runReindex({
      db, guildId: 'g', getSources: async (from) => { seen = from; return sources; },
      sinceMs: null, cutoffMs: CUT, dryRun: true, deadlineMs: Infinity, ...CFG,
    });
    assert.equal(seen, A0);
    assert.equal(r.awardsGranted, 5);
  });
});

describe('scan deadline inside one source', () => {
  test('a single large channel aborts mid-paging', async () => {
    const msgs = Array.from({ length: 250 }, (_, i) => msg(String(1000 - i), CUT - (i + 1) * S, 'alice'));
    let t = 0;
    const { stats } = await scanGuildMessages({
      sources: [makeSource('c', msgs)], sinceMs: 0, cutoffMs: CUT, deadlineMs: 1, now: () => t++,
    });
    assert.equal(stats.aborted, true);
    assert.equal(stats.scannedSources, 0);
  });
});

