function isFilled(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const normalized = value.trim().toLowerCase();
  return !['undefined', 'null', 'false', 'changeme', 'change_me', 'your_token_here', 'your_api_key_here'].includes(normalized)
    && !normalized.startsWith('your_');
}

function parseFirebaseCredentials(env = process.env) {
  const bundled = !!env.FIREBASE_SERVICE_ACCOUNT?.trim();
  let credentials;
  if (bundled) {
    try {
      const value = env.FIREBASE_SERVICE_ACCOUNT.trim();
      const account = JSON.parse(value.startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8'));
      credentials = {
        projectId: account.project_id,
        clientEmail: account.client_email,
        privateKey: account.private_key,
      };
    } catch {
      return { credentials: null, missing: ['FIREBASE_SERVICE_ACCOUNT'] };
    }
  } else {
    credentials = {
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY,
    };
  }
  const names = { projectId: 'FIREBASE_PROJECT_ID', clientEmail: 'FIREBASE_CLIENT_EMAIL', privateKey: 'FIREBASE_PRIVATE_KEY' };
  const missing = Object.keys(names).filter(key => !isFilled(credentials[key])).map(key => names[key]);
  if (!missing.length) {
    credentials.privateKey = credentials.privateKey.replace(/\\n/g, '\n');
    if (!credentials.privateKey.includes('BEGIN PRIVATE KEY') || !credentials.privateKey.includes('END PRIVATE KEY')) {
      missing.push('FIREBASE_PRIVATE_KEY');
    }
  }
  if (missing.length) return { credentials: null, missing: bundled ? ['FIREBASE_SERVICE_ACCOUNT'] : missing };
  return { credentials, missing: [] };
}

module.exports = { parseFirebaseCredentials, isFilled };
