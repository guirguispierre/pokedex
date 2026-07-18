// Tests for the /graveyard command + its message-delete tracking handlers.
// Firestore is stubbed with an in-memory fake (preserving FieldValue.increment
// and serverTimestamp semantics) so no network / real Firebase is involved.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');

const cmd = require('../src/commands/graveyard');

const realFirestore = admin.firestore;

function setFirestore(fn) {
  Object.defineProperty(admin, 'firestore', {
    value: fn, writable: true, configurable: true, enumerable: true,
  });
}
function restoreFirestore() {
  delete admin.firestore;
}

// In-memory Firestore fake. `store` maps `${collection}/${docId}` -> data object.
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
        const next = { ...prev };
        for (const [k, v] of Object.entries(payload)) {
          if (v && v.__increment !== undefined) {
            next[k] = (prev[k] || 0) + v.__increment;
          } else {
            next[k] = v;
          }
        }
        store.set(path, next);
      },
    };
  }

  function makeCollection(name) {
    return {
      doc: (id) => makeDocRef(name, id),
      where(field, _op, value) {
        const q = {
          _filters: [[field, value]],
          _order: null,
          _limit: Infinity,
          where(f, _o, v) { this._filters.push([f, v]); return this; },
          orderBy(f, dir) { this._order = [f, dir]; return this; },
          limit(n) { this._limit = n; return this; },
          async get() {
            let docs = [...store.entries()]
              .filter(([p]) => p.startsWith(`${name}/`))
              .map(([p, data]) => ({ id: p.split('/')[1], data: () => data }));
            for (const [f, v] of this._filters) docs = docs.filter(d => d.data()[f] === v);
            if (this._order) {
              const [f, dir] = this._order;
              docs.sort((a, b) => dir === 'desc' ? (b.data()[f] || 0) - (a.data()[f] || 0) : (a.data()[f] || 0) - (b.data()[f] || 0));
            }
            docs = docs.slice(0, this._limit);
            return { empty: docs.length === 0, size: docs.length, docs };
          },
        };
        q._filters = [[field, value]];
        return q;
      },
    };
  }

  const fakeDb = { collection: (name) => makeCollection(name) };
  const fn = () => fakeDb;
  Object.assign(fn, realFirestore);
  fn.FieldValue = {
    increment: (n) => ({ __increment: n }),
    serverTimestamp: () => 'server-ts',
  };
  setFirestore(fn);
  return store;
}

function makeFn(impl = () => Promise.resolve()) {
  const fn = (...args) => { fn.calls.push(args); return impl(...args); };
  fn.calls = [];
  return fn;
}

function makeInteraction(sub, options = {}) {
  return {
    guild: { id: 'g1' },
    user: { id: 'me', username: 'me', displayAvatarURL: () => 'http://avatar' },
    options: {
      getSubcommand: () => sub,
      getInteger: (k) => options[k] ?? null,
      getUser: (k) => options[k] ?? null,
    },
    deferReply: makeFn(),
    editReply: makeFn(),
  };
}

describe('/graveyard tracking', () => {
  afterEach(restoreFirestore);

  test('trackDeletedMessage increments an author count by one', async () => {
    const store = installFakeFirestore();
    const message = { guild: { id: 'g1' }, author: { id: 'u1', username: 'alice', bot: false } };

    await cmd.trackDeletedMessage(message);
    await cmd.trackDeletedMessage(message);

    assert.equal(store.get('deletedMessages/g1_u1').count, 2);
    assert.equal(store.get('deletedMessages/g1_u1').username, 'alice');
  });

  test('trackDeletedMessage ignores bots and partial (authorless) messages', async () => {
    const store = installFakeFirestore();
    await cmd.trackDeletedMessage({ guild: { id: 'g1' }, author: { id: 'b', username: 'bot', bot: true } });
    await cmd.trackDeletedMessage({ guild: { id: 'g1' }, author: null });
    assert.equal(store.size, 0);
  });

  test('trackBulkDeletedMessages aggregates per author into single increments', async () => {
    const store = installFakeFirestore();
    const messages = new Map([
      ['m1', { guild: { id: 'g1' }, author: { id: 'u1', username: 'alice', bot: false } }],
      ['m2', { guild: { id: 'g1' }, author: { id: 'u1', username: 'alice', bot: false } }],
      ['m3', { guild: { id: 'g1' }, author: { id: 'u2', username: 'bob', bot: false } }],
      ['m4', { guild: { id: 'g1' }, author: { id: 'b', username: 'bot', bot: true } }],
    ]);

    await cmd.trackBulkDeletedMessages(messages);

    assert.equal(store.get('deletedMessages/g1_u1').count, 2);
    assert.equal(store.get('deletedMessages/g1_u2').count, 1);
    assert.equal(store.get('deletedMessages/g1_b'), undefined);
  });
});

describe('/graveyard viewing (public)', () => {
  afterEach(restoreFirestore);

  test('board replies publicly (deferReply without ephemeral) sorted by count', async () => {
    installFakeFirestore({
      'deletedMessages/g1_u1': { userId: 'u1', guildId: 'g1', username: 'alice', count: 5 },
      'deletedMessages/g1_u2': { userId: 'u2', guildId: 'g1', username: 'bob', count: 9 },
      'deletedMessages/g2_u3': { userId: 'u3', guildId: 'g2', username: 'eve', count: 99 },
    });
    const interaction = makeInteraction('board');

    await cmd.execute(interaction);

    // Public: deferReply called with no args (or without ephemeral:true).
    const arg = interaction.deferReply.calls[0][0];
    assert.ok(arg === undefined || arg.ephemeral !== true);

    const { embeds } = interaction.editReply.calls[0][0];
    const desc = embeds[0].data.description;
    // Bob (9) ranks above Alice (5); the other guild is excluded.
    assert.ok(desc.indexOf('<@u2>') < desc.indexOf('<@u1>'));
    assert.ok(!desc.includes('<@u3>'));
  });

  test('board handles empty state', async () => {
    installFakeFirestore();
    const interaction = makeInteraction('board');
    await cmd.execute(interaction);
    assert.match(interaction.editReply.calls[0][0], /No deleted messages tracked/);
  });

  test('check reports a user count publicly', async () => {
    installFakeFirestore({
      'deletedMessages/g1_me': { userId: 'me', guildId: 'g1', username: 'me', count: 3 },
    });
    const interaction = makeInteraction('check');

    await cmd.execute(interaction);

    const arg = interaction.deferReply.calls[0][0];
    assert.ok(arg === undefined || arg.ephemeral !== true);
    const { embeds } = interaction.editReply.calls[0][0];
    assert.match(embeds[0].data.description, /\*\*3\*\* messages/);
  });
});
