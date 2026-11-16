const { parseFirebaseCredentials, isFilled } = require('./firebaseCredentials');

function requireEnv(keys, env = process.env) {
  return keys.filter((key) => !isFilled(env[key]));
}

function hasFirebaseConfig(env = process.env) {
  return !!parseFirebaseCredentials(env).credentials;
}

function hasOpenRouterConfig(env = process.env) {
  return isFilled(env.OPENROUTER_API_KEY);
}

function hasDiscordConfig(env = process.env) {
  return requireEnv(['DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID'], env).length === 0;
}

function describeMissingFirebase(env = process.env) {
  return parseFirebaseCredentials(env).missing;
}

module.exports = {
  isFilled,
  requireEnv,
  hasFirebaseConfig,
  hasOpenRouterConfig,
  hasDiscordConfig,
  describeMissingFirebase,
};
