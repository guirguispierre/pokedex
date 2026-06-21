const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

function getDb() {
  return getFirestore();
}

const DOC = () => getDb().collection('config').doc('lockdown');

// --- Pure planners (unit-tested) ---

function planLockdown(channels, excludeIds = []) {
  const exclude = new Set(excludeIds);
  const toLock = [];
  const skipped = [];
  const excluded = [];
  for (const ch of channels) {
    if (exclude.has(ch.id)) { excluded.push(ch.id); continue; }
    if (ch.locked) { skipped.push(ch.id); continue; }
    toLock.push(ch.id);
  }
  return { toLock, skipped, excluded };
}

// `recorded` may be an array of channel-id strings or of { id, prior } records.
// Returns the items whose channel still exists in the guild, deduped by id keeping the
// FIRST occurrence — that record carries the true pre-lockdown prior, and deduping stops
// a channel that was recorded twice (re-locked with a changed overwrite) from being
// edited twice during /unlockall.
function planUnlock(recorded = [], existingChannelIds = []) {
  const existing = new Set(existingChannelIds);
  const seen = new Set();
  const out = [];
  for (const item of (recorded || [])) {
    const id = typeof item === 'string' ? item : item.id;
    if (!existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

// --- Per-channel-type lock semantics (pure, unit-tested) ---
// Text/announcement channels are locked by denying SendMessages. Forum channels accept
// new *threads/posts*, so they are locked by denying CreatePublicThreads (and posting
// inside existing threads via SendMessagesInThreads).

// The single permission flag whose deny state means "this channel is locked".
function primaryLockFlag(channelType) {
  return channelType === ChannelType.GuildForum
    ? PermissionFlagsBits.CreatePublicThreads
    : PermissionFlagsBits.SendMessages;
}

// Permission-overwrite payload that locks the channel for @everyone.
function lockOverwrite(channelType) {
  if (channelType === ChannelType.GuildForum) {
    return { CreatePublicThreads: false, SendMessagesInThreads: false };
  }
  return { SendMessages: false };
}

// Permission-overwrite payload that restores the channel, honouring its pre-lock state:
// `prior` of 'allow' restores an explicit allow; anything else clears back to inherit.
function unlockOverwrite(channelType, prior) {
  const primary = prior === 'allow' ? true : null;
  if (channelType === ChannelType.GuildForum) {
    return { CreatePublicThreads: primary, SendMessagesInThreads: null };
  }
  return { SendMessages: primary };
}

// --- Firestore state ---
// Read helpers swallow errors and return safe defaults (a failed read should not
// block a lockdown). Write helpers intentionally let Firestore errors propagate so
// the calling command can report the failure to the moderator.

async function getExcludedChannels() {
  try {
    const doc = await DOC().get();
    return doc.exists ? (doc.data().excludeChannelIds || []) : [];
  } catch {
    return [];
  }
}

async function addExcludedChannel(id) {
  await DOC().set(
    { excludeChannelIds: FieldValue.arrayUnion(id) },
    { merge: true },
  );
}

async function removeExcludedChannel(id) {
  await DOC().set(
    { excludeChannelIds: FieldValue.arrayRemove(id) },
    { merge: true },
  );
}

// Accumulates (unions) the newly-locked channels — each `{ id, prior }` capturing the
// channel's pre-lock @everyone state — into the active record rather than overwriting it.
// This protects the "only unlock what we locked" guarantee across repeated /lockall runs;
// clearLockdown() resets the list, so a fresh lockdown after /unlockall starts clean.
async function recordLockdown({ channels, lockedBy, reason }) {
  const data = {
    lockedBy,
    reason: reason || null,
    lockedAt: FieldValue.serverTimestamp(),
  };
  if (channels.length > 0) {
    data.lockedChannels = FieldValue.arrayUnion(...channels);
  }
  await DOC().set(data, { merge: true });
}

async function getLockdown() {
  try {
    const doc = await DOC().get();
    if (!doc.exists) return null;
    const data = doc.data();
    return { ...data, lockedChannels: data.lockedChannels || [] };
  } catch {
    return null;
  }
}

async function clearLockdown() {
  await DOC().set({ lockedChannels: [] }, { merge: true });
}

// Drop specific { id, prior } records (the ones /unlockall actually restored), leaving any
// that failed so the lockdown can be retried. No-op for an empty list.
async function removeLockedChannels(channels) {
  if (!channels || channels.length === 0) return;
  await DOC().set(
    { lockedChannels: FieldValue.arrayRemove(...channels) },
    { merge: true },
  );
}

// --- Concurrency guard ---
// A transactional, TTL'd busy flag so two moderators can't run /lockall and /unlockall
// against the same record at the same time. The TTL means a crashed command can't wedge
// the lock permanently.
async function acquireLock(ttlMs = 60000) {
  const ref = DOC();
  try {
    return await getDb().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const busyUntil = doc.exists ? (doc.data().busyUntil || 0) : 0;
      const now = Date.now();
      if (busyUntil > now) return false;
      tx.set(ref, { busyUntil: now + ttlMs }, { merge: true });
      return true;
    });
  } catch {
    // If the transaction backend is unavailable, don't block the operation.
    return true;
  }
}

async function releaseLock() {
  try {
    await DOC().set({ busyUntil: 0 }, { merge: true });
  } catch {
    // Best-effort; the TTL will expire the lock anyway.
  }
}

module.exports = {
  planLockdown,
  planUnlock,
  primaryLockFlag,
  lockOverwrite,
  unlockOverwrite,
  getExcludedChannels,
  addExcludedChannel,
  removeExcludedChannel,
  recordLockdown,
  getLockdown,
  clearLockdown,
  removeLockedChannels,
  acquireLock,
  releaseLock,
};
