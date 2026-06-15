const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

// In-memory tracking for rate-based detection
const messageHistory = new Map(); // userId -> [{ content, timestamp }]
const joinHistory = []; // [{ userId, timestamp }]

// Defaults (overridden by Firestore config)
const DEFAULT_CONFIG = {
  enabled: false,
  logChannel: null,
  dmOnAction: false,
  // Spam thresholds
  maxMessagesPerWindow: 5,
  messageWindowMs: 3000,
  maxDuplicates: 3,
  duplicateWindowMs: 10000,
  maxMentionsPerMessage: 5,
  // Raid thresholds
  raidJoinCount: 10,
  raidJoinWindowMs: 10000,
  raidAutoKick: true,
  // Content filtering
  capsPercentThreshold: 70,
  capsMinLength: 10,
  blockInviteLinks: true,
  // Action escalation
  timeoutDurations: [300, 1800, 3600], // 5m, 30m, 1h (seconds)
};

let cachedConfig = null;
let configLoadedAt = 0;
const CONFIG_TTL = 30000; // 30s cache

// TTL caches for per-message Firestore lookups
let cachedExemptions = null;
let exemptionsLoadedAt = 0;
let cachedBlocklist = null;
let blocklistLoadedAt = 0;
let cachedLinkConfig = null;
let linkConfigLoadedAt = 0;

// --- Config ---

async function getAutomodConfig() {
  if (cachedConfig && Date.now() - configLoadedAt < CONFIG_TTL) {
    return cachedConfig;
  }
  try {
    const doc = await getDb().collection('automod').doc('config').get();
    cachedConfig = doc.exists ? { ...DEFAULT_CONFIG, ...doc.data() } : { ...DEFAULT_CONFIG };
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  configLoadedAt = Date.now();
  return cachedConfig;
}

async function updateAutomodConfig(updates) {
  await getDb().collection('automod').doc('config').set(updates, { merge: true });
  cachedConfig = null; // bust cache
}

// --- Blocklist ---

async function getBlocklist() {
  if (cachedBlocklist && Date.now() - blocklistLoadedAt < CONFIG_TTL) {
    return cachedBlocklist;
  }
  try {
    const doc = await getDb().collection('automod').doc('blocklist').get();
    cachedBlocklist = doc.exists ? (doc.data().words || []) : [];
  } catch {
    cachedBlocklist = [];
  }
  blocklistLoadedAt = Date.now();
  return cachedBlocklist;
}

async function addBlocklistWord(word) {
  await getDb().collection('automod').doc('blocklist').set(
    { words: admin.firestore.FieldValue.arrayUnion(word.toLowerCase()) },
    { merge: true },
  );
  cachedBlocklist = null; // bust cache
}

async function removeBlocklistWord(word) {
  await getDb().collection('automod').doc('blocklist').set(
    { words: admin.firestore.FieldValue.arrayRemove(word.toLowerCase()) },
    { merge: true },
  );
  cachedBlocklist = null; // bust cache
}

// --- Link allowlist/blocklist ---

async function getLinkConfig() {
  if (cachedLinkConfig && Date.now() - linkConfigLoadedAt < CONFIG_TTL) {
    return cachedLinkConfig;
  }
  try {
    const doc = await getDb().collection('automod').doc('links').get();
    cachedLinkConfig = doc.exists ? doc.data() : { allowed: [], blocked: [] };
  } catch {
    cachedLinkConfig = { allowed: [], blocked: [] };
  }
  linkConfigLoadedAt = Date.now();
  return cachedLinkConfig;
}

async function addLinkEntry(type, domain) {
  const field = type === 'allow' ? 'allowed' : 'blocked';
  await getDb().collection('automod').doc('links').set(
    { [field]: admin.firestore.FieldValue.arrayUnion(domain.toLowerCase()) },
    { merge: true },
  );
  cachedLinkConfig = null; // bust cache
}

async function removeLinkEntry(type, domain) {
  const field = type === 'allow' ? 'allowed' : 'blocked';
  await getDb().collection('automod').doc('links').set(
    { [field]: admin.firestore.FieldValue.arrayRemove(domain.toLowerCase()) },
    { merge: true },
  );
  cachedLinkConfig = null; // bust cache
}

// --- Exemptions ---

async function getExemptions() {
  if (cachedExemptions && Date.now() - exemptionsLoadedAt < CONFIG_TTL) {
    return cachedExemptions;
  }
  try {
    const doc = await getDb().collection('automod').doc('exemptions').get();
    cachedExemptions = doc.exists ? doc.data() : { roles: [], channels: [] };
  } catch {
    cachedExemptions = { roles: [], channels: [] };
  }
  exemptionsLoadedAt = Date.now();
  return cachedExemptions;
}

async function addExemption(type, id) {
  const field = type === 'role' ? 'roles' : 'channels';
  await getDb().collection('automod').doc('exemptions').set(
    { [field]: admin.firestore.FieldValue.arrayUnion(id) },
    { merge: true },
  );
  cachedExemptions = null; // bust cache
}

async function removeExemption(type, id) {
  const field = type === 'role' ? 'roles' : 'channels';
  await getDb().collection('automod').doc('exemptions').set(
    { [field]: admin.firestore.FieldValue.arrayRemove(id) },
    { merge: true },
  );
  cachedExemptions = null; // bust cache
}

// --- Offense tracking ---

async function getOffenseCount(userId, guildId) {
  const snapshot = await getDb().collection('infractions')
    .where('guildId', '==', guildId)
    .where('userId', '==', userId)
    .where('type', '==', 'automod')
    .get();
  return snapshot.size;
}

async function recordOffense(userId, username, guildId, reason, action) {
  await getDb().collection('infractions').add({
    type: 'automod',
    userId,
    username,
    guildId,
    reason,
    action,
    moderatorId: 'automod',
    moderatorName: 'AutoMod',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// --- Detection checks ---

function checkMessageFlood(userId, content) {
  const now = Date.now();
  if (!messageHistory.has(userId)) {
    messageHistory.set(userId, []);
  }
  const history = messageHistory.get(userId);
  history.push({ content, timestamp: now });

  // Prune old entries (keep last 30s)
  const cutoff = now - 30000;
  const pruned = history.filter(m => m.timestamp > cutoff);
  messageHistory.set(userId, pruned);

  return pruned;
}

function isSpamming(history, config) {
  const now = Date.now();
  const windowStart = now - config.messageWindowMs;
  const recent = history.filter(m => m.timestamp > windowStart);
  return recent.length >= config.maxMessagesPerWindow;
}

function isDuplicateSpam(history, config) {
  const now = Date.now();
  const windowStart = now - config.duplicateWindowMs;
  const recent = history.filter(m => m.timestamp > windowStart);
  if (recent.length < config.maxDuplicates) return false;

  // Check if the last N messages are identical
  const lastContent = recent[recent.length - 1].content;
  const dupes = recent.filter(m => m.content === lastContent);
  return dupes.length >= config.maxDuplicates;
}

function isMentionSpam(message, config) {
  const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
  return mentionCount >= config.maxMentionsPerMessage;
}

function isExcessiveCaps(content, config) {
  if (content.length < config.capsMinLength) return false;
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return false;
  const upperCount = letters.replace(/[^A-Z]/g, '').length;
  return (upperCount / letters.length) * 100 >= config.capsPercentThreshold;
}

function containsBlockedWord(content, blocklist) {
  const lower = content.toLowerCase();
  return blocklist.find(word => lower.includes(word)) || null;
}

function containsBlockedLink(content, linkConfig) {
  // Extract URLs from the message
  const urlRegex = /https?:\/\/[^\s<]+/gi;
  const urls = content.match(urlRegex) || [];
  if (urls.length === 0) return null;

  for (const url of urls) {
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }

    // Check blocklist first (exact domain or subdomain match)
    if (linkConfig.blocked.some(d => hostname === d || hostname.endsWith('.' + d))) {
      return hostname;
    }

    // If allowlist has entries, only those are permitted
    if (linkConfig.allowed.length > 0) {
      if (!linkConfig.allowed.some(d => hostname === d || hostname.endsWith('.' + d))) {
        return hostname;
      }
    }
  }
  return null;
}

function containsDiscordInvite(content) {
  return /discord\.(gg|com\/invite)\/[a-zA-Z0-9]+/i.test(content);
}

// --- Raid detection ---

function trackJoin(userId) {
  const now = Date.now();
  joinHistory.push({ userId, timestamp: now });

  // Prune old entries
  const cutoff = now - 60000;
  while (joinHistory.length > 0 && joinHistory[0].timestamp < cutoff) {
    joinHistory.shift();
  }
}

function isRaid(config) {
  const now = Date.now();
  const windowStart = now - config.raidJoinWindowMs;
  const recentJoins = joinHistory.filter(j => j.timestamp > windowStart);
  return recentJoins.length >= config.raidJoinCount;
}

// --- Logging ---

async function logAction(guild, config, { userId, username, action, reason, evidence, channelId }) {
  if (!config.logChannel) return;

  const logChannel = guild.channels.cache.find(
    ch => ch.name === config.logChannel || ch.id === config.logChannel,
  );
  if (!logChannel) return;

  const { EmbedBuilder } = require('discord.js');
  const colors = {
    delete: 0xffa500,
    warn: 0xffd700,
    timeout: 0xe74c3c,
    kick: 0xff0000,
    raid_alert: 0x8b0000,
  };

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ AutoMod — ${action.charAt(0).toUpperCase() + action.slice(1)}`)
    .setColor(colors[action] || 0x95a5a6)
    .addFields(
      { name: 'User', value: `<@${userId}> (${username})`, inline: true },
      { name: 'Action', value: action, inline: true },
      { name: 'Reason', value: reason },
    )
    .setTimestamp();

  if (evidence) {
    embed.addFields({ name: 'Evidence', value: evidence.slice(0, 1024) });
  }
  if (channelId) {
    embed.addFields({ name: 'Channel', value: `<#${channelId}>`, inline: true });
  }

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('AutoMod: failed to send log:', err.message);
  }
}

async function dmUser(user, guild, reason) {
  try {
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle(`🛡️ AutoMod Action in ${guild.name}`)
      .setColor(0xffa500)
      .setDescription(`Your message was removed for: **${reason}**`)
      .setFooter({ text: 'Repeated violations may result in a timeout.' })
      .setTimestamp();
    await user.send({ embeds: [embed] });
  } catch {
    // Can't DM user — that's fine
  }
}

// --- Main handler ---

async function handleMessage(message) {
  if (message.author.bot || !message.guild) return null;

  const config = await getAutomodConfig();
  if (!config.enabled) return null;

  // Check exemptions
  const exemptions = await getExemptions();
  if (exemptions.channels.includes(message.channel.id)) return null;
  if (message.member && exemptions.roles.some(r => message.member.roles.cache.has(r))) return null;

  // Skip users with Manage Messages permission (mods)
  if (message.member?.permissions?.has('ManageMessages')) return null;

  const content = message.content;
  const userId = message.author.id;
  const username = message.author.username;
  const guildId = message.guild.id;

  // Track message for rate-based checks
  const history = checkMessageFlood(userId, content);

  // --- Check 1: Message flood ---
  if (isSpamming(history, config)) {
    return await takeAction(message, config, {
      userId, username, guildId,
      reason: 'Message flood detected',
      evidence: `Sent ${config.maxMessagesPerWindow}+ messages in ${config.messageWindowMs / 1000}s`,
    });
  }

  // --- Check 2: Duplicate spam ---
  if (isDuplicateSpam(history, config)) {
    return await takeAction(message, config, {
      userId, username, guildId,
      reason: 'Duplicate message spam',
      evidence: `Repeated same message ${config.maxDuplicates}+ times`,
    });
  }

  // --- Check 3: Mention spam ---
  if (isMentionSpam(message, config)) {
    return await takeAction(message, config, {
      userId, username, guildId,
      reason: 'Mention spam',
      evidence: `${message.mentions.users.size + message.mentions.roles.size} mentions in one message`,
    });
  }

  // --- Check 4: Blocked words ---
  const blocklist = await getBlocklist();
  const blockedWord = containsBlockedWord(content, blocklist);
  if (blockedWord) {
    return await takeAction(message, config, {
      userId, username, guildId,
      reason: 'Blocked word/phrase',
      evidence: `Matched: "${blockedWord}"`,
    });
  }

  // --- Check 5: Discord invite links ---
  if (config.blockInviteLinks && containsDiscordInvite(content)) {
    return await takeAction(message, config, {
      userId, username, guildId,
      reason: 'Discord invite link',
      evidence: 'Posted a Discord server invite',
    });
  }

  // --- Check 6: Blocked links ---
  const linkConfig = await getLinkConfig();
  const blockedDomain = containsBlockedLink(content, linkConfig);
  if (blockedDomain) {
    return await takeAction(message, config, {
      userId, username, guildId,
      reason: 'Blocked link',
      evidence: `Domain: ${blockedDomain}`,
    });
  }

  // --- Check 7: Excessive caps ---
  if (isExcessiveCaps(content, config)) {
    // Caps is a softer offense — just delete, don't escalate
    try {
      await message.delete();
    } catch {
      // Missing permissions
    }
    await logAction(message.guild, config, {
      userId, username, action: 'delete', reason: 'Excessive caps', channelId: message.channel.id,
    });
    if (config.dmOnAction) {
      await dmUser(message.author, message.guild, 'Excessive caps');
    }
    return 'caps';
  }

  return null;
}

async function takeAction(message, config, { userId, username, guildId, reason, evidence }) {
  // Delete the offending message
  try {
    await message.delete();
  } catch {
    // Missing permissions
  }

  // Determine escalation level based on offense count
  const offenseCount = await getOffenseCount(userId, guildId);
  let action = 'warn';

  if (offenseCount >= config.timeoutDurations.length) {
    // Max escalation — longest timeout
    action = 'timeout';
    const duration = config.timeoutDurations[config.timeoutDurations.length - 1];
    try {
      await message.member?.timeout(duration * 1000, `AutoMod: ${reason}`);
    } catch {
      // Missing permissions
    }
  } else if (offenseCount > 0) {
    // Escalating timeouts
    action = 'timeout';
    const duration = config.timeoutDurations[Math.min(offenseCount - 1, config.timeoutDurations.length - 1)];
    try {
      await message.member?.timeout(duration * 1000, `AutoMod: ${reason}`);
    } catch {
      // Missing permissions
    }
  }

  // Record the offense (integrates with /warn system)
  await recordOffense(userId, username, guildId, reason, action);

  // Log to mod channel
  await logAction(message.guild, config, {
    userId, username, action, reason, evidence, channelId: message.channel.id,
  });

  // DM user if enabled
  if (config.dmOnAction) {
    await dmUser(message.author, message.guild, reason);
  }

  return action;
}

// --- Raid handler (call from guildMemberAdd) ---

async function handleJoin(member) {
  const config = await getAutomodConfig();
  if (!config.enabled) return;

  trackJoin(member.id);

  if (isRaid(config)) {
    // Alert mods
    await logAction(member.guild, config, {
      userId: member.id,
      username: member.user.username,
      action: 'raid_alert',
      reason: 'Potential raid detected',
      evidence: `${config.raidJoinCount}+ joins in ${config.raidJoinWindowMs / 1000}s`,
    });

    // Auto-kick if enabled
    if (config.raidAutoKick) {
      try {
        await member.kick('AutoMod: Raid protection');
      } catch {
        // Missing permissions
      }
    }
  }
}

// Cleanup stale message history every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [userId, history] of messageHistory) {
    const fresh = history.filter(m => m.timestamp > cutoff);
    if (fresh.length === 0) {
      messageHistory.delete(userId);
    } else {
      messageHistory.set(userId, fresh);
    }
  }
}, 300000);

module.exports = {
  handleMessage,
  handleJoin,
  getAutomodConfig,
  updateAutomodConfig,
  getBlocklist,
  addBlocklistWord,
  removeBlocklistWord,
  getLinkConfig,
  addLinkEntry,
  removeLinkEntry,
  getExemptions,
  addExemption,
  removeExemption,
  DEFAULT_CONFIG,
};
