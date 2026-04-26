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

test('parallel tool calls are appended as ONE assistant message + N tool messages', async () => {
  // This test ALSO covers C1 — if we revert, parallel calls will produce N
  // assistant messages and this test will fail.
  const calls = [];
  const sequence = [
    {
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'search_issues', arguments: '{"query":"x"}' } },
        { id: 'c2', type: 'function', function: { name: 'search_issues', arguments: '{"query":"y"}' } },
      ],
    },
    {
      content: JSON.stringify({
        priority: 'low', category: 'other', target: 'poke_product',
        summary: 's', reasoning: 'r', follow_up: null,
        evidence: { screenshot_text: null, related_issues: null, active_incident: null },
        capability_gap: null,
      }),
      tool_calls: [],
    },
  ];
  const or = {
    callWithTools: async (args) => { calls.push(args); return sequence[calls.length - 1]; },
  };

  await triageIssue({
    text: 'parallel test',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });

  // 2 calls were made
  assert.equal(calls.length, 2);
  // Second call's messages: should have ONE assistant message containing BOTH tool_calls,
  // then TWO tool messages (one per id).
  const secondMsgs = calls[1].messages;
  const assistantTurns = secondMsgs.filter(m => m.role === 'assistant');
  const toolTurns = secondMsgs.filter(m => m.role === 'tool');
  assert.equal(assistantTurns.length, 1, 'exactly one assistant message for the parallel turn');
  assert.equal(assistantTurns[0].tool_calls.length, 2, 'assistant message holds both tool_calls');
  assert.equal(toolTurns.length, 2, 'two tool messages, one per call');
  const toolIds = toolTurns.map(t => t.tool_call_id).sort();
  assert.deepEqual(toolIds, ['c1', 'c2']);
});

test('tool result content reaches the next call as a stringified payload', async () => {
  const calls = [];
  const sequence = [
    {
      content: null,
      tool_calls: [{ id: 'cx', type: 'function', function: { name: 'search_issues', arguments: '{"query":"x"}' } }],
    },
    {
      content: JSON.stringify({
        priority: 'low', category: 'other', target: 'poke_product',
        summary: 's', reasoning: 'r', follow_up: null,
        evidence: { screenshot_text: null, related_issues: null, active_incident: null },
        capability_gap: null,
      }),
      tool_calls: [],
    },
  ];
  const or = {
    callWithTools: async (args) => { calls.push(args); return sequence[calls.length - 1]; },
  };
  const firestore = fakeFirestore({
    issues: [{ id: 'iLeak', summary: 'gmail leaks', text: 'gmail labels broken', status: 'open' }],
  });
  // Add the missing method that searchIssues actually calls
  firestore.searchOpenIssuesForAgent = async () => [
    { id: 'iLeak', summary: 'gmail leaks', text: 'gmail labels broken', status: 'open' },
  ];

  await triageIssue({
    text: 'gmail problem',
    images: [],
    ctx: { firestore, channelId: 'c1', reporterId: 'u1' },
    openrouter: or,
  });

  const toolTurn = calls[1].messages.find(m => m.role === 'tool');
  assert.ok(toolTurn, 'tool message is present');
  assert.equal(toolTurn.tool_call_id, 'cx');
  assert.match(toolTurn.content, /iLeak/, 'tool result includes the issue id we expect');
});

test('parentMessage shapes the user content with parent context', async () => {
  const calls = [];
  const or = {
    callWithTools: async (args) => {
      calls.push(args);
      return {
        content: JSON.stringify({
          priority: 'low', category: 'other', target: 'poke_product',
          summary: 's', reasoning: 'r', follow_up: null,
          evidence: { screenshot_text: null, related_issues: null, active_incident: null },
          capability_gap: null,
        }),
        tool_calls: [],
      };
    },
  };

  await triageIssue({
    text: 'did you see this?',
    images: [],
    ctx: { firestore: fakeFirestore(), channelId: 'c1', reporterId: 'u_replier' },
    openrouter: or,
    parentMessage: {
      content: 'Gmail integration broken all morning',
      author: 'alice',
      replierUsername: 'bob',
    },
  });

  const userMsg = calls[0].messages.find(m => m.role === 'user');
  assert.ok(userMsg);
  assert.match(userMsg.content, /PARENT MESSAGE/);
  assert.match(userMsg.content, /alice/);
  assert.match(userMsg.content, /Gmail integration broken/);
  assert.match(userMsg.content, /bob/);
  assert.match(userMsg.content, /did you see this\?/);
});
