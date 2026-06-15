const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyTimeout } = require('../src/commands/mute');

test('applyTimeout: non-moderatable member -> false, no timeout call', async () => {
  let called = false;
  const member = { moderatable: false, timeout: async () => { called = true; } };
  assert.equal(await applyTimeout(member, 1000, 'r'), false);
  assert.equal(called, false);
});

test('applyTimeout: null member -> false', async () => {
  assert.equal(await applyTimeout(null, 1000, 'r'), false);
});

test('applyTimeout: moderatable member -> calls timeout, returns true', async () => {
  let args = null;
  const member = { moderatable: true, timeout: async (ms, reason) => { args = { ms, reason }; } };
  assert.equal(await applyTimeout(member, 5000, 'spam'), true);
  assert.deepEqual(args, { ms: 5000, reason: 'spam' });
});
