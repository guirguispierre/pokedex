const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

// ---------------------------------------------------------------------------
// Mock firebase-admin BEFORE requiring the lockdown service. The service calls
// admin.firestore() at call-time (not module-load time), and references
// admin.firestore.FieldValue.{arrayUnion,arrayRemove,serverTimestamp}. We build
// a fake that approximates real Firestore array-sentinel semantics so we can
// test the record/state-machine helpers without touching a real backend.
// ---------------------------------------------------------------------------

// Sentinel markers produced by the fake FieldValue.* helpers.
const UNION = Symbol('arrayUnion');
const REMOVE = Symbol('arrayRemove');
const SERVER_TS = Symbol('serverTimestamp');

function makeSentinel(kind, elements) {
  return { __sentinel: kind, elements };
}

// Deep-equality the way Firestore compares array elements for arrayUnion/arrayRemove.
function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

// Apply a merge payload to an existing stored doc, resolving array sentinels the
// way real Firestore does (union = append if not already present by deep-equality;
// remove = drop deep-equal matches).
function applyMerge(existing, data) {
  const out = { ...(existing || {}) };
  for (const [key, val] of Object.entries(data)) {
    if (val === SERVER_TS) {
      out[key] = { __serverTimestamp: true };
    } else if (val && val.__sentinel === UNION) {
      const cur = Array.isArray(out[key]) ? out[key].slice() : [];
      for (const el of val.elements) {
        if (!cur.some(e => deepEqual(e, el))) cur.push(el);
      }
      out[key] = cur;
    } else if (val && val.__sentinel === REMOVE) {
      const cur = Array.isArray(out[key]) ? out[key].slice() : [];
      out[key] = cur.filter(e => !val.elements.some(rm => deepEqual(e, rm)));
    } else {
      out[key] = val;
    }
  }
  return out;
}

// Build a fresh fake admin module. `opts.failGet` / `opts.failSet` / `opts.failTx`
// force the respective operations to throw, exercising the error-handling paths.
function makeFakeAdmin(opts = {}) {
  const store = new Map(); // docKey -> data object (or undefined when absent)

  const docRef = (collName, id) => {
    const key = `${collName}/${id}`;
    return {
      _key: key,
      async get() {
        if (opts.failGet) throw new Error('firestore get failed');
        const data = store.get(key);
        return { exists: data !== undefined, data: () => data };
      },
      async set(data, options = {}) {
        if (opts.failSet) throw new Error('firestore set failed');
        if (options.merge) {
          store.set(key, applyMerge(store.get(key), data));
        } else {
          store.set(key, applyMerge(undefined, data));
        }
      },
    };
  };

  const firestore = () => ({
    collection(name) {
      return { doc: (id) => docRef(name, id) };
    },
    async runTransaction(fn) {
      if (opts.failTx) throw new Error('tx backend down');
      // Single-shot transaction emulation (no real concurrency/retry).
      const tx = {
        async get(ref) {
          const data = store.get(ref._key);
          return { exists: data !== undefined, data: () => data };
        },
        set(ref, data, options = {}) {
          if (options.merge) {
            store.set(ref._key, applyMerge(store.get(ref._key), data));
          } else {
            store.set(ref._key, applyMerge(undefined, data));
          }
        },
      };
      return fn(tx);
    },
  });

  firestore.FieldValue = {
    arrayUnion: (...els) => makeSentinel(UNION, els),
    arrayRemove: (...els) => makeSentinel(REMOVE, els),
    serverTimestamp: () => SERVER_TS,
  };

  // Shaped like the `firebase-admin/firestore` module (v14 modular API): the
  // service does `const { getFirestore, FieldValue } = require('firebase-admin/firestore')`.
  return { getFirestore: firestore, FieldValue: firestore.FieldValue, _store: store };
}

// Install a fake admin into the module cache and return a freshly-required
// lockdown module bound to it. Each call gets an isolated store.
function loadLockdownWith(adminMock) {
  const fsPath = require.resolve('firebase-admin/firestore');
  const ldPath = require.resolve('../src/services/lockdown');
  const prevFs = require.cache[fsPath];
  require.cache[fsPath] = {
    id: fsPath,
    filename: fsPath,
    loaded: true,
    exports: adminMock,
  };
  delete require.cache[ldPath];
  const ld = require('../src/services/lockdown');
  // Restore the cache so other test files get the real module; the already-loaded
  // `ld` keeps its captured reference to our mock.
  if (prevFs) require.cache[fsPath] = prevFs;
  else delete require.cache[fsPath];
  delete require.cache[ldPath];
  return ld;
}

// =====================  Pure planner edge cases  ===========================

test('planLockdown: empty channel list yields empty buckets', () => {
  const { planLockdown } = loadLockdownWith(makeFakeAdmin());
  const plan = planLockdown([], []);
  assert.deepEqual(plan, { toLock: [], skipped: [], excluded: [] });
});

test('planLockdown: a channel that is BOTH excluded and already locked counts as excluded only', () => {
  const { planLockdown } = loadLockdownWith(makeFakeAdmin());
  // exclude is checked first, so the already-locked flag must not also bucket it.
  const plan = planLockdown([{ id: 'a', locked: true }], ['a']);
  assert.deepEqual(plan.excluded, ['a']);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.toLock, []);
});

test('planLockdown: every channel already locked -> nothing to lock', () => {
  const { planLockdown } = loadLockdownWith(makeFakeAdmin());
  const plan = planLockdown([
    { id: 'a', locked: true },
    { id: 'b', locked: true },
  ], []);
  assert.deepEqual(plan.toLock, []);
  assert.deepEqual(plan.skipped, ['a', 'b']);
});

test('planLockdown: duplicate channel ids both go to toLock (no dedupe)', () => {
  const { planLockdown } = loadLockdownWith(makeFakeAdmin());
  const plan = planLockdown([
    { id: 'a', locked: false },
    { id: 'a', locked: false },
  ], []);
  // Documents real behaviour: planLockdown does not dedupe. In practice the
  // guild channel cache has unique ids, so this is acceptable.
  assert.deepEqual(plan.toLock, ['a', 'a']);
});

test('planLockdown: exclude ids that are not present are simply ignored', () => {
  const { planLockdown } = loadLockdownWith(makeFakeAdmin());
  const plan = planLockdown([{ id: 'a', locked: false }], ['nonexistent']);
  assert.deepEqual(plan.toLock, ['a']);
  assert.deepEqual(plan.excluded, []);
});

test('planUnlock: empty existing-channel list drops everything', () => {
  const { planUnlock } = loadLockdownWith(makeFakeAdmin());
  assert.deepEqual(planUnlock([{ id: 'a', prior: 'allow' }], []), []);
});

test('planUnlock: mixed string and object records filtered against existing', () => {
  const { planUnlock } = loadLockdownWith(makeFakeAdmin());
  const recorded = ['a', { id: 'b', prior: 'allow' }, 'gone', { id: 'gone2' }];
  assert.deepEqual(planUnlock(recorded, ['a', 'b']), ['a', { id: 'b', prior: 'allow' }]);
});

test('planUnlock: dedupes by id keeping the first (true pre-lockdown) prior', () => {
  const { planUnlock } = loadLockdownWith(makeFakeAdmin());
  // Same channel recorded twice with conflicting prior (re-locked after its overwrite
  // changed). planUnlock must return it ONCE, keeping the first record's prior so the
  // channel isn't edited twice and is restored to its genuine original state.
  const recorded = [{ id: 'a', prior: 'neutral' }, { id: 'a', prior: 'allow' }];
  assert.deepEqual(planUnlock(recorded, ['a']), [{ id: 'a', prior: 'neutral' }]);
});

// =====================  Per-type lock/unlock semantics  ====================

test('lockOverwrite: announcement channel treated like text (SendMessages deny)', () => {
  const { lockOverwrite } = loadLockdownWith(makeFakeAdmin());
  assert.deepEqual(lockOverwrite(ChannelType.GuildAnnouncement), { SendMessages: false });
});

test('lockOverwrite: unknown/voice channel type falls through to SendMessages deny', () => {
  const { lockOverwrite } = loadLockdownWith(makeFakeAdmin());
  // Only forum is special-cased; anything else gets the text treatment.
  assert.deepEqual(lockOverwrite(ChannelType.GuildVoice), { SendMessages: false });
});

test('unlockOverwrite: forum with neutral prior clears both flags', () => {
  const { unlockOverwrite } = loadLockdownWith(makeFakeAdmin());
  assert.deepEqual(unlockOverwrite(ChannelType.GuildForum, 'neutral'), {
    CreatePublicThreads: null,
    SendMessagesInThreads: null,
  });
});

test('unlockOverwrite: forum always clears SendMessagesInThreads even for allow prior', () => {
  const { unlockOverwrite } = loadLockdownWith(makeFakeAdmin());
  // The prior state only ever tracked the PRIMARY flag (CreatePublicThreads),
  // so SendMessagesInThreads is unconditionally cleared to inherit.
  assert.deepEqual(unlockOverwrite(ChannelType.GuildForum, 'allow'), {
    CreatePublicThreads: true,
    SendMessagesInThreads: null,
  });
});

test('unlockOverwrite: any non-"allow" prior string is treated as neutral', () => {
  const { unlockOverwrite } = loadLockdownWith(makeFakeAdmin());
  assert.deepEqual(unlockOverwrite(ChannelType.GuildText, 'deny'), { SendMessages: null });
  assert.deepEqual(unlockOverwrite(ChannelType.GuildText, undefined), { SendMessages: null });
});

test('primaryLockFlag: non-forum returns SendMessages', () => {
  const { primaryLockFlag } = loadLockdownWith(makeFakeAdmin());
  assert.equal(primaryLockFlag(ChannelType.GuildAnnouncement), PermissionFlagsBits.SendMessages);
});

// =====================  Excluded-channel Firestore helpers  ================

test('getExcludedChannels: returns [] when doc does not exist', async () => {
  const ld = loadLockdownWith(makeFakeAdmin());
  assert.deepEqual(await ld.getExcludedChannels(), []);
});

test('getExcludedChannels: swallows read errors and returns []', async () => {
  const ld = loadLockdownWith(makeFakeAdmin({ failGet: true }));
  assert.deepEqual(await ld.getExcludedChannels(), []);
});

test('addExcludedChannel then getExcludedChannels reflects the add', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.addExcludedChannel('chan1');
  assert.deepEqual(await ld.getExcludedChannels(), ['chan1']);
});

test('addExcludedChannel is idempotent (arrayUnion does not duplicate)', async () => {
  const ld = loadLockdownWith(makeFakeAdmin());
  await ld.addExcludedChannel('chan1');
  await ld.addExcludedChannel('chan1');
  assert.deepEqual(await ld.getExcludedChannels(), ['chan1']);
});

test('removeExcludedChannel removes the id', async () => {
  const ld = loadLockdownWith(makeFakeAdmin());
  await ld.addExcludedChannel('a');
  await ld.addExcludedChannel('b');
  await ld.removeExcludedChannel('a');
  assert.deepEqual(await ld.getExcludedChannels(), ['b']);
});

// =====================  recordLockdown / getLockdown  ======================

test('getLockdown: null when no doc exists', async () => {
  const ld = loadLockdownWith(makeFakeAdmin());
  assert.equal(await ld.getLockdown(), null);
});

test('getLockdown: defaults lockedChannels to [] when field missing', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  // Seed a doc with no lockedChannels field.
  admin._store.set('config/lockdown', { lockedBy: 'mod1' });
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, []);
  assert.equal(rec.lockedBy, 'mod1');
});

test('getLockdown: swallows read error -> null', async () => {
  const ld = loadLockdownWith(makeFakeAdmin({ failGet: true }));
  assert.equal(await ld.getLockdown(), null);
});

test('recordLockdown: empty channel list does NOT write a lockedChannels field', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [], lockedBy: 'mod', reason: 'r' });
  const stored = admin._store.get('config/lockdown');
  assert.equal('lockedChannels' in stored, false);
  assert.equal(stored.lockedBy, 'mod');
  assert.equal(stored.reason, 'r');
});

test('recordLockdown: missing reason stored as null', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'mod' });
  assert.equal(admin._store.get('config/lockdown').reason, null);
});

test('recordLockdown accumulates across repeated /lockall runs (arrayUnion)', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'm', reason: null });
  await ld.recordLockdown({ channels: [{ id: 'b', prior: 'allow' }], lockedBy: 'm', reason: null });
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, [
    { id: 'a', prior: 'neutral' },
    { id: 'b', prior: 'allow' },
  ]);
});

test('recordLockdown: re-locking the SAME {id,prior} does not duplicate the record', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'm', reason: null });
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'm', reason: null });
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, [{ id: 'a', prior: 'neutral' }]);
});

// This probes a real state-machine corner: a channel is locked twice but with a
// DIFFERENT captured prior state the second time (e.g. between two /lockall runs
// the channel's @everyone overwrite changed). arrayUnion compares by deep value,
// so two records for the same id accumulate.
test('recordLockdown: same id with DIFFERENT prior produces TWO records for one channel', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'm', reason: null });
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'allow' }], lockedBy: 'm', reason: null });
  const rec = await ld.getLockdown();
  // recordLockdown uses arrayUnion (deep-value compare), so a re-lock with a changed
  // prior legitimately accumulates two records for one id. That's expected at the
  // storage layer; the double-restore risk it used to create is now neutralised in
  // planUnlock, which dedupes by id keeping the first (true pre-lockdown) prior — see
  // the 'planUnlock: dedupes by id' test above.
  assert.equal(rec.lockedChannels.length, 2);
  assert.deepEqual(rec.lockedChannels.map(c => c.id), ['a', 'a']);
});

// =====================  clearLockdown / removeLockedChannels  ==============

test('clearLockdown resets lockedChannels to empty but preserves other fields', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'mod', reason: 'spam' });
  await ld.clearLockdown();
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, []);
  // lockedBy / reason are NOT cleared (merge), matching the comment "resets the list".
  assert.equal(rec.lockedBy, 'mod');
  assert.equal(rec.reason, 'spam');
});

test('removeLockedChannels: no-op for empty list (no write)', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'm', reason: null });
  await ld.removeLockedChannels([]);
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, [{ id: 'a', prior: 'neutral' }]);
});

test('removeLockedChannels: no-op for undefined', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'm', reason: null });
  await ld.removeLockedChannels(undefined);
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, [{ id: 'a', prior: 'neutral' }]);
});

test('removeLockedChannels: drops only the matching {id,prior} records (partial-failure retry path)', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({
    channels: [
      { id: 'a', prior: 'neutral' },
      { id: 'b', prior: 'allow' },
      { id: 'c', prior: 'neutral' },
    ],
    lockedBy: 'm', reason: null,
  });
  // Simulate unlockall succeeding on a and c, failing on b.
  await ld.removeLockedChannels([{ id: 'a', prior: 'neutral' }, { id: 'c', prior: 'neutral' }]);
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, [{ id: 'b', prior: 'allow' }]);
});

// This mirrors the EXACT object shape unlockall.js passes to removeLockedChannels:
// `resolved` = [...gone, ...successfulItems]. `gone` items come straight from the
// record (full {id,prior}), and successful items are the same objects from planUnlock.
// Verifies arrayRemove matches them by deep value.
test('removeLockedChannels matches the resolved-record shape used by unlockall', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  const recorded = [
    { id: 'gone', prior: 'neutral' },   // channel deleted since lock
    { id: 'ok', prior: 'allow' },       // successfully unlocked
    { id: 'failed', prior: 'neutral' }, // failed -> must remain
  ];
  await ld.recordLockdown({ channels: recorded, lockedBy: 'm', reason: null });
  const gone = [{ id: 'gone', prior: 'neutral' }];
  const resolved = [...gone, { id: 'ok', prior: 'allow' }];
  await ld.removeLockedChannels(resolved);
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, [{ id: 'failed', prior: 'neutral' }]);
});

// =====================  Concurrency guard (acquireLock/releaseLock)  =======

test('acquireLock: succeeds on a fresh doc', async () => {
  const ld = loadLockdownWith(makeFakeAdmin());
  assert.equal(await ld.acquireLock(), true);
});

test('acquireLock: second acquire fails while busyUntil is in the future', async () => {
  const ld = loadLockdownWith(makeFakeAdmin());
  assert.equal(await ld.acquireLock(60000), true);
  assert.equal(await ld.acquireLock(60000), false);
});

test('acquireLock: succeeds again after the TTL has expired', async () => {
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  // Acquire with a TTL of 0 so busyUntil == now (not in the future).
  assert.equal(await ld.acquireLock(0), true);
  // busyUntil <= now, so a subsequent acquire should succeed.
  assert.equal(await ld.acquireLock(0), true);
});

test('acquireLock: releaseLock frees the guard for the next acquire', async () => {
  const ld = loadLockdownWith(makeFakeAdmin());
  assert.equal(await ld.acquireLock(60000), true);
  await ld.releaseLock();
  assert.equal(await ld.acquireLock(60000), true);
});

test('acquireLock: returns true (does not block) when the tx backend is unavailable', async () => {
  const ld = loadLockdownWith(makeFakeAdmin({ failTx: true }));
  assert.equal(await ld.acquireLock(), true);
});

test('releaseLock: swallows write errors (best effort)', async () => {
  const ld = loadLockdownWith(makeFakeAdmin({ failSet: true }));
  await assert.doesNotReject(() => ld.releaseLock());
});

test('acquireLock then concurrent lockall record: guard does not corrupt lockedChannels', async () => {
  // Acquiring the lock writes busyUntil via merge; it must not disturb an existing
  // lockedChannels array (state-machine corner: guard + record share one doc).
  const admin = makeFakeAdmin();
  const ld = loadLockdownWith(admin);
  await ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'm', reason: null });
  await ld.acquireLock(60000);
  const rec = await ld.getLockdown();
  assert.deepEqual(rec.lockedChannels, [{ id: 'a', prior: 'neutral' }]);
});

// Write helpers must let errors propagate (per the source comment) so the command
// can report failure to the moderator.
test('addExcludedChannel: lets Firestore write errors propagate', async () => {
  const ld = loadLockdownWith(makeFakeAdmin({ failSet: true }));
  await assert.rejects(() => ld.addExcludedChannel('x'));
});

test('recordLockdown: lets Firestore write errors propagate', async () => {
  const ld = loadLockdownWith(makeFakeAdmin({ failSet: true }));
  await assert.rejects(() => ld.recordLockdown({ channels: [{ id: 'a', prior: 'neutral' }], lockedBy: 'm', reason: null }));
});
