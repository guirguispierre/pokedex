const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp, cert } = require('firebase-admin/app');

let db;

function init() {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
  db = getFirestore();
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
    createdAt: FieldValue.serverTimestamp(),
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
    updatedAt: FieldValue.serverTimestamp(),
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
    updatedAt: FieldValue.serverTimestamp(),
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
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (status === 'closed') {
    update.closedBy = closedBy;
    update.closedAt = FieldValue.serverTimestamp();
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
    assignedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
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
    updatedAt: FieldValue.serverTimestamp(),
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
  const db = getFirestore();
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
        sharedBy: FieldValue.arrayUnion(...newSharers),
        shareCount: FieldValue.increment(newSharers.length),
        updatedAt: FieldValue.serverTimestamp(),
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
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
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
        const updates = { updatedAt: FieldValue.serverTimestamp() };
        if (newSharers.length > 0) {
          updates.sharedBy = FieldValue.arrayUnion(...newSharers);
          updates.shareCount = FieldValue.increment(newSharers.length);
        }
        txn.update(docRef, updates);
      });
      return { id: docId, updated: true };
    }
    throw err;
  }
}

async function getAllRecipes(limit = 200) {
  const db = getFirestore();
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
  const db = getFirestore();
  const snap = await db.collection('recipes').get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getApprovedRecipes(limit = 200) {
  const db = getFirestore();
  const snapshot = await db.collection('recipes')
    .where('status', '==', 'approved')
    .orderBy('shareCount', 'desc')
    .limit(Math.min(limit, 500))
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getPendingRecipes(limit = 50) {
  const db = getFirestore();
  const snapshot = await db.collection('recipes')
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(Math.min(limit, 200))
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getRecipeById(recipeId) {
  const db = getFirestore();
  const doc = await db.collection('recipes').doc(recipeId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function getRecipeByUrl(url) {
  const db = getFirestore();
  const snapshot = await db.collection('recipes')
    .where('url', '==', url)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

async function updateRecipeStatus(recipeId, status, reviewerId, reviewerName) {
  const db = getFirestore();
  await db.collection('recipes').doc(recipeId).update({
    status,
    reviewedBy: reviewerName,
    reviewedById: reviewerId,
    reviewedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function deleteRecipe(recipeId) {
  const db = getFirestore();
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
    createdAt: FieldValue.serverTimestamp(),
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
    additionalContext: FieldValue.arrayUnion(stored),
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
    excludedMessageIds: FieldValue.arrayUnion(...ids),
  });
}

async function setExcludeMode(issueId, userId, on) {
  await db.collection('issues').doc(issueId).update({
    excludeModeUserIds: on
      ? FieldValue.arrayUnion(userId)
      : FieldValue.arrayRemove(userId),
  });
}

async function clearExclusions(issueId) {
  await db.collection('issues').doc(issueId).update({ excludedMessageIds: [], excludeModeUserIds: [] });
}

// --- Context-evaluator helpers ---

async function incrementQuestionTurns(issueId) {
  await db.collection('issues').doc(issueId).update({
    questionTurns: FieldValue.increment(1),
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
    createdAt: FieldValue.serverTimestamp(),
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

module.exports = {
  init,
  isDuplicate,
  allocateIssueNumber,
  saveIssue,
  getIssuesSince,
  getAllConfigOverrides,
  setConfigOverride,
  deleteConfigOverride,
  updateIssueTriageMessageId,
  updateIssueTriageChannelId,
  updateIssueThreadId,
  getIssueByThreadId,
  appendThreadContext,
  updateIssueClassification,
  getIssueById,
  updateIssueStatus,
  getOpenIssues,
  getIssueCounts,
  getAllIssues,
  getRecentIssuesByReporter,
  searchIssues,
  assignIssue,
  addIssueNote,
  updateIssueFields,
  addReporter,
  getForumIssues,
  getAllIssuesWithThreadId,
  saveRecipe,
  getAllRecipes,
  getAllRecipesUncapped,
  getApprovedRecipes,
  getPendingRecipes,
  getRecipeById,
  getRecipeByUrl,
  updateRecipeStatus,
  deleteRecipe,
  saveFeedback,
  getPublishedFeedback,
  setIssueLastEvaluatedAt,
  updateIssueResolution,
  searchOpenIssuesForAgent,
  getGapByKey,
  createGap,
  updateGap,
  incrementQuestionTurns,
  setIdentityDisclosed,
  addExcludedMessageIds,
  setExcludeMode,
  clearExclusions,
  listOpenIssuesMissingNumbers,
  setIssueNumberIfMissing,
  appendAdditionalContext,
};
