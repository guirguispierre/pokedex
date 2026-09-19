// Tests for the XP-history helpers and the xpByDay recording in awardXP.
// Firestore is stubbed with the same in-memory fake used by graveyard.test.js —
// no network / real Firebase involved.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');

const { dayKey, listDayKeys, addXpToDay, buildXpHistory } = require('../src/services/xpHistory');
const level = require('../src/commands/level');

const realFirestore = admin.firestore;

function restoreFirestore() {
  delete admin.firestore;
}

// Minimal in-memory fake: doc get/set(merge) + collection().doc().
function installFakeFirestore(seed = {}) {
  const store = new Map(Object.entries(seed));

  function makeDocRef(collectionName, docId) {
    const path = `${collectionName}/${docId}`;
    return {
      async get() {
        const data = store.get(path);
        return { exists: data !== undefined, data: () => data };
      },
      async set(payload, opts) {
        const prev = (opts && opts.merge && store.get(path)) || {};
        store.set(path, { ...prev, ...payload });
      },
    };
  }

  const fakeDb = { collection: (name) => ({ doc: (id) => makeDocRef(name, id) }) };
  const fn = () => fakeDb;
  Object.assign(fn, realFirestore);
  fn.FieldValue = {
    increment: (n) => ({ __increment: n }),
    serverTimestamp: () => 'server-ts',
  };
  Object.defineProperty(admin, 'firestore', {
    value: fn, writable: true, configurable: true, enumerable: true,
  });
  return store;
}

describe('dayKey', () => {
  test('formats a UTC YYYY-MM-DD key', () => {
    assert.equal(dayKey(new Date('2026-09-19T15:30:00Z')), '2026-09-19');
    // Late-evening UTC still maps to the same UTC day
    assert.equal(dayKey(new Date('2026-01-05T23:59:59Z')), '2026-01-05');
  });
});

describe('listDayKeys', () => {
  test('returns N oldest-first UTC keys ending at endDate', () => {
    const keys = listDayKeys(3, new Date('2026-09-19T12:00:00Z'));
    assert.deepEqual(keys, ['2026-09-17', '2026-09-18', '2026-09-19']);
  });

  test('crosses month boundaries', () => {
    const keys = listDayKeys(3, new Date('2026-03-01T00:00:00Z'));
    assert.deepEqual(keys, ['2026-02-27', '2026-02-28', '2026-03-01']);
  });
});

describe('addXpToDay', () => {
  test('adds gain to an existing day and preserves other days', () => {
    const out = addXpToDay({ '2026-09-18': 20 }, '2026-09-19', 15);
    assert.deepEqual(out, { '2026-09-18': 20, '2026-09-19': 15 });
    assert.equal(addXpToDay(out, '2026-09-19', 10)['2026-09-19'], 25);
  });

  test('handles a missing/empty map', () => {
    assert.deepEqual(addXpToDay(undefined, '2026-09-19', 15), { '2026-09-19': 15 });
    assert.deepEqual(addXpToDay(null, '2026-09-19', 15), { '2026-09-19': 15 });
  });
});

describe('buildXpHistory', () => {
  const end = new Date('2026-09-19T12:00:00Z');

  test('zero-fills days with no XP and aggregates totals across members', () => {
    const docs = [
      { userId: 'u1', username: 'alice', xp: 100, xpByDay: { '2026-09-18': 40, '2026-09-19': 60 } },
      { userId: 'u2', username: 'bob', xp: 50, xpByDay: { '2026-09-19': 50 } },
    ];
    const out = buildXpHistory(docs, { days: 3, endDate: end });
    assert.deepEqual(out.days, ['2026-09-17', '2026-09-18', '2026-09-19']);
    assert.deepEqual(out.totals, [0, 40, 110]);
    assert.equal(out.users.length, 2);
    assert.deepEqual(out.users[0].daily, [0, 40, 60]);
  });

  test('orders users by total XP desc and respects topUsers', () => {
    const docs = [
      { userId: 'u1', username: 'alice', xp: 10, xpByDay: {} },
      { userId: 'u2', username: 'bob', xp: 90, xpByDay: {} },
      { userId: 'u3', username: 'eve', xp: 50, xpByDay: {} },
    ];
    const out = buildXpHistory(docs, { days: 7, endDate: end, topUsers: 2 });
    assert.deepEqual(out.users.map(u => u.userId), ['u2', 'u3']);
  });

  test('totals include members outside the topUsers cut', () => {
    const docs = [
      { userId: 'u1', username: 'alice', xp: 90, xpByDay: { '2026-09-19': 10 } },
      { userId: 'u2', username: 'bob', xp: 10, xpByDay: { '2026-09-19': 5 } },
    ];
    const out = buildXpHistory(docs, { days: 1, endDate: end, topUsers: 1 });
    assert.equal(out.users.length, 1);
    assert.deepEqual(out.totals, [15]);
  });

  test('docs without xpByDay contribute zeros', () => {
    const docs = [{ userId: 'u1', username: 'alice', xp: 100 }];
    const out = buildXpHistory(docs, { days: 2, endDate: end });
    assert.deepEqual(out.totals, [0, 0]);
    assert.deepEqual(out.users[0].daily, [0, 0]);
  });

  test('empty input yields zeroed series and no users', () => {
    const out = buildXpHistory([], { days: 3, endDate: end });
    assert.deepEqual(out.totals, [0, 0, 0]);
    assert.deepEqual(out.users, []);
  });
});

describe('awardXP xpByDay recording', () => {
  afterEach(restoreFirestore);

  test('records the XP gain under today\'s UTC day key', async () => {
    const store = installFakeFirestore();
    const message = { guild: { id: 'g1' }, author: { id: 'u1', username: 'alice', bot: false } };

    await level.awardXP(message);

    const data = store.get('levels/g1_u1');
    const today = dayKey(new Date());
    assert.ok(data.xpByDay);
    assert.equal(data.xpByDay[today], data.xp);
    assert.ok(data.xp >= 15 && data.xp <= 25);
  });

  test('adds to an existing day bucket without wiping history', async () => {
    const store = installFakeFirestore({
      'levels/g1_u2': {
        userId: 'u2', guildId: 'g1', xp: 40, messages: 2,
        xpByDay: { '2026-01-01': 40 },
      },
    });
    const message = { guild: { id: 'g1' }, author: { id: 'u2', username: 'bob', bot: false } };

    await level.awardXP(message);

    const data = store.get('levels/g1_u2');
    const today = dayKey(new Date());
    assert.equal(data.xpByDay['2026-01-01'], 40);
    const gained = data.xp - 40;
    assert.equal(data.xpByDay[today], gained);
  });
});
