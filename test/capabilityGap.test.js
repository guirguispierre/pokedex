const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKey, shouldRepingAtCount, record } = require('../src/services/capabilityGap');
const { fakeFirestore, fakeChannel, fakeGuild } = require('./helpers/mocks');

test('normalizeKey maps variant titles to the same key', () => {
  const a = normalizeKey('Log query tool');
  const b = normalizeKey('log-query tool');
  const c = normalizeKey('TOOLS for querying logs');
  assert.equal(a, b);
  // c is a slightly different wording — may not match, but the two variants above MUST.
});

test('normalizeKey strips common stopwords', () => {
  const key = normalizeKey('the tool for querying the logs');
  assert.ok(!key.includes('the'));
});

test('shouldRepingAtCount: true at 1, 3, 10, 50; false otherwise', () => {
  assert.equal(shouldRepingAtCount(1), true);
  assert.equal(shouldRepingAtCount(2), false);
  assert.equal(shouldRepingAtCount(3), true);
  assert.equal(shouldRepingAtCount(4), false);
  assert.equal(shouldRepingAtCount(10), true);
  assert.equal(shouldRepingAtCount(11), false);
  assert.equal(shouldRepingAtCount(50), true);
  assert.equal(shouldRepingAtCount(51), false);
});

test('record creates new gap + channel post on first occurrence', async () => {
  const firestore = fakeFirestore();
  const postedMessages = [];
  const channel = {
    ...fakeChannel({ id: 'pc', name: 'pokedex-testing' }),
    send: async (payload) => {
      const msg = { id: `post_${postedMessages.length + 1}`, edit: async (p) => { msg.payload = p; } };
      postedMessages.push({ id: msg.id, payload });
      return msg;
    },
  };
  const guild = fakeGuild({ channels: [channel] });

  const gap = { title: 'log query tool', detail: 'would have confirmed by checking server logs' };
  await record({ gap, issueId: 'i1', guild, firestore, ownerId: '123456789012345678', channelName: 'pokedex-testing' });

  const stored = await firestore.getGapByKey(normalizeKey('log query tool'));
  assert.ok(stored);
  assert.equal(stored.occurrenceCount, 1);
  assert.deepEqual(stored.exampleIssueIds, ['i1']);
  assert.equal(postedMessages.length, 1);
  assert.ok(postedMessages[0].payload.content.includes('<@123456789012345678>'));
});

test('record edits existing post on second occurrence without re-pinging', async () => {
  const existing = {
    id: 'gap_existing',
    title: 'log query tool',
    normalizedKey: normalizeKey('log query tool'),
    occurrenceCount: 1,
    exampleIssueIds: ['i1'],
    postMessageId: 'post_1',
    status: 'open',
  };
  const firestore = fakeFirestore({ gaps: [existing] });

  let edited = null;
  const channel = {
    ...fakeChannel({ id: 'pc', name: 'pokedex-testing' }),
    send: async () => { throw new Error('should not post again'); },
    messages: {
      fetch: async (id) => {
        if (id === 'post_1') return { id, edit: async (p) => { edited = p; } };
        return null;
      },
    },
  };
  const guild = fakeGuild({ channels: [channel] });

  const gap = { title: 'Log Query Tool', detail: 'same gap' };
  await record({ gap, issueId: 'i2', guild, firestore, ownerId: '123456789012345678', channelName: 'pokedex-testing' });

  const stored = await firestore.getGapByKey(normalizeKey('log query tool'));
  assert.equal(stored.occurrenceCount, 2);
  assert.deepEqual(stored.exampleIssueIds, ['i1', 'i2']);
  assert.ok(edited, 'existing post was edited');
  assert.ok(!edited.content.includes('<@123456789012345678>'), 'no re-ping at count 2');
});
