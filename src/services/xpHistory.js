// XP history helpers.
//
// Storage: each `levels` doc carries an `xpByDay` map of 'YYYY-MM-DD' (UTC)
// -> XP gained that day, maintained by `awardXP` alongside the cumulative
// `xp`/`messages` counters. One map key per active day keeps doc growth
// bounded (~one small field per day per member), unlike a per-award event
// log.

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

// Last `days` UTC day keys ending at `endDate` (inclusive), oldest first.
function listDayKeys(days, endDate = new Date()) {
  const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(dayKey(new Date(end - i * 86_400_000)));
  }
  return keys;
}

// Returns a new xpByDay map with `gain` added to `day`.
function addXpToDay(xpByDay, day, gain) {
  return { ...(xpByDay || {}), [day]: (xpByDay?.[day] || 0) + gain };
}

/**
 * Aggregate raw `levels` docs into chartable daily series.
 *
 * Returns:
 *   days   — array of 'YYYY-MM-DD' keys (oldest first), length `days`
 *   totals — guild-wide XP earned per day, across every member doc
 *   users  — top `topUsers` members by total XP, each with a `daily`
 *            array parallel to `days` (for per-member charting)
 */
function buildXpHistory(levelDocs, { days = 30, endDate = new Date(), topUsers = 10 } = {}) {
  const keys = listDayKeys(days, endDate);
  const totals = keys.map(() => 0);

  const sorted = [...levelDocs]
    .filter(d => (d.xp || 0) > 0)
    .sort((a, b) => (b.xp || 0) - (a.xp || 0));

  for (const doc of levelDocs) {
    const xpByDay = doc.xpByDay || {};
    keys.forEach((key, i) => {
      totals[i] += xpByDay[key] || 0;
    });
  }

  const users = sorted.slice(0, topUsers).map(doc => {
    const xpByDay = doc.xpByDay || {};
    return {
      userId: doc.userId,
      username: doc.username || 'unknown',
      xp: doc.xp || 0,
      daily: keys.map(key => xpByDay[key] || 0),
    };
  });

  return { days: keys, totals, users };
}

module.exports = { dayKey, listDayKeys, addXpToDay, buildXpHistory };
