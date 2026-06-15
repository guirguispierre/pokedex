const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createPoller } = require('../src/services/statusPoller');

const fixture = (name) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures/status/', name), 'utf-8'));

// Hand-rolled capturing mock: records calls and returns impl's result.
function fn(impl = () => {}) {
  const mock = (...args) => {
    mock.calls.push(args);
    return impl(...args);
  };
  mock.calls = [];
  return mock;
}

function makeFakeClient({ fetchChannel, fetchRole } = {}) {
  return {
    channels: {
      fetch: fetchChannel ?? fn(),
    },
    guilds: {
      fetch: fn(async (id) => ({
        id,
        roles: { fetch: fetchRole ?? fn() },
      })),
    },
  };
}

function makeFakeChannel(overrides = {}) {
  const sentMessages = [];
  const editedMessages = [];
  const messageStore = new Map();
  let msgCounter = 0;

  const ch = {
    id: 'ch1',
    isTextBased: () => true,
    send: fn(async (payload) => {
      const id = `msg-${++msgCounter}`;
      const pinFn = fn(async () => {});
      const msg = { id, pin: pinFn, payload };
      messageStore.set(id, msg);
      sentMessages.push({ id, payload });
      return msg;
    }),
    messages: {
      fetch: fn(async (id) => {
        const m = messageStore.get(id);
        if (!m) {
          const err = new Error('Unknown Message');
          err.code = 10008;
          throw err;
        }
        return {
          id: m.id,
          edit: fn(async (p) => { editedMessages.push({ id, payload: p }); }),
        };
      }),
    },
    ...overrides,
  };

  ch._sent = sentMessages;
  ch._edited = editedMessages;
  return ch;
}

function makeFakeStore(initial = {}) {
  const docs = new Map(Object.entries(initial));
  return {
    _docs: docs,
    async get(id) { return docs.has(id) ? { id, ...docs.get(id) } : null; },
    async save(id, patch) {
      docs.set(id, { ...(docs.get(id) ?? {}), ...patch });
    },
    async listEnabled() {
      const out = [];
      for (const [id, data] of docs.entries()) {
        if (data.enabled) out.push({ id, ...data });
      }
      return out;
    },
    async disable(id) {
      docs.set(id, { ...(docs.get(id) ?? {}), enabled: false });
    },
    async clearPinnedMessageId(id) {
      docs.set(id, { ...(docs.get(id) ?? {}), pinnedMessageId: null });
    },
  };
}

describe('statusPoller.runTick', () => {
  test('creates and pins a summary message on first tick with no prior state', async () => {
    const channel = makeFakeChannel();
    const client = makeFakeClient({ fetchChannel: fn(async () => channel) });
    const store = makeFakeStore({
      g1: { enabled: true, channelId: 'ch1', pinnedMessageId: null },
    });
    const fetcher = { fetchSummary: fn(async () => fixture('all-operational.json')) };
    const poller = createPoller({
      client, fetcher, store,
      config: { getConfig: () => 'https://status.poke.com' },
      logger: { warn: fn(), error: fn(), info: fn() },
    });

    await poller.runTick();

    assert.equal(channel.send.calls.length, 1);
    const stored = await store.get('g1');
    assert.match(stored.pinnedMessageId, /^msg-/);
    assert.ok(stored.lastSummary);
  });

  test('edits the pinned message on subsequent tick and posts transition alerts', async () => {
    const channel = makeFakeChannel();
    channel.messages.fetch = fn(async () => ({ id: 'msg-existing', edit: fn(async () => {}) }));
    const client = makeFakeClient({ fetchChannel: fn(async () => channel) });

    const store = makeFakeStore({
      g1: {
        enabled: true,
        channelId: 'ch1',
        pinnedMessageId: 'msg-existing',
        lastSummary: fixture('all-operational.json'),
      },
    });
    const fetcher = { fetchSummary: fn(async () => fixture('partial-outage.json')) };
    const poller = createPoller({
      client, fetcher, store,
      config: { getConfig: () => 'https://status.poke.com' },
      logger: { warn: fn(), error: fn(), info: fn() },
    });

    await poller.runTick();

    assert.equal(channel.send.calls.length, 2);
    assert.ok(channel.messages.fetch.calls.length > 0);
  });

  test('posts an incident alert with role ping when alertRoleId is set', async () => {
    const channel = makeFakeChannel();
    const client = makeFakeClient({ fetchChannel: fn(async () => channel) });
    const store = makeFakeStore({
      g1: {
        enabled: true, channelId: 'ch1', pinnedMessageId: 'msg-existing',
        alertRoleId: 'role123',
        lastSummary: fixture('all-operational.json'),
      },
    });
    channel.messages.fetch = fn(async () => ({ id: 'msg-existing', edit: fn(async () => {}) }));

    const fetcher = { fetchSummary: fn(async () => fixture('active-incident.json')) };
    const poller = createPoller({
      client, fetcher, store,
      config: { getConfig: () => 'https://status.poke.com' },
      logger: { warn: fn(), error: fn(), info: fn() },
    });

    await poller.runTick();

    const roleMention = channel.send.calls.find(c =>
      typeof c[0]?.content === 'string' && c[0].content.includes('<@&role123>')
    );
    assert.ok(roleMention);
  });

  test('clears pinnedMessageId when the pinned message was deleted (10008)', async () => {
    const channel = makeFakeChannel();
    channel.messages.fetch = fn(async () => {
      const err = new Error('Unknown Message');
      err.code = 10008;
      throw err;
    });
    const client = makeFakeClient({ fetchChannel: fn(async () => channel) });
    const store = makeFakeStore({
      g1: {
        enabled: true, channelId: 'ch1',
        pinnedMessageId: 'msg-gone',
        lastSummary: fixture('all-operational.json'),
      },
    });
    const fetcher = { fetchSummary: fn(async () => fixture('all-operational.json')) };
    const poller = createPoller({
      client, fetcher, store,
      config: { getConfig: () => 'https://status.poke.com' },
      logger: { warn: fn(), error: fn(), info: fn() },
    });

    await poller.runTick();

    const saved = await store.get('g1');
    assert.match(saved.pinnedMessageId, /^msg-/);
    assert.notEqual(saved.pinnedMessageId, 'msg-gone');
  });

  test('disables a guild when the channel was deleted (10003)', async () => {
    const deletedChannelFetch = fn(async () => {
      const err = new Error('Unknown Channel');
      err.code = 10003;
      throw err;
    });
    const client = makeFakeClient({ fetchChannel: deletedChannelFetch });
    const store = makeFakeStore({
      g1: {
        enabled: true, channelId: 'ch-gone',
        pinnedMessageId: null,
        lastSummary: null,
      },
    });
    const fetcher = { fetchSummary: fn(async () => fixture('all-operational.json')) };
    const poller = createPoller({
      client, fetcher, store,
      config: { getConfig: () => 'https://status.poke.com' },
      logger: { warn: fn(), error: fn(), info: fn() },
    });

    await poller.runTick();

    const saved = await store.get('g1');
    assert.equal(saved.enabled, false);
  });

  test('skips the tick on fetch failure and does not post anything', async () => {
    const channel = makeFakeChannel();
    const client = makeFakeClient({ fetchChannel: fn(async () => channel) });
    const store = makeFakeStore({
      g1: { enabled: true, channelId: 'ch1', pinnedMessageId: 'msg-x', lastSummary: null },
    });
    const warn = fn();
    const fetcher = { fetchSummary: fn(async () => { throw new Error('down'); }), getConsecutiveFailures: () => 1 };
    const poller = createPoller({
      client, fetcher, store,
      config: { getConfig: () => 'https://status.poke.com' },
      logger: { warn, error: fn(), info: fn() },
    });

    await poller.runTick();

    assert.equal(channel.send.calls.length, 0);
    assert.ok(warn.calls.length > 0);
  });
});
