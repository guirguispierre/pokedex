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

test('ranks by Jaccard similarity using max(summary, text * 0.8) formula', async () => {
  // Issue A: only the SUMMARY matches the query strongly (text is unrelated)
  // Issue B: only the TEXT matches the query strongly (summary is unrelated)
  // Under max(sumSim, textSim * 0.8):
  //   A -> max(high, ~0)              = high
  //   B -> max(~0, high * 0.8)        = high * 0.8
  // So A should rank above B. Under sumSim-only, B ranks dead last (~0). Under
  // textSim-only, A ranks dead last (~0). Under (sumSim+textSim)/2 the order is
  // ambiguous. Only the spec'd formula gives A first, B second.
  const issues = [
    { id: 'A', summary: 'gmail labels broken integration', text: 'unrelated content about weather forecast', status: 'open' },
    { id: 'B', summary: 'unrelated content about weather forecast', text: 'gmail labels broken integration', status: 'open' },
    { id: 'C', summary: 'totally different topic about pizza', text: 'totally different topic about pizza', status: 'open' },
  ];
  const out = await searchIssues({ query: 'gmail labels broken integration' }, ctx(issues));
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'A', 'summary-match should rank first under max(sum, text*0.8)');
  assert.equal(out[1].id, 'B', 'text-match should rank second (penalized 0.8x)');
  assert.equal(out[2].id, 'C', 'no-match should rank last');
  assert.ok(out[0].similarity > out[1].similarity, 'A.similarity > B.similarity due to 0.8 penalty on text');
});

test('respects limit argument (default 5)', async () => {
  const issues = Array.from({ length: 20 }, (_, i) => ({
    id: `i${i}`, summary: `Issue ${i} about gmail`, text: 'stuff', status: 'open',
  }));
  const out = await searchIssues({ query: 'gmail', limit: 3 }, ctx(issues));
  assert.equal(out.length, 3);
});
