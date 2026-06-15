const admin = require('firebase-admin');
const phash = require('./phash');
const { callWithTools } = require('./openrouter');

function getDb() {
  return admin.firestore();
}

// Single-guild bot (DISCORD_GUILD_ID is required), so the scam-scan config doc
// (automod/scamscan) and the scamHashes collection are global, not per-guild.
const CONFIG_DOC = () => getDb().collection('automod').doc('scamscan');
const HASHES = () => getDb().collection('scamHashes');

const DAY = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  scamScanEnabled: false,            // master block flag — feature off by default
  monitorChannelIds: [],             // watched channels; empty = effectively off
  reviewChannelId: null,             // EVERY scan logged here
  adminChannelId: null,              // confirmed-scam alerts
  exemptRoleIds: [],                 // mods/admins skip scanning
  visionModel: 'openai/gpt-4o-mini', // vision-capable; not hardcoded at call site
  joinWindowMs: 3 * DAY,             // new-member window
  muteMs: 7 * DAY,                   // confirmed-scam mute duration
  threshold: 0.8,                    // act at/above this confidence
  hammingThreshold: 10,              // dHash match distance (0..64)
  hashTtlMs: 30 * DAY,               // known-scam hash lifetime
  minDimension: 64,                  // ignore tiny images (px)
  maxAttachments: 4,                 // cap scans per message
  dmOnAction: false,                 // gated DM, like automod's dmOnAction
};

let cachedConfig = null;
let configLoadedAt = 0;
const CONFIG_TTL = 30000; // 30s cache, matching automod

async function getScamScanConfig() {
  if (cachedConfig && Date.now() - configLoadedAt < CONFIG_TTL) {
    return cachedConfig;
  }
  try {
    const doc = await CONFIG_DOC().get();
    cachedConfig = doc.exists ? { ...DEFAULT_CONFIG, ...doc.data() } : { ...DEFAULT_CONFIG };
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  configLoadedAt = Date.now();
  return cachedConfig;
}

async function updateScamScanConfig(updates) {
  await CONFIG_DOC().set(updates, { merge: true });
  cachedConfig = null; // bust cache
}

// arrayUnion/arrayRemove for monitorChannelIds and exemptRoleIds.
async function addConfigArrayItem(field, id) {
  await CONFIG_DOC().set(
    { [field]: admin.firestore.FieldValue.arrayUnion(id) },
    { merge: true },
  );
  cachedConfig = null;
}

async function removeConfigArrayItem(field, id) {
  await CONFIG_DOC().set(
    { [field]: admin.firestore.FieldValue.arrayRemove(id) },
    { merge: true },
  );
  cachedConfig = null;
}

// --- Known-scam hash store (scamHashes collection, global/single-guild) ---

// Returns non-expired records as { id, ...data }. The scam-hash set is small, so
// an in-memory Hamming compare against all of them is cheap.
async function getKnownScamHashes(now) {
  try {
    const snap = await HASHES().where('expiresAt', '>', now).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    return [];
  }
}

async function recordScamHash({ hash, category, reason, confidence, channelId, userId, expiresAt }) {
  await HASHES().add({
    hash,
    category: category || 'unknown',
    reason: reason || '',
    confidence: typeof confidence === 'number' ? confidence : null,
    seenChannels: channelId ? [channelId] : [],
    firstUserId: userId || null,
    expiresAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function addHashSeenChannel(docId, channelId) {
  await HASHES().doc(docId).set(
    { seenChannels: admin.firestore.FieldValue.arrayUnion(channelId) },
    { merge: true },
  );
}

// --- Pure planners (unit-tested) ---

function isNewMember(member, now, windowMs) {
  const joined = member && member.joinedTimestamp;
  if (!joined) return false;
  return now - joined < windowMs;
}

function isExemptRole(member, exemptRoleIds = []) {
  if (!member || !member.roles || !member.roles.cache) return false;
  return exemptRoleIds.some(id => member.roles.cache.has(id));
}

// `attachments` may be an array or a discord.js Collection.
function selectScannableAttachments(attachments, { minDimension, maxAttachments }) {
  const list = Array.isArray(attachments)
    ? attachments
    : Array.from((attachments && attachments.values && attachments.values()) || []);
  const scannable = list.filter(a =>
    a && typeof a.contentType === 'string' && a.contentType.startsWith('image/') &&
    Number.isFinite(a.width) && Number.isFinite(a.height) &&
    a.width >= minDimension && a.height >= minDimension);
  return scannable.slice(0, maxAttachments);
}

// Defensive parse of the vision model's JSON verdict (mirrors normalizeEvaluation).
function parseVerdict(raw) {
  const fail = { isScam: false, confidence: 0, category: 'unknown', reason: 'unparseable', parseFailed: true };
  if (typeof raw !== 'string') return fail;
  let content = raw.trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  let parsed;
  try { parsed = JSON.parse(content); } catch { return fail; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail;
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    isScam: parsed.isScam === true,
    confidence,
    category: typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category : 'unknown',
    reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason : '',
    parseFailed: false,
  };
}

function matchKnownScam(hash, knownHashes = [], maxDistance) {
  for (const rec of knownHashes) {
    if (rec && phash.isHashMatch(hash, rec.hash, maxDistance)) return rec;
  }
  return null;
}

// Decide what to do. Known-scam repost is the cheap path: act regardless of any
// (absent) verdict and do NOT re-record the hash. Otherwise gate on confidence.
function planAction(verdict, { threshold }, opts = {}) {
  if (opts.matchedKnownScam) {
    return { action: 'scam', delete: true, mute: true, recordHash: false, alert: true };
  }
  const scam = !!(verdict && verdict.isScam && verdict.confidence >= threshold);
  if (scam) {
    return { action: 'scam', delete: true, mute: true, recordHash: true, alert: true };
  }
  return { action: 'none', delete: false, mute: false, recordHash: false, alert: false };
}

// --- Vision scan (paid path) ---

const SCAM_SCAN_SYSTEM_PROMPT = `You are an image-safety classifier for a Discord community for poke.com.
Look at the attached image and decide whether it is a SCAM image — e.g. fake crypto/NFT airdrops or giveaways, free-Nitro/gift-card bait, phishing or wallet-drainer screenshots, impersonation of staff or brands, "double your money" schemes, or fake login/QR pages.
Ordinary memes, screenshots, photos, art, and product images are NOT scams.
Return ONLY strict JSON, no prose, no code fences:
{"isScam": boolean, "confidence": number between 0 and 1, "category": string, "reason": string}`;

// Throws on API error/timeout — the caller fails open.
async function scanImage(imageUrl, config) {
  const res = await callWithTools({
    messages: [
      { role: 'system', content: SCAM_SCAN_SYSTEM_PROMPT },
      { role: 'user', content: 'Analyze the attached image and decide if it is a scam.' },
    ],
    images: [imageUrl],
    model: config.visionModel,
  });
  return parseVerdict(res.content);
}

// --- Image decode (sharp lazy-required so planner tests never load the binary) ---

async function fetchImageBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch image failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function computeImageHash(buffer) {
  const sharp = require('sharp');
  const { data, info } = await sharp(buffer)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // grayscale().raw() may emit info.channels bytes/pixel (b-w keeps R=G=B); take
  // the first channel of each pixel to get the 72 grayscale values.
  const pixels = [];
  for (let i = 0; i < data.length; i += info.channels) pixels.push(data[i]);
  return phash.dhashFromGrayscale(pixels);
}

// --- Logging / alerts ---

function resolveChannel(guild, idOrNull) {
  if (!idOrNull) return null;
  return guild.channels.cache.get(idOrNull) || null;
}

// Posts to the review channel for EVERY scan and every decode/scan failure.
async function logScan(guild, config, { userId, username, channelId, imageUrl, verdict, acted, error }) {
  const channel = resolveChannel(guild, config.reviewChannelId);
  if (!channel) return;
  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder()
    .setTitle('🔍 Scam Scan')
    .setColor(error ? 0x95a5a6 : acted ? 0xe74c3c : 0x2ecc71)
    .addFields(
      { name: 'User', value: `<@${userId}> (${username})`, inline: true },
      { name: 'Channel', value: `<#${channelId}>`, inline: true },
      { name: 'Acted', value: acted ? 'Yes — removed & muted' : 'No', inline: true },
    )
    .setTimestamp();
  if (error) {
    embed.addFields({ name: 'Scan error (failed open)', value: String(error).slice(0, 1024) });
  } else if (verdict) {
    embed.addFields({ name: 'Verdict', value: '```json\n' + JSON.stringify(verdict).slice(0, 1000) + '\n```' });
  }
  if (imageUrl) embed.setImage(imageUrl);
  try { await channel.send({ embeds: [embed] }); } catch (err) { console.error('scamscan: review log failed:', err.message); }
}

async function alertAdmins(guild, config, { userId, username, channelId, category, reason, confidence, imageUrl, seenChannels }) {
  const channel = resolveChannel(guild, config.adminChannelId);
  if (!channel) return;
  const { EmbedBuilder } = require('discord.js');
  const seen = (seenChannels || []).map(c => `<#${c}>`).join(', ') || `<#${channelId}>`;
  const embed = new EmbedBuilder()
    .setTitle('🚨 Scam image removed')
    .setColor(0x8b0000)
    .addFields(
      { name: 'User', value: `<@${userId}> (${username})`, inline: true },
      { name: 'Posted in', value: `<#${channelId}>`, inline: true },
      { name: 'Category', value: category || 'unknown', inline: true },
      { name: 'Confidence', value: confidence != null ? `${Math.round(confidence * 100)}%` : 'n/a (repost)', inline: true },
      { name: 'Reason', value: (reason || 'n/a').slice(0, 1024) },
      { name: 'Seen in channels', value: seen.slice(0, 1024) },
    )
    .setTimestamp();
  if (imageUrl) embed.setImage(imageUrl);
  try { await channel.send({ embeds: [embed] }); } catch (err) { console.error('scamscan: admin alert failed:', err.message); }
}

async function dmUser(user, guild, reason) {
  try {
    const { EmbedBuilder } = require('discord.js');
    await user.send({ embeds: [new EmbedBuilder()
      .setTitle(`🚫 Your image was removed in ${guild.name}`)
      .setColor(0xe74c3c)
      .setDescription(`It was flagged as a scam: **${reason || 'scam image'}**. If this was a mistake, contact the moderators.`)
      .setTimestamp()] });
  } catch {
    // Can't DM — fine.
  }
}

// --- Action + main handler ---

const { applyTimeout } = require('../commands/mute');

// Executes a 'scam' plan: delete, mute, record/extend hash, alert, optional DM,
// review log. Each side effect is independently guarded so one failure (e.g. the
// message was already deleted) does not abort the rest.
async function takeAction(message, config, member, plan, ctx) {
  const { userId, username, channelId, imageUrl, hash, verdict, matchedKnownScam } = ctx;

  try { await message.delete(); } catch { /* already gone / no perms */ }

  if (plan.mute) {
    try { await applyTimeout(member, config.muteMs, `Scam image: ${ctx.reason || 'flagged'}`); }
    catch (err) { console.error('scamscan: mute failed:', err.message); }
  }

  let seenChannels = [channelId];
  if (matchedKnownScam) {
    try { await addHashSeenChannel(matchedKnownScam.id, channelId); } catch (err) { console.error('scamscan: seen-channel update failed:', err.message); }
    seenChannels = Array.from(new Set([...(matchedKnownScam.seenChannels || []), channelId]));
  } else if (plan.recordHash) {
    try {
      await recordScamHash({
        hash, category: ctx.category, reason: ctx.reason,
        confidence: verdict ? verdict.confidence : null,
        channelId, userId, expiresAt: Date.now() + config.hashTtlMs,
      });
    } catch (err) { console.error('scamscan: hash record failed:', err.message); }
  }

  if (plan.alert) {
    await alertAdmins(message.guild, config, {
      userId, username, channelId,
      category: ctx.category, reason: ctx.reason,
      confidence: verdict ? verdict.confidence : null,
      imageUrl, seenChannels,
    });
  }

  if (config.dmOnAction) await dmUser(message.author, message.guild, ctx.reason);

  await logScan(message.guild, config, { userId, username, channelId, imageUrl, verdict: verdict || { repost: true, category: ctx.category }, acted: true });

  return 'scam';
}

async function handleMessage(message) {
  if (message.author.bot || !message.guild) return null;
  if (!message.attachments || message.attachments.size === 0) return null;

  const config = await getScamScanConfig();
  if (!config.scamScanEnabled) return null;
  if (!config.monitorChannelIds.includes(message.channel.id)) return null;

  const scannable = selectScannableAttachments(message.attachments, {
    minDimension: config.minDimension,
    maxAttachments: config.maxAttachments,
  });
  if (scannable.length === 0) return null;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (isExemptRole(member, config.exemptRoleIds)) return null;

  const now = Date.now();
  const newMember = isNewMember(member, now, config.joinWindowMs);
  const known = await getKnownScamHashes(now);

  // Nothing the cheap path can match and the paid path only runs for new members.
  if (known.length === 0 && !newMember) return null;

  const userId = message.author.id;
  const username = message.author.username;
  const channelId = message.channel.id;

  for (const att of scannable) {
    const imageUrl = att.url;

    // Decode for the perceptual hash. Decode failure -> log, skip this image.
    let hash;
    try {
      hash = await computeImageHash(await fetchImageBytes(imageUrl));
    } catch (err) {
      await logScan(message.guild, config, { userId, username, channelId, imageUrl, error: `decode: ${err.message}` });
      continue;
    }

    // Repost short-circuit (applies to everyone) — no API call.
    const matchedKnownScam = matchKnownScam(hash, known, config.hammingThreshold);
    if (matchedKnownScam) {
      const plan = planAction(null, { threshold: config.threshold }, { matchedKnownScam });
      return await takeAction(message, config, member, plan, {
        userId, username, channelId, imageUrl, hash,
        verdict: null, matchedKnownScam,
        category: matchedKnownScam.category, reason: matchedKnownScam.reason || 'known scam image (repost)',
      });
    }

    // Paid path: new members only.
    if (!newMember) continue;

    let verdict;
    try {
      verdict = await scanImage(imageUrl, config);
    } catch (err) {
      // Fail open — never mute/delete on API error.
      await logScan(message.guild, config, { userId, username, channelId, imageUrl, error: `scan: ${err.message}` });
      continue;
    }

    const plan = planAction(verdict, { threshold: config.threshold }, {});
    if (plan.action !== 'scam') {
      await logScan(message.guild, config, { userId, username, channelId, imageUrl, verdict, acted: false });
      continue;
    }

    return await takeAction(message, config, member, plan, {
      userId, username, channelId, imageUrl, hash,
      verdict, matchedKnownScam: null,
      category: verdict.category, reason: verdict.reason || 'scam image',
    });
  }

  return null;
}

module.exports = {
  DEFAULT_CONFIG,
  getScamScanConfig,
  updateScamScanConfig,
  addConfigArrayItem,
  removeConfigArrayItem,
  getKnownScamHashes,
  recordScamHash,
  addHashSeenChannel,
  isNewMember,
  isExemptRole,
  selectScannableAttachments,
  parseVerdict,
  matchKnownScam,
  planAction,
  scanImage,
  computeImageHash,
  handleMessage,
};
