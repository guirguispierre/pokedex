// Recovers XP for messages sent while the bot was offline (/xp-reindex).
//
// The live awardXP path (src/commands/level.js) only sees messages while the bot
// is connected, and it awards at most one XP grant per user per cooldown window.
// This module replays that same cooldown over the Discord message history that
// the bot missed.
//
// Idempotency: each level doc stores `lastXPAt` (ms of its last award). Replaying
// from that anchor and recording the new last award means a second run finds no
// messages outside the cooldown, so it awards nothing.
//
// Cutoff: messages at or after `cutoffMs` (the current process start) are left to
// the live path, so nothing is counted twice.

const { dayKeyUTC } = require('../utils/xpChart');

const PAGE_SIZE = 100;
const APPLY_CONCURRENCY = 8;
const LEVELS = 'levels';

function readLastXPAt(doc) {
  if (!doc) return null;
  if (typeof doc.lastXPAt === 'number' && Number.isFinite(doc.lastXPAt)) return doc.lastXPAt;
  // Docs written before lastXPAt existed: updatedAt is only set by awardXP, so it is the last award.
  if (doc.updatedAt && typeof doc.updatedAt.toMillis === 'function') return doc.updatedAt.toMillis();
  return null;
}

// Largest last-award time that predates the cutoff. This marks the start of the
// most recent downtime, and it is the default scan start.
function computeFloor(docs, cutoffMs) {
  let floor = null;
  for (const doc of docs) {
    const t = readLastXPAt(doc);
    if (t != null && t < cutoffMs && (floor == null || t > floor)) floor = t;
  }
  return floor;
}

// Replays the live cooldown: a message awards XP only if it is at least
// cooldownMs after the previous award. Timestamps are ms.
function replayAwards({ anchorMs, timestamps, cooldownMs, minGain, maxGain, rng = Math.random }) {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const awards = [];
  let last = anchorMs == null ? -Infinity : anchorMs;
  for (const ts of sorted) {
    if (ts - last < cooldownMs) continue;
    const gain = Math.floor(rng() * (maxGain - minGain + 1)) + minGain;
    awards.push({ ts, gain });
    last = ts;
  }
  return {
    awards,
    lastAwardMs: awards.length ? awards[awards.length - 1].ts : null,
  };
}

// Decides how far back one user's messages count and where the cooldown starts.
//
// - Exact: the doc's last award predates the cutoff, so it is the true cooldown
//   anchor and the window starts right after it.
// - Approximate: the last award is after the cutoff (the live path already handled
//   this user since boot), so the true pre-boot anchor is gone. Use the downtime
//   floor instead. This can be off by at most one award, for messages in the 60s
//   right after the floor.
function planUserReplay({
  doc, cutoffMs, scanFromMs, floorMs, timestamps,
  cooldownMs, minGain, maxGain, rng,
}) {
  const last = readLastXPAt(doc);
  const exact = last != null && last < cutoffMs;
  const base = exact ? last : floorMs;
  const effective = Math.max(base ?? -Infinity, scanFromMs ?? -Infinity);
  const anchorMs = Number.isFinite(effective) ? effective : null;

  const window = timestamps.filter(ts => ts > effective && ts < cutoffMs);
  const { awards, lastAwardMs } = replayAwards({
    anchorMs, timestamps: window, cooldownMs, minGain, maxGain, rng,
  });
  return { exact, anchorMs, awards, lastAwardMs };
}

// Builds the Firestore update for one user's plan. Returns null when nothing is awarded.
// xpByDay is only rewritten for exact plans, where the doc's current xp equals the
// total at the anchor. For approximate plans it would be inflated by post-boot XP.
function buildLevelUpdate({ plan, doc, userId, guildId, username }) {
  if (!plan.awards.length) return null;
  const oldXP = doc?.xp || 0;
  const gained = plan.awards.reduce((sum, a) => sum + a.gain, 0);
  const update = {
    userId,
    guildId,
    xp: oldXP + gained,
    messages: (doc?.messages || 0) + plan.awards.length,
    lastXPAt: plan.lastAwardMs,
  };
  if (username) update.username = username;
  if (plan.exact) {
    let running = oldXP;
    const xpByDay = {};
    for (const a of plan.awards) {
      running += a.gain;
      xpByDay[dayKeyUTC(a.ts)] = running;
    }
    update.xpByDay = xpByDay;
  }
  return update;
}

// Reads message history from every source, keeping only non-bot messages in
// [sinceMs, cutoffMs). Each source has fetchPage(beforeId) returning up to
// PAGE_SIZE messages, newest first, as { id, createdTimestamp, authorId, authorIsBot, authorName }.
async function scanGuildMessages({ sources, sinceMs, cutoffMs, deadlineMs, now = Date.now, onProgress }) {
  const byUser = new Map();
  const stats = { sources: sources.length, scannedSources: 0, skippedSources: 0, messagesInWindow: 0, aborted: false };

  for (const source of sources) {
    if (now() > deadlineMs) {
      stats.aborted = true;
      break;
    }
    let before;
    let done = false;
    try {
      while (!done) {
        const page = await source.fetchPage(before);
        for (const m of page) {
          if (m.createdTimestamp < sinceMs) { done = true; break; }
          if (m.createdTimestamp >= cutoffMs || m.authorIsBot || !m.authorId) continue;
          stats.messagesInWindow += 1;
          let entry = byUser.get(m.authorId);
          if (!entry) {
            entry = { timestamps: [], username: m.authorName };
            byUser.set(m.authorId, entry);
          }
          entry.timestamps.push(m.createdTimestamp);
          entry.username = m.authorName || entry.username;
        }
        if (!page.length) break;
        before = page[page.length - 1].id;
        if (page.length < PAGE_SIZE) break;
      }
      stats.scannedSources += 1;
    } catch {
      // No access, or the channel was deleted mid-scan. Count it and move on.
      stats.skippedSources += 1;
    }
    if (onProgress) onProgress({ ...stats });
  }
  return { byUser, stats };
}

function parseSince(input, nowMs) {
  const s = String(input || '').trim();
  const m = /^(\d+)\s*([hd])$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    return nowMs - n * (m[2].toLowerCase() === 'h' ? 3600e3 : 86400e3);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

async function fetchDocsForUsers(db, guildId, userIds) {
  const refs = userIds.map(id => db.collection(LEVELS).doc(`${guildId}_${id}`));
  const out = new Map();
  for (let i = 0; i < refs.length; i += 300) {
    const chunk = refs.slice(i, i + 300);
    const snaps = await db.getAll(...chunk);
    snaps.forEach((snap, j) => {
      out.set(userIds[i + j], snap.exists ? snap.data() : null);
    });
  }
  return out;
}

async function mapPool(items, limit, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

// Full run. With dryRun, nothing is written. The returned summary is the same
// either way, so a dry run previews an apply.
async function runReindex({
  db, guildId, sources, sinceMs, cutoffMs, dryRun = true, deadlineMs,
  cooldownMs, minGain, maxGain, rng = Math.random, now = Date.now, onProgress,
}) {
  const levelsSnap = await db.collection(LEVELS).where('guildId', '==', guildId).get();
  const floorMs = computeFloor(levelsSnap.docs.map(d => d.data()), cutoffMs);
  const scanFromMs = sinceMs ?? floorMs;
  if (scanFromMs == null) {
    return { error: 'no-baseline' };
  }

  const { byUser, stats } = await scanGuildMessages({
    sources, sinceMs: scanFromMs, cutoffMs, deadlineMs, now, onProgress,
  });
  if (stats.aborted) return { error: 'scan-timeout', stats };

  const userIds = [...byUser.keys()];
  const summary = {
    error: null, dryRun, stats, floorMs, scanFromMs, cutoffMs,
    usersWithWork: 0, awardsGranted: 0, xpGranted: 0,
  };
  const planCfg = { cooldownMs, minGain, maxGain, rng };

  const tally = (plan) => {
    if (!plan.awards.length) return;
    summary.usersWithWork += 1;
    summary.awardsGranted += plan.awards.length;
    summary.xpGranted += plan.awards.reduce((s, a) => s + a.gain, 0);
  };

  if (dryRun) {
    const docs = await fetchDocsForUsers(db, guildId, userIds);
    for (const userId of userIds) {
      const { timestamps } = byUser.get(userId);
      const plan = planUserReplay({
        doc: docs.get(userId), cutoffMs, scanFromMs, floorMs, timestamps, ...planCfg,
      });
      tally(plan);
    }
    return summary;
  }

  await mapPool(userIds, APPLY_CONCURRENCY, async (userId) => {
    const { timestamps, username } = byUser.get(userId);
    const ref = db.collection(LEVELS).doc(`${guildId}_${userId}`);
    // Transaction: the live path may write this doc concurrently. Retries re-plan from fresh data.
    const plan = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const doc = snap.exists ? snap.data() : null;
      const p = planUserReplay({
        doc, cutoffMs, scanFromMs, floorMs, timestamps, ...planCfg,
      });
      const update = buildLevelUpdate({ plan: p, doc, userId, guildId, username });
      if (update) tx.set(ref, update, { merge: true });
      return p;
    });
    tally(plan);
  });
  summary.applied = true;
  return summary;
}

module.exports = {
  PAGE_SIZE,
  readLastXPAt,
  computeFloor,
  replayAwards,
  planUserReplay,
  buildLevelUpdate,
  scanGuildMessages,
  parseSince,
  runReindex,
};
