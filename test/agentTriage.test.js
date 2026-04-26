const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triageIssue } = require('../src/services/agentTriage');
const { fakeFirestore } = require('./helpers/mocks');

function fakeOpenRouter(sequence) {
  let i = 0;
  return {
    callWithTools: async () => {
      if (i >= sequence.length) throw new Error('responder exhausted');
      return sequence[i++];
    },
  };
}

test('returns classification when model emits final JSON immediately', async () => {
  const or = fakeOpenRouter([
    {
      content: JSON.stringify({
        priority: 'high',
        category: 'bug',
        target: 'poke_product',
        summary: 'Gmail broken',
        reasoning: 'User reports labels not applying',
        follow_up: null,
        evidence: { screenshot_text: null, related_issues: null, active_incident: null },
        capability_gap: null,
      }),
      tool_calls: [],
    },
  ]);

  const out = await triageIssue({
    text: 'Gmail labels broken',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });

  assert.equal(out.priority, 'high');
  assert.equal(out.target, 'poke_product');
  assert.equal(out.agentMeta.toolCallsMade, 0);
  assert.ok(out.agentMeta.durationMs >= 0);
});

test('executes one tool call then receives final JSON', async () => {
  const or = fakeOpenRouter([
    {
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'search_issues', arguments: JSON.stringify({ query: 'gmail' }) },
        },
      ],
    },
    {
      content: JSON.stringify({
        priority: 'medium',
        category: 'bug',
        target: 'poke_product',
        summary: 'Gmail issue',
        reasoning: 'Found 1 similar',
        follow_up: null,
        evidence: { screenshot_text: null, related_issues: ['issue_1'], active_incident: null },
        capability_gap: null,
      }),
      tool_calls: [],
    },
  ]);

  const firestore = fakeFirestore({
    issues: [{ id: 'issue_1', summary: 'Gmail labels broken', text: 'labels not applying', status: 'open' }],
  });

  const out = await triageIssue({
    text: 'my gmail broke',
    images: [],
    ctx: { firestore, channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });

  assert.equal(out.agentMeta.toolCallsMade, 1);
  assert.deepEqual(out.evidence.related_issues, ['issue_1']);
});
