const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  hasDiscordConfig,
  hasFirebaseConfig,
  hasOpenRouterConfig,
  requireEnv,
} = require('../src/config/featureGates');

describe('feature gates', () => {
  test('treats blank and placeholder env values as missing', () => {
    assert.deepEqual(requireEnv(['A', 'B', 'C'], { A: '', B: 'your_token_here', C: 'ok' }), ['A', 'B']);
  });

  test('requires syntactically valid Firebase service account fields', () => {
    assert.equal(hasFirebaseConfig({}), false);
    assert.equal(hasFirebaseConfig({
      FIREBASE_PROJECT_ID: 'project',
      FIREBASE_CLIENT_EMAIL: 'bot@example.com',
      FIREBASE_PRIVATE_KEY: 'not a private key',
    }), false);
    assert.equal(hasFirebaseConfig({
      FIREBASE_PROJECT_ID: 'project',
      FIREBASE_CLIENT_EMAIL: 'bot@example.com',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    }), true);
  });

  test('gates OpenRouter and Discord by required env presence', () => {
    assert.equal(hasOpenRouterConfig({ OPENROUTER_API_KEY: '' }), false);
    assert.equal(hasOpenRouterConfig({ OPENROUTER_API_KEY: 'sk-or-v1-test' }), true);
    assert.equal(hasDiscordConfig({ DISCORD_TOKEN: 't', DISCORD_APP_ID: 'a' }), false);
    assert.equal(hasDiscordConfig({ DISCORD_TOKEN: 't', DISCORD_APP_ID: 'a', DISCORD_GUILD_ID: 'g' }), true);
  });
});
