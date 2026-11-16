const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFirebaseCredentials } = require('../src/config/firebaseCredentials');
const { hasFirebaseConfig, describeMissingFirebase } = require('../src/config/featureGates');

const account = {
  project_id: 'test-project',
  client_email: 'test@example.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nexample\\n-----END PRIVATE KEY-----\\n',
};
const split = {
  FIREBASE_PROJECT_ID: account.project_id,
  FIREBASE_CLIENT_EMAIL: account.client_email,
  FIREBASE_PRIVATE_KEY: account.private_key,
};

test('Firebase accepts split, JSON, and base64 credentials with normalized newlines', () => {
  const json = JSON.stringify(account);
  for (const env of [split, { FIREBASE_SERVICE_ACCOUNT: json }, { FIREBASE_SERVICE_ACCOUNT: Buffer.from(json).toString('base64') }]) {
    const { credentials, missing } = parseFirebaseCredentials(env);
    assert.equal(credentials.projectId, account.project_id);
    assert.equal(credentials.clientEmail, account.client_email);
    assert.equal(credentials.privateKey, account.private_key.replace(/\\n/g, '\n'));
    assert.deepEqual(missing, []);
    assert.equal(hasFirebaseConfig(env), true);
    assert.deepEqual(describeMissingFirebase(env), []);
  }
});

test('Firebase bundled credentials take precedence, including invalid bundles', () => {
  const env = { ...split, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ ...account, project_id: 'preferred' }) };
  assert.equal(parseFirebaseCredentials(env).credentials.projectId, 'preferred');
  for (const value of ['invalid', 'null', '[]', '{}', JSON.stringify({ ...account, private_key: 'bad' }), JSON.stringify({ ...account, client_email: 42 })]) {
    const invalid = { ...split, FIREBASE_SERVICE_ACCOUNT: value };
    assert.equal(hasFirebaseConfig(invalid), false);
    assert.deepEqual(describeMissingFirebase(invalid), ['FIREBASE_SERVICE_ACCOUNT']);
  }
});

test('Firebase empty bundle falls back and missing split fields are described safely', () => {
  assert.equal(hasFirebaseConfig({ ...split, FIREBASE_SERVICE_ACCOUNT: '  ' }), true);
  assert.deepEqual(describeMissingFirebase({}), Object.keys(split));
  assert.deepEqual(describeMissingFirebase({ ...split, FIREBASE_PRIVATE_KEY: 'bad' }), ['FIREBASE_PRIVATE_KEY']);
  assert.equal(parseFirebaseCredentials({}).credentials, null);
});
