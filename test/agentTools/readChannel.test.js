const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readChannel } = require('../../src/services/agentTools/readChannel');
const { fakeChannel, fakeGuild, fakeMessage } = require('../helpers/mocks');

test('returns empty when channelId missing from ctx', async () => {
  const out = await readChannel({}, { guild: fakeGuild(), channelId: null });
  assert.deepEqual(out, []);
});

test('reads last N messages from ctx channel', async () => {
  const messages = [
    fakeMessage({ id: 'm1', content: 'hello', authorUsername: 'alice' }),
    fakeMessage({ id: 'm2', content: 'world', authorUsername: 'bob' }),
  ];
  const channel = fakeChannel({ id: 'c1', messages });
  const guild = fakeGuild({ channels: [channel] });

  const out = await readChannel({ limit: 20 }, { guild, channelId: 'c1' });
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'hello');
  assert.equal(out[0].author, 'alice');
});

test('ignores channelId passed in args (uses ctx.channelId only)', async () => {
  const messages = [fakeMessage({ id: 'm1', content: 'from allowed chan' })];
  const channel = fakeChannel({ id: 'allowed', messages });
  const guild = fakeGuild({ channels: [channel] });

  // Agent tries to redirect tool at a different channel via args
  const out = await readChannel(
    { limit: 5, channelId: 'attacker' },
    { guild, channelId: 'allowed' }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'from allowed chan');
});

test('truncates message content to 500 chars', async () => {
  const long = 'a'.repeat(1000);
  const messages = [fakeMessage({ id: 'm1', content: long })];
  const channel = fakeChannel({ id: 'c1', messages });
  const guild = fakeGuild({ channels: [channel] });

  const out = await readChannel({}, { guild, channelId: 'c1' });
  assert.equal(out[0].content.length, 500);
});

test('caps limit at 50 even if agent asks for more', async () => {
  const many = Array.from({ length: 100 }, (_, i) => fakeMessage({ id: `m${i}`, content: `msg${i}` }));
  const channel = fakeChannel({ id: 'c1', messages: many });
  const guild = fakeGuild({ channels: [channel] });

  const out = await readChannel({ limit: 1000 }, { guild, channelId: 'c1' });
  assert.ok(out.length <= 50);
});
