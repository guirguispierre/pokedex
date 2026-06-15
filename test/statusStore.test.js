const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/services/statusStore');

function makeFakeDb() {
  const collections = new Map();

  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    const docs = collections.get(name);

    function doc(id) {
      return {
        async get() {
          const data = docs.get(id);
          return { id, exists: data !== undefined, data: () => data ?? null };
        },
        async set(data, options = {}) {
          if (options.merge) {
            docs.set(id, { ...(docs.get(id) ?? {}), ...data });
          } else {
            docs.set(id, { ...data });
          }
        },
        async update(patch) {
          const existing = docs.get(id);
          if (existing === undefined) {
            const err = new Error('NOT_FOUND');
            err.code = 5;
            throw err;
          }
          docs.set(id, { ...existing, ...patch });
        },
      };
    }

    function where(field, op, value) {
      return {
        async get() {
          const matches = [];
          for (const [id, data] of docs.entries()) {
            const v = data?.[field];
            if (op === '==' && v === value) matches.push({ id, data: () => data });
          }
          return { docs: matches, empty: matches.length === 0 };
        },
      };
    }

    return { doc, where };
  }

  return { collection };
}

describe('statusStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = makeFakeDb();
    store = createStore(db);
  });

  test('get returns null when no document exists', async () => {
    const res = await store.get('guild1');
    assert.equal(res, null);
  });

  test('save creates a document and get returns it', async () => {
    await store.save('guild1', { channelId: 'ch1', enabled: true });
    const res = await store.get('guild1');
    assert.equal(res.channelId, 'ch1');
    assert.equal(res.enabled, true);
    assert.equal(res.guildId, 'guild1');
    assert.ok(res.updatedAt);
  });

  test('save merges instead of overwriting', async () => {
    await store.save('guild1', { channelId: 'ch1', enabled: true });
    await store.save('guild1', { pinnedMessageId: 'msg1' });
    const res = await store.get('guild1');
    assert.equal(res.channelId, 'ch1');
    assert.equal(res.pinnedMessageId, 'msg1');
    assert.equal(res.enabled, true);
  });

  test('listEnabled returns only enabled guilds', async () => {
    await store.save('g1', { enabled: true });
    await store.save('g2', { enabled: false });
    await store.save('g3', { enabled: true });
    const enabled = await store.listEnabled();
    const ids = enabled.map(r => r.id).sort();
    assert.deepEqual(ids, ['g1', 'g3']);
  });

  test('disable flips enabled to false and keeps other fields', async () => {
    await store.save('g1', { enabled: true, channelId: 'ch1' });
    await store.disable('g1');
    const res = await store.get('g1');
    assert.equal(res.enabled, false);
    assert.equal(res.channelId, 'ch1');
  });

  test('clearPinnedMessageId nulls the pinnedMessageId field', async () => {
    await store.save('g1', { enabled: true, pinnedMessageId: 'msg1' });
    await store.clearPinnedMessageId('g1');
    const res = await store.get('g1');
    assert.equal(res.pinnedMessageId, null);
  });
});
