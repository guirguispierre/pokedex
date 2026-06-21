const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function getDb() {
  return getFirestore();
}

const COL = () => getDb().collection('color_roles');

const DEFAULT_PALETTE = {
  Crimson: '#dc143c',
  Orange: '#e67e22',
  Gold: '#f1c40f',
  Green: '#2ecc71',
  Teal: '#1abc9c',
  Blue: '#3498db',
  Indigo: '#5865f2',
  Purple: '#9b59b6',
  Pink: '#e91e63',
  Gray: '#95a5a6',
};

// --- Pure helpers (unit-tested) ---

function normalizeHex(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s.split('').map(c => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return '#' + s.toLowerCase();
}

function rolesToStrip(memberRoleIds, colorRoleIds) {
  const colorSet = new Set(colorRoleIds);
  return memberRoleIds.filter(id => colorSet.has(id));
}

// Find an already-managed role id for a hex, checking presets first then customs,
// so `/color hex` reuses an existing role (e.g. a preset of the same color)
// instead of creating a duplicate. `hex` must be normalized (#rrggbb).
function matchRoleIdByHex(palette, customMap, hex) {
  const want = String(hex).toLowerCase();
  for (const v of Object.values(palette || {})) {
    if (v && v.hex && String(v.hex).toLowerCase() === want && v.roleId) return v.roleId;
  }
  const key = want.replace(/[.#]/g, '_');
  if (customMap && customMap[key]) return customMap[key];
  return null;
}

// --- Firestore palette/custom state ---

async function findRoleIdByHex(hex) {
  const palette = (await getPalette()) || {};
  const custom = await getCustomMap();
  return matchRoleIdByHex(palette, custom, hex);
}

async function getPalette() {
  try {
    const doc = await COL().doc('palette').get();
    if (doc.exists && doc.data().colors && Object.keys(doc.data().colors).length) {
      return doc.data().colors;
    }
  } catch {
    // fall through to seed
  }
  return null; // caller seeds defaults if null
}

// Whether the default palette has been fully seeded at least once. Used so a partial
// seed (some defaults created, then a failure) is resumed rather than treated as
// complete, and so intentional removals are never auto-re-added after a full seed.
async function isPaletteSeeded() {
  try {
    const doc = await COL().doc('palette').get();
    return !!(doc.exists && doc.data().seeded);
  } catch {
    return false;
  }
}

async function markPaletteSeeded() {
  await COL().doc('palette').set({ seeded: true }, { merge: true });
}

async function setPaletteEntry(name, hex, roleId) {
  await COL().doc('palette').set(
    { colors: { [name]: { hex, roleId } } },
    { merge: true },
  );
}

async function deletePaletteEntry(name) {
  await COL().doc('palette').set(
    { colors: { [name]: FieldValue.delete() } },
    { merge: true },
  );
}

async function getCustomMap() {
  try {
    const doc = await COL().doc('custom').get();
    return doc.exists ? (doc.data().byHex || {}) : {};
  } catch {
    return {};
  }
}

async function setCustomEntry(hex, roleId) {
  await COL().doc('custom').set(
    { byHex: { [hex.replace(/[.#]/g, '_')]: roleId } },
    { merge: true },
  );
}

// Union of all bot-managed color role IDs (palette + custom).
async function allColorRoleIds() {
  const ids = [];
  const palette = (await getPalette()) || {};
  for (const v of Object.values(palette)) if (v.roleId) ids.push(v.roleId);
  const custom = await getCustomMap();
  for (const id of Object.values(custom)) ids.push(id);
  return ids;
}

module.exports = {
  DEFAULT_PALETTE,
  normalizeHex,
  rolesToStrip,
  matchRoleIdByHex,
  findRoleIdByHex,
  getPalette,
  isPaletteSeeded,
  markPaletteSeeded,
  setPaletteEntry,
  deletePaletteEntry,
  getCustomMap,
  setCustomEntry,
  allColorRoleIds,
};
