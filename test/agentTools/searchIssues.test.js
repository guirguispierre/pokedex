const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchIssues } = require('../../src/services/agentTools/searchIssues');

function ctx(issues) {
  return {
    firestore: {
      searchOpenIssuesForAgent: async () => issues,
    },
  };
}

test('returns empty array when no issues', async () => {
  const out = await searchIssues({ query: 'gmail' }, ctx([]));
  assert.deepEqual(out, []);
});

test('ranks by Jaccard similarity against summary + text', async () => {
  const issues = [
    { id: 'a', summary: 'Gmail integration broken for labels', text: 'labels not applying', status: 'open', priority: 'high', category: 'bug' },
    { id: 'b', summary: 'Calendar sync slow', text: 'meetings delayed', status: 'open', priority: 'medium', category: 'performance' },
    { id: 'c', summary: 'Gmail sync failing', text: 'cannot read new emails', status: 'open', priority: 'high', category: 'bug' },
  ];
  const out = await searchIssues({ query: 'gmail labels broken' }, ctx(issues));
  assert.ok(out.length >= 1, 'should return at least one match');
  assert.equal(out[0].id, 'a', 'best match should be the Gmail labels issue');
  assert.ok(typeof out[0].similarity === 'number');
});

test('respects limit argument (default 5)', async () => {
  const issues = Array.from({ length: 20 }, (_, i) => ({
    id: `i${i}`, summary: `Issue ${i} about gmail`, text: 'stuff', status: 'open',
  }));
  const out = await searchIssues({ query: 'gmail', limit: 3 }, ctx(issues));
  assert.equal(out.length, 3);
});

test('supplied channelId in args is ignored (ctx-only)', async () => {
  // This is defense-in-depth; searchIssues doesn't use channelId anyway.
  // Test documents the pattern for other tools.
  const out = await searchIssues({ query: 'x', channelId: 'evil' }, ctx([]));
  assert.deepEqual(out, []);
});
