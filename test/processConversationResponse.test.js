'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// We need to stub firestore before requiring contextEvaluator
// so that updateIssueResolution is captured without a real DB.
const updatedResolutions = [];
require.cache[require.resolve('../src/services/firestore')] = {
  id: require.resolve('../src/services/firestore'),
  filename: require.resolve('../src/services/firestore'),
  loaded: true,
  exports: {
    updateIssueResolution: async (id, data) => { updatedResolutions.push({ id, ...data }); },
    updateIssueFields: async () => {},
  },
};

// Stub triage so buildIssueEmbed / findTriageChannel don't need Discord
require.cache[require.resolve('../src/services/triage')] = {
  id: require.resolve('../src/services/triage'),
  filename: require.resolve('../src/services/triage'),
  loaded: true,
  exports: {
    buildIssueEmbed: () => ({ addFields: () => {}, setTimestamp: () => {}, setColor: () => {}, setTitle: () => {} }),
    findTriageChannel: () => null,
    postIssueEmbed: async () => null,
  },
};

// Stub openrouter
require.cache[require.resolve('../src/services/openrouter')] = {
  id: require.resolve('../src/services/openrouter'),
  filename: require.resolve('../src/services/openrouter'),
  loaded: true,
  exports: { evaluateIssueContext: async () => ({}), classifyIssue: async () => ({}) },
};

const { processConversationResponse } = require('../src/services/contextEvaluator');
const { fakeMessage } = require('./helpers/mocks');

test('reporter resolution path: updates resolution + sends confirmation, skips reply/react', async () => {
  const sent = [];
  const reactions = [];
  const message = {
    ...fakeMessage({ authorId: 'u_reporter' }),
    channel: { send: async (p) => { sent.push(p); } },
    react: async (e) => { reactions.push(e); },
    guild: { channels: { cache: { find: () => null } } },
  };
  const issue = { reporterId: 'u_reporter', target: 'poke_product' };
  const evaluation = { resolved: true, resolvedReason: 'fixed it', responseMode: 'reply', reply: 'cool' };

  await processConversationResponse(message, issue, 'iss1', evaluation);

  assert.equal(sent.length, 1, 'one resolution message sent');
  assert.match(sent[0].content, /Marked as resolved/);
  assert.equal(reactions.length, 0, 'no react when resolving');
});

test('non-reporter cannot trigger auto-resolve', async () => {
  const sent = [];
  const reactions = [];
  const message = {
    ...fakeMessage({ authorId: 'u_other' }),
    channel: { send: async (p) => { sent.push(p); } },
    react: async (e) => { reactions.push(e); },
    guild: { channels: { cache: { find: () => null } } },
  };
  const issue = { reporterId: 'u_reporter', target: 'poke_product' };
  const evaluation = { resolved: true, resolvedReason: 'x', responseMode: 'react' };

  await processConversationResponse(message, issue, 'iss1', evaluation);

  assert.equal(sent.length, 0, 'no resolution message when non-reporter');
  // Should fall through to react ✅ instead
  assert.equal(reactions.length, 1, 'react emitted when not resolving');
  assert.equal(reactions[0], '✅');
});

test('responseMode reply with canReply=false skips the send', async () => {
  const sent = [];
  const message = {
    ...fakeMessage({ authorId: 'u_reporter' }),
    channel: { send: async (p) => { sent.push(p); } },
    react: async () => {},
  };
  const issue = { reporterId: 'u_reporter', target: 'poke_product' };
  const evaluation = { resolved: false, responseMode: 'reply', reply: 'sup' };

  await processConversationResponse(message, issue, 'iss1', evaluation, { canReply: () => false });

  assert.equal(sent.length, 0, 'rate-limited reply was not sent');
});

test('responseMode ignore is silent', async () => {
  const sent = [];
  const reactions = [];
  const message = {
    ...fakeMessage({ authorId: 'u_other' }),
    channel: { send: async (p) => { sent.push(p); } },
    react: async (e) => { reactions.push(e); },
  };
  const issue = { reporterId: 'u_reporter' };
  const evaluation = { resolved: false, responseMode: 'ignore' };

  await processConversationResponse(message, issue, 'iss1', evaluation);

  assert.equal(sent.length, 0);
  assert.equal(reactions.length, 0);
});
