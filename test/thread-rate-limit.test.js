const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canBotReplyInThread, _reset } = require('../src/triggers/thread');

test('first 3 replies allowed within 10 minutes', () => {
  _reset();
  const now = Date.now();
  assert.equal(canBotReplyInThread('t1', now), true);
  assert.equal(canBotReplyInThread('t1', now + 1000), true);
  assert.equal(canBotReplyInThread('t1', now + 2000), true);
});

test('4th reply within 10 minutes blocked', () => {
  _reset();
  const now = Date.now();
  canBotReplyInThread('t1', now);
  canBotReplyInThread('t1', now + 1000);
  canBotReplyInThread('t1', now + 2000);
  assert.equal(canBotReplyInThread('t1', now + 3000), false);
});

test('old replies slide out of window after 10 min', () => {
  _reset();
  const now = Date.now();
  canBotReplyInThread('t1', now);
  canBotReplyInThread('t1', now + 1000);
  canBotReplyInThread('t1', now + 2000);
  // 10 minutes + 1ms later, the first reply has slid out
  assert.equal(canBotReplyInThread('t1', now + 10 * 60 * 1000 + 1), true);
});

test('rate limits are per-thread', () => {
  _reset();
  const now = Date.now();
  canBotReplyInThread('t1', now);
  canBotReplyInThread('t1', now + 1);
  canBotReplyInThread('t1', now + 2);
  assert.equal(canBotReplyInThread('t2', now + 3), true, 'different thread not affected');
});
