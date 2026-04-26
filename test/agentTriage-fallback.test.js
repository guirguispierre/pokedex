const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triageIssue } = require('../src/services/agentTriage');
const { fakeFirestore } = require('./helpers/mocks');

function seq(items) {
  let i = 0;
  return {
    callWithTools: async () => {
      if (i >= items.length) throw new Error('exhausted');
      const v = items[i++];
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

test('fallback on invalid JSON from model', async () => {
  const or = seq([{ content: 'not json', tool_calls: [] }]);
  const out = await triageIssue({
    text: 'gmail broken',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });
  assert.equal(out.priority, 'unclassified');
  assert.equal(out.agentMeta.fallbackReason, 'invalid_json');
});

test('fallback when budget exhausted', async () => {
  // 6 consecutive responses that all ask for another tool call
  const infiniteTool = {
    content: null,
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'search_issues', arguments: '{"query":"x"}' } }],
  };
  const or = seq([infiniteTool, infiniteTool, infiniteTool, infiniteTool, infiniteTool, infiniteTool]);
  const out = await triageIssue({
    text: 'x',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });
  assert.equal(out.agentMeta.fallbackReason, 'budget_exhausted');
});

test('fallback when OpenRouter throws on every call (no images)', async () => {
  const or = seq([new Error('network down')]);
  const out = await triageIssue({
    text: 'x',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });
  assert.ok(out.agentMeta.fallbackReason.startsWith('openrouter_error'));
});

test('retries without images when first call with images fails', async () => {
  // First call (with images) throws; second call (without images) returns valid JSON
  const or = seq([
    new Error('vision rejected'),
    {
      content: JSON.stringify({
        priority: 'low', category: 'other', target: 'poke_product',
        summary: 'text-only classification', reasoning: 'r',
        follow_up: null,
        evidence: { screenshot_text: 'image unreadable', related_issues: null, active_incident: null },
        capability_gap: null,
      }),
      tool_calls: [],
    },
  ]);
  const out = await triageIssue({
    text: 'x',
    images: ['https://example.com/img.png'],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });
  assert.equal(out.priority, 'low');
  assert.equal(out.agentMeta.fallbackReason, undefined, 'second call succeeded, no fallback flag');
});
