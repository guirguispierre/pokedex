const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractParentContext } = require('../src/triggers/mention');

test('returns null when no reference', async () => {
  const msg = { reference: null };
  const out = await extractParentContext(msg);
  assert.equal(out, null);
});

test('returns null when reference has no messageId', async () => {
  const msg = { reference: {} };
  const out = await extractParentContext(msg);
  assert.equal(out, null);
});

test('returns parent content + author when fetch succeeds', async () => {
  const parent = {
    content: 'Gmail broken all morning',
    author: { username: 'alice', id: 'u_alice' },
  };
  const msg = {
    reference: { messageId: 'm_parent' },
    channel: { messages: { fetch: async (id) => id === 'm_parent' ? parent : null } },
  };
  const out = await extractParentContext(msg);
  assert.equal(out.content, 'Gmail broken all morning');
  assert.equal(out.author, 'alice');
});

test('returns null on fetch throw', async () => {
  const msg = {
    reference: { messageId: 'm_parent' },
    channel: { messages: { fetch: async () => { throw new Error('gone'); } } },
  };
  const out = await extractParentContext(msg);
  assert.equal(out, null);
});
