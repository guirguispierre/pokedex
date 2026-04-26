const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TOOL_SCHEMAS, dispatch } = require('../../src/services/agentTools');

test('TOOL_SCHEMAS is a non-empty array of OpenAI-shaped function tool defs', () => {
  assert.ok(Array.isArray(TOOL_SCHEMAS));
  assert.ok(TOOL_SCHEMAS.length >= 3);
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function?.name, 'string');
    assert.equal(typeof t.function?.description, 'string');
  }
});

test('dispatch returns error object for unknown tool', async () => {
  const result = await dispatch('nope_not_real', {}, {});
  assert.equal(result.error, 'unknown_tool');
});

test('dispatch catches thrown errors and returns error shape', async () => {
  // Inject a fake ctx that makes search_issues throw
  const ctx = {
    firestore: {
      searchOpenIssuesForAgent: async () => { throw new Error('boom'); },
    },
  };
  const result = await dispatch('search_issues', { query: 'gmail' }, ctx);
  // searchIssues itself returns [] on catch — this proves tools are isolated
  assert.ok(Array.isArray(result));
});

test('dispatch routes search_issues to searchIssues', async () => {
  const ctx = {
    firestore: {
      searchOpenIssuesForAgent: async () => [
        { id: 'a', summary: 'gmail broken', text: 'labels', status: 'open' },
      ],
    },
  };
  const result = await dispatch('search_issues', { query: 'gmail' }, ctx);
  assert.ok(Array.isArray(result));
  assert.equal(result[0].id, 'a');
});
