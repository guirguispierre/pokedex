const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('firestore local disabled mode', () => {
  test('does not require Firebase env for local no-op reads/writes', async () => {
    const saved = { ...process.env };
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;

    delete require.cache[require.resolve('../src/services/firestore')];
    const firestore = require('../src/services/firestore');

    try {
      firestore.init();
      assert.equal(firestore.isEnabled(), false);
      assert.deepEqual(await firestore.getAllConfigOverrides(), {});
      assert.deepEqual(await firestore.getOpenIssues(), []);
      assert.match(await firestore.saveIssue({ summary: 'local' }), /^local-/);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
      delete require.cache[require.resolve('../src/services/firestore')];
    }
  });
});
