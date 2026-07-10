const admin = require('firebase-admin');
const { describeMissingFirebase, hasFirebaseConfig } = require('../config/featureGates');

let db;
let firebaseEnabled = false;
let disabledReason = null;
let warnedDisabled = false;
let localIssueNumber = 0;

function init() {
  if (!hasFirebaseConfig()) {
    const missing = describeMissingFirebase().join(', ');
    disabledReason = missing ? `missing or invalid ${missing}` : 'missing Firebase configuration';
    firebaseEnabled = false;
    console.warn(`[firebase] disabled for this process (${disabledReason}). Firebase-backed features will no-op.`);
    return;
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    db = admin.firestore();
    firebaseEnabled = true;
    disabledReason = null;
  } catch (err) {
    db = null;
    firebaseEnabled = false;
    disabledReason = err.message;
    console.warn(`[firebase] disabled for this process (${err.message}). Firebase-backed features will no-op.`);
  }
}

function isEnabled() {
  return firebaseEnabled && !!db;
}

function getDisabledReason() {
  return disabledReason;
}

function warnDisabled(feature) {
  if (warnedDisabled) return;
  warnedDisabled = true;
  console.warn(`[firebase] ${feature} skipped because Firebase is disabled.`);
}

function localIssueId() {
  localIssueNumber += 1;
  return `local-${localIssueNumber}`;
}

function emptyIssueCounts() {
  return { open: 0, closed: 0, resolved: 0, total: 0, byPriority: {} };
}

function gate(name, fn, fallback, options = {}) {
  return async (...args) => {
    if (isEnabled() || (options.allowExplicitDb && args[0])) {
      return fn(...args);
    }
    warnDisabled(name);
    return typeof fallback === 'function' ? fallback(...args) : fallback;
  };
}

async function isDuplicate(messageId) {
  const snapshot = await db.collection('issues')
    .where('messageId', '==', messageId)
    .limit(1)
    .get();
  return !snapshot.empty;
}

async function allocateIssueNumber(database = db) {
  const ref = database.collection('counters').doc('issues');
  return database.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data().next ?? 0) : 0;
    const next = current + 1;
    tx.set(ref, { next });
    return next;
  });
}

async function saveIssue(issueData) {
  const number = await allocateIssueNumber();
  const docRef = await db.collection('issues').add({
    ...issueData,
    number,
    status: 'open',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return docRef.id;
}

async function getIssuesSince(since) {
  const snapshot = await db.collection('issues')
    .where('createdAt', '>=', since)
    .orderBy('createdAt', 'desc')
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getAllConfigOverrides() {
  const snapshot = await db.collection('config').get();
  const overrides = {};
  snapshot.forEach(doc => {
    const data = doc.data();
    overrides[data.key] = data.value;
  });
  return overrides;
}

async function setConfigOverride(key, value, userId) {
  await db.collection('config').doc(key).set({
    key,
    value,
    updatedBy: userId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function deleteConfigOverride(key) {
  await db.collection('config').doc(key).delete();
}

async function updateIssueTriageMessageId(issueId, triageMessageId) {
  await db.collection('issues').doc(issueId).update({ triageMessageId });
}

async function updateIssueTriageChannelId(issueId, triageChannelId) {
  await db.collection('issues').doc(issueId).update({ triageChannelId });
}

async function updateIssueThreadId(issueId, threadId) {
  await db.collection('issues').doc(issueId).update({ threadId });
}

async function getIssueByThreadId(threadId) {
  const snapshot = await db.collection('issues')
    .where('threadId', '==', threadId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function appendThreadContext(issueId, newText) {
  const doc = await db.collection('issues').doc(issueId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  const existingContext = data.threadContext || [];
  existingContext.push({ text: newText, addedAt: new Date().toISOString() });
  await db.collection('issues').doc(issueId).update({ threadContext: existingContext });
  return { id: doc.id, ...data, threadContext: existingContext };
}

async function updateIssueClassification(issueId, classification) {
  await db.collection('issues').doc(issueId).update({
    priority: classification.priority,
    category: classification.category,
    summary: classification.summary,
    reasoning: classification.reasoning,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function getIssueById(issueId) {
  const doc = await db.collection('issues').doc(issueId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function updateIssueStatus(issueId, status, closedBy) {
  const update = {
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (status === 'closed') {
    update.closedBy = closedBy;
    update.closedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  await db.collection('issues').doc(issueId).update(update);
}

async function getOpenIssues(limit = 25) {
  const snapshot = await db.collection('issues')
    .where('status', '==', 'open')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getIssueCounts() {
  const openSnap = await db.collection('issues').where('status', '==', 'open').get();
  const closedSnap = await db.collection('issues').where('status', '==', 'closed').get();
  const resolvedSnap = await db.collection('issues').where('status', '==', 'resolved').get();
  const open = openSnap.size;
  const closed = closedSnap.size;
  const resolved = resolvedSnap.size;

  // Count by priority
  const byPriority = {};
  openSnap.forEach(doc => {
    const p = doc.data().priority || 'unclassified';
    byPriority[p] = (byPriority[p] || 0) + 1;
  });

  return { open, closed, resolved, total: open + closed + resolved, byPriority };
}

async function getAllIssues(limit = 500) {
  const snapshot = await db.collection('issues')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getRecentIssuesByReporter(reporterId, options = {}) {
  const { status = 'all', limit = 10 } = options;
  const issues = await getAllIssues(500);

  return issues
    .filter(issue => issue.reporterId === reporterId)
    .filter(issue => status === 'all' ? true : (issue.status || 'open') === status)
    .slice(0, limit);
}

async function searchIssues(query, options = {}) {
  const { status = 'all', limit = 10 } = options;
  const terms = String(query || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return [];

  const issues = await getAllIssues(500);

  return issues
    .map(issue => {
      const summary = String(issue.summary || '').toLowerCase();
      const text = String(issue.text || '').toLowerCase();
      const category = String(issue.category || '').toLowerCase();
      const reporter = String(issue.reporterName || '').toLowerCase();
      let score = 0;

      for (const term of terms) {
        if (summary.includes(term)) score += 3;
        if (text.includes(term)) score += 2;
        if (category.includes(term)) score += 1;
        if (reporter.includes(term)) score += 1;
      }

      return { issue, score };
    })
    .filter(({ issue, score }) => score > 0 && (status === 'all' ? true : (issue.status || 'open') === status))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ issue }) => issue);
}

async function assignIssue(issueId, assignment) {
  await db.collection('issues').doc(issueId).update({
    assigneeId: assignment.assigneeId,
    assigneeName: assignment.assigneeName,
    assignedBy: assignment.assignedBy,
    assignedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function addIssueNote(issueId, note) {
  const docRef = db.collection('issues').doc(issueId);
  const doc = await docRef.get();
  if (!doc.exists) return null;

  const data = doc.data();
  const notes = Array.isArray(data.notes) ? [...data.notes] : [];
  const storedNote = {
    text: note.text,
    authorId: note.authorId,
    authorName: note.authorName,
    createdAt: new Date().toISOString(),
  };

  notes.push(storedNote);

  await docRef.update({
    notes,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return storedNote;
}

async function updateIssueFields(issueId, fields) {
  await db.collection('issues').doc(issueId).update(fields);
}

async function addReporter(issueId, reporterId, reporterName) {
  const docRef = db.collection('issues').doc(issueId);
  const doc = await docRef.get();
  if (!doc.exists) return null;

  const data = doc.data();
  const reporters = Array.isArray(data.reporterIds) ? [...data.reporterIds] : [];

  // Don't add if already tracked
  if (reporters.some(r => r.id === reporterId)) return data;

  reporters.push({ id: reporterId, name: reporterName, addedAt: new Date().toISOString() });
  await docRef.update({ reporterIds: reporters });
  return { id: doc.id, ...data, reporterIds: reporters };
}

async function getForumIssues(limit = 500) {
  const snapshot = await db.collection('issues')
    .where('source', '==', 'forum')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getAllIssuesWithThreadId() {
  const results = [];
  let lastDoc = null;
  const batchSize = 500;
  while (true) {
    let query = db.collection('issues')
      .where('threadId', '!=', null)
      .select('threadId')
      .orderBy('threadId')
      .limit(batchSize);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }
    const snapshot = await query.get();
    if (snapshot.empty) break;
    snapshot.docs.forEach(doc => results.push({ id: doc.id, threadId: doc.get('threadId') }));
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < batchSize) break;
  }
  return results;
}

// --- Recipes ---

async function saveRecipe(recipeData) {
  const crypto = require('crypto');
  const db = admin.firestore();
  // Use a deterministic doc ID based on normalized URL to prevent race conditions
  const normalizedUrl = recipeData.url.trim().toLowerCase().replace(/\/+$/, '');
  const docId = crypto.createHash('sha256').update(normalizedUrl).digest('hex');
  const docRef = db.collection('recipes').doc(docId);

  // Check for legacy doc with random ID (pre-deterministic-ID migration)
  const legacyQuery = await db.collection('recipes')
    .where('url', '==', recipeData.url)
    .limit(1)
    .get();

  if (!legacyQuery.empty) {
    const legacyDoc = legacyQuery.docs[0];
    const existingSharers = legacyDoc.data().sharedBy || [];
    const newSharers = (recipeData.sharedBy || []).filter(
      s => !existingSharers.some(es => es.id === s.id)
    );
    if (newSharers.length > 0) {
      await legacyDoc.ref.update({
        sharedBy: admin.firestore.FieldValue.arrayUnion(...newSharers),
        shareCount: admin.firestore.FieldValue.increment(newSharers.length),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    return { id: legacyDoc.id, updated: true };
  }

  const initialShareCount = Math.max(1, (recipeData.sharedBy || []).length);

  try {
    // Try to create — fails atomically if doc already exists
    await docRef.create({
      ...recipeData,
      shareCount: initialShareCount,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { id: docId, updated: false };
  } catch (err) {
    if (err.code === 6) { // ALREADY_EXISTS
      // Update existing recipe with new sharer using a transaction
      // to only increment shareCount when a new sharer is actually added
      await db.runTransaction(async (txn) => {
        const doc = await txn.get(docRef);
        if (!doc.exists) return;
        const data = doc.data();
        const existingSharerIds = (data.sharedBy || []).map(s => s.id);
        const newSharers = (recipeData.sharedBy || []).filter(s => !existingSharerIds.includes(s.id));
        const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (newSharers.length > 0) {
          updates.sharedBy = admin.firestore.FieldValue.arrayUnion(...newSharers);
          updates.shareCount = admin.firestore.FieldValue.increment(newSharers.length);
        }
        txn.update(docRef, updates);
      });
      return { id: docId, updated: true };
    }
    throw err;
  }
}

async function getAllRecipes(limit = 200) {
  const db = admin.firestore();
  const snapshot = await db.collection('recipes')
    .orderBy('shareCount', 'desc')
    .limit(Math.min(limit, 500))
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

/**
 * Iterate every recipe in the collection with no limit. Used by the retag
 * backfill command. Prefer getAllRecipes() for normal reads.
 *
 * NOTE: this reads the full collection into memory as a single array. Fine for
 * the current (~hundreds of docs) collection size. For collections above ~10k
 * docs, switch to a cursor-based iterator (orderBy + startAfter + limit) to
 * avoid memory pressure.
 */
async function getAllRecipesUncapped() {
  const db = admin.firestore();
  const snap = await db.collection('recipes').get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getApprovedRecipes(limit = 200) {
  const db = admin.firestore();
  const snapshot = await db.collection('recipes')
    .where('status', '==', 'approved')
    .orderBy('shareCount', 'desc')
    .limit(Math.min(limit, 500))
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getPendingRecipes(limit = 50) {
  const db = admin.firestore();
  const snapshot = await db.collection('recipes')
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(Math.min(limit, 200))
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getRecipeById(recipeId) {
  const db = admin.firestore();
  const doc = await db.collection('recipes').doc(recipeId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function getRecipeByUrl(url) {
  const db = admin.firestore();
  const snapshot = await db.collection('recipes')
    .where('url', '==', url)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

async function updateRecipeStatus(recipeId, status, reviewerId, reviewerName) {
  const db = admin.firestore();
  await db.collection('recipes').doc(recipeId).update({
    status,
    reviewedBy: reviewerName,
    reviewedById: reviewerId,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function deleteRecipe(recipeId) {
  const db = admin.firestore();
  await db.collection('recipes').doc(recipeId).delete();
}

// --- Agent triage helpers ---

async function setIssueLastEvaluatedAt(issueId, iso) {
  await db.collection('issues').doc(issueId).update({ lastEvaluatedAt: iso });
}

/**
 * Mark an issue as auto-resolved by the reporter.
 * Sets status to 'resolved' (a distinct terminal state from 'closed').
 * Note: existing dashboards/digests that filter on status will need to be
 * updated to recognize 'resolved' — out of scope for this helper.
 */
async function updateIssueResolution(issueId, { resolvedBy, resolvedReason }) {
  await db.collection('issues').doc(issueId).update({
    status: 'resolved',
    resolvedAt: new Date().toISOString(),
    resolvedBy,
    resolvedReason: resolvedReason || null,
  });
}

async function searchOpenIssuesForAgent(_query, limit = 50) {
  // Tool loads recent open issues; ranking happens in the tool via Jaccard.
  // Firestore doesn't do text search natively; we return a working set.
  const snapshot = await db.collection('issues')
    .where('status', '==', 'open')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getGapByKey(normalizedKey) {
  const doc = await db.collection('capability_gaps').doc(normalizedKey).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function createGap(data) {
  if (!data?.normalizedKey) throw new Error('createGap: normalizedKey is required');
  await db.collection('capability_gaps').doc(data.normalizedKey).set({
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return data.normalizedKey;
}

async function updateGap(normalizedKey, fields) {
  await db.collection('capability_gaps').doc(normalizedKey).update(fields);
}

// --- Backfill / additional-context helpers ---

// Scans all open issues and filters in memory. Fine at our scale (hundreds of
// open issues at most). If this grows past ~5k docs, add a paged scan or a
// queryable `hasNumber` flag.
async function listOpenIssuesMissingNumbers() {
  const snapshot = await db.collection('issues')
    .where('status', '==', 'open')
    .get();
  return snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(doc => typeof doc.number !== 'number');
}

// Transactional set-if-missing. Returns true if this call wrote the number,
// false if the doc was missing OR another writer (e.g. concurrent saveIssue)
// already assigned one. Caller can drop the wasted counter value.
async function setIssueNumberIfMissing(issueId, number) {
  const ref = db.collection('issues').doc(issueId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    if (typeof snap.data().number === 'number') return false;
    tx.update(ref, { number });
    return true;
  });
}

// Atomic-append using arrayUnion so two concurrent /addcontext callers can't
// lose each other's writes. Each stored entry gets a unique addedAt ISO
// timestamp so arrayUnion's value-equality dedup does not collapse rapid
// successive appends (collisions would need to land in the same millisecond
// with identical author and text — vanishingly rare).
//
// Note: the additionalContext array is stored inline on the issue document.
// At ~1KB per entry, the 1MB doc limit is ~1000 entries away; well past our
// expected use. If this becomes a concern, move to a subcollection.
async function appendAdditionalContext(issueId, entry) {
  const stored = {
    text: String(entry.text || '').trim(),
    authorId: entry.authorId || null,
    authorName: entry.authorName || null,
    addedAt: new Date().toISOString(),
    sourceMessageId: entry.sourceMessageId || null,
  };
  const docRef = db.collection('issues').doc(issueId);
  await docRef.update({
    additionalContext: admin.firestore.FieldValue.arrayUnion(stored),
  }).catch(err => {
    // update() rejects with NOT_FOUND (code 5) if the doc doesn't exist —
    // surface null rather than throwing so the caller can show "not found".
    if (err?.code === 5) return null;
    throw err;
  });
  const fresh = await docRef.get();
  if (!fresh.exists) return null;
  return { id: fresh.id, ...fresh.data() };
}

// --- Per-thread exclusion helpers ---

async function addExcludedMessageIds(issueId, ids) {
  await db.collection('issues').doc(issueId).update({
    excludedMessageIds: admin.firestore.FieldValue.arrayUnion(...ids),
  });
}

async function setExcludeMode(issueId, userId, on) {
  await db.collection('issues').doc(issueId).update({
    excludeModeUserIds: on
      ? admin.firestore.FieldValue.arrayUnion(userId)
      : admin.firestore.FieldValue.arrayRemove(userId),
  });
}

async function clearExclusions(issueId) {
  await db.collection('issues').doc(issueId).update({ excludedMessageIds: [], excludeModeUserIds: [] });
}

// --- Context-evaluator helpers ---

async function incrementQuestionTurns(issueId) {
  await db.collection('issues').doc(issueId).update({
    questionTurns: admin.firestore.FieldValue.increment(1),
  });
}

async function setIdentityDisclosed(issueId) {
  await db.collection('issues').doc(issueId).update({ identityDisclosed: true });
}

// --- Feedback (public website) ---

async function saveFeedback(feedbackData) {
  const existing = await db.collection('feedback')
    .where('messageId', '==', feedbackData.messageId)
    .limit(1)
    .get();
  if (!existing.empty) {
    return { id: existing.docs[0].id, duplicate: true };
  }
  const ref = await db.collection('feedback').add({
    ...feedbackData,
    status: 'published',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { id: ref.id, duplicate: false };
}

async function getPublishedFeedback(limit = 200) {
  const snapshot = await db.collection('feedback')
    .where('status', '==', 'published')
    .orderBy('createdAt', 'desc')
    .limit(Math.min(limit, 500))
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// --- Raffles ---

async function saveRaffle(raffleData) {
  await db.collection('raffles').doc(raffleData.messageId).set({
    ...raffleData,
    updatedAt: Date.now(),
  }, { merge: true });
  return raffleData.messageId;
}

async function getRaffle(messageId) {
  const doc = await db.collection('raffles').doc(messageId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function updateRaffle(messageId, patch) {
  await db.collection('raffles').doc(messageId).set({
    ...patch,
    updatedAt: Date.now(),
  }, { merge: true });
}

async function listActiveRaffles(limit = 100) {
  const snapshot = await db.collection('raffles')
    .where('endedAt', '==', null)
    .limit(Math.min(limit, 500))
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function listRaffles(limit = 100) {
  const snapshot = await db.collection('raffles')
    .orderBy('updatedAt', 'desc')
    .limit(Math.min(limit, 500))
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

const noOp = undefined;
const emptyArray = [];
const emptyObject = {};
const nullValue = null;

module.exports = {
  init,
  isEnabled,
  getDisabledReason,
  isDuplicate: gate('isDuplicate', isDuplicate, false),
  allocateIssueNumber: gate('allocateIssueNumber', allocateIssueNumber, () => ++localIssueNumber, { allowExplicitDb: true }),
  saveIssue: gate('saveIssue', saveIssue, localIssueId),
  getIssuesSince: gate('getIssuesSince', getIssuesSince, emptyArray),
  getAllConfigOverrides: gate('getAllConfigOverrides', getAllConfigOverrides, emptyObject),
  setConfigOverride: gate('setConfigOverride', setConfigOverride, noOp),
  deleteConfigOverride: gate('deleteConfigOverride', deleteConfigOverride, noOp),
  updateIssueTriageMessageId: gate('updateIssueTriageMessageId', updateIssueTriageMessageId, noOp),
  updateIssueTriageChannelId: gate('updateIssueTriageChannelId', updateIssueTriageChannelId, noOp),
  updateIssueThreadId: gate('updateIssueThreadId', updateIssueThreadId, noOp),
  getIssueByThreadId: gate('getIssueByThreadId', getIssueByThreadId, nullValue),
  appendThreadContext: gate('appendThreadContext', appendThreadContext, nullValue),
  updateIssueClassification: gate('updateIssueClassification', updateIssueClassification, noOp),
  getIssueById: gate('getIssueById', getIssueById, nullValue),
  updateIssueStatus: gate('updateIssueStatus', updateIssueStatus, noOp),
  getOpenIssues: gate('getOpenIssues', getOpenIssues, emptyArray),
  getIssueCounts: gate('getIssueCounts', getIssueCounts, emptyIssueCounts),
  getAllIssues: gate('getAllIssues', getAllIssues, emptyArray),
  getRecentIssuesByReporter: gate('getRecentIssuesByReporter', getRecentIssuesByReporter, emptyArray),
  searchIssues: gate('searchIssues', searchIssues, emptyArray),
  assignIssue: gate('assignIssue', assignIssue, noOp),
  addIssueNote: gate('addIssueNote', addIssueNote, nullValue),
  updateIssueFields: gate('updateIssueFields', updateIssueFields, noOp),
  addReporter: gate('addReporter', addReporter, nullValue),
  getForumIssues: gate('getForumIssues', getForumIssues, emptyArray),
  getAllIssuesWithThreadId: gate('getAllIssuesWithThreadId', getAllIssuesWithThreadId, emptyArray),
  saveRecipe: gate('saveRecipe', saveRecipe, () => ({ id: localIssueId(), updated: false, disabled: true })),
  getAllRecipes: gate('getAllRecipes', getAllRecipes, emptyArray),
  getAllRecipesUncapped: gate('getAllRecipesUncapped', getAllRecipesUncapped, emptyArray),
  getApprovedRecipes: gate('getApprovedRecipes', getApprovedRecipes, emptyArray),
  getPendingRecipes: gate('getPendingRecipes', getPendingRecipes, emptyArray),
  getRecipeById: gate('getRecipeById', getRecipeById, nullValue),
  getRecipeByUrl: gate('getRecipeByUrl', getRecipeByUrl, nullValue),
  updateRecipeStatus: gate('updateRecipeStatus', updateRecipeStatus, noOp),
  deleteRecipe: gate('deleteRecipe', deleteRecipe, noOp),
  saveFeedback: gate('saveFeedback', saveFeedback, () => ({ id: localIssueId(), duplicate: false, disabled: true })),
  getPublishedFeedback: gate('getPublishedFeedback', getPublishedFeedback, emptyArray),
  saveRaffle: gate('saveRaffle', saveRaffle, noOp),
  getRaffle: gate('getRaffle', getRaffle, nullValue),
  updateRaffle: gate('updateRaffle', updateRaffle, noOp),
  listActiveRaffles: gate('listActiveRaffles', listActiveRaffles, emptyArray),
  listRaffles: gate('listRaffles', listRaffles, emptyArray),
  setIssueLastEvaluatedAt: gate('setIssueLastEvaluatedAt', setIssueLastEvaluatedAt, noOp),
  updateIssueResolution: gate('updateIssueResolution', updateIssueResolution, noOp),
  searchOpenIssuesForAgent: gate('searchOpenIssuesForAgent', searchOpenIssuesForAgent, emptyArray),
  getGapByKey: gate('getGapByKey', getGapByKey, nullValue),
  createGap: gate('createGap', createGap, () => null),
  updateGap: gate('updateGap', updateGap, noOp),
  incrementQuestionTurns: gate('incrementQuestionTurns', incrementQuestionTurns, noOp),
  setIdentityDisclosed: gate('setIdentityDisclosed', setIdentityDisclosed, noOp),
  addExcludedMessageIds: gate('addExcludedMessageIds', addExcludedMessageIds, noOp),
  setExcludeMode: gate('setExcludeMode', setExcludeMode, noOp),
  clearExclusions: gate('clearExclusions', clearExclusions, noOp),
  listOpenIssuesMissingNumbers: gate('listOpenIssuesMissingNumbers', listOpenIssuesMissingNumbers, emptyArray),
  setIssueNumberIfMissing: gate('setIssueNumberIfMissing', setIssueNumberIfMissing, false),
  appendAdditionalContext: gate('appendAdditionalContext', appendAdditionalContext, nullValue),
};
