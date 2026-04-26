const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldAutoResolve } = require('../src/triggers/thread');

test('reporter says solved → resolves', () => {
  assert.equal(shouldAutoResolve({ resolved: true }, 'u1', 'u1'), true);
});

test('non-reporter says fixed → does NOT resolve', () => {
  assert.equal(shouldAutoResolve({ resolved: true }, 'u2', 'u1'), false);
});

test('evaluator says not resolved → no resolve even if reporter', () => {
  assert.equal(shouldAutoResolve({ resolved: false }, 'u1', 'u1'), false);
});

test('null evaluation → no resolve', () => {
  assert.equal(shouldAutoResolve(null, 'u1', 'u1'), false);
});
