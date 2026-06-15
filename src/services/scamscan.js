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
};
