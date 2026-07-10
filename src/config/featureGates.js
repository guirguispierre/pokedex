function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isFilled(value) {
  const v = clean(value);
  if (!v) return false;
  const normalized = v.toLowerCase();
  return ![
    'undefined',
    'null',
    'false',
    'changeme',
    'change_me',
    'your_token_here',
    'your_api_key_here',
  ].includes(normalized) && !normalized.startsWith('your_');
}

function requireEnv(keys, env = process.env) {
  return keys.filter((key) => !isFilled(env[key]));
}

function hasFirebaseConfig(env = process.env) {
  const missing = requireEnv(['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'], env);
  if (missing.length > 0) return false;
  const privateKey = clean(env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n');
  return privateKey.includes('BEGIN PRIVATE KEY') && privateKey.includes('END PRIVATE KEY');
}

function hasOpenRouterConfig(env = process.env) {
  return isFilled(env.OPENROUTER_API_KEY);
}

function hasDiscordConfig(env = process.env) {
  return requireEnv(['DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID'], env).length === 0;
}

function describeMissingFirebase(env = process.env) {
  const missing = requireEnv(['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'], env);
  if (missing.length > 0) return missing;
  if (!hasFirebaseConfig(env)) return ['FIREBASE_PRIVATE_KEY'];
  return [];
}

module.exports = {
  isFilled,
  requireEnv,
  hasFirebaseConfig,
  hasOpenRouterConfig,
  hasDiscordConfig,
  describeMissingFirebase,
};
