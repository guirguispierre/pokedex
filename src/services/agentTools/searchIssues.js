const { jaccardSimilarity } = require('../duplicates');

function normalizeCreatedAt(value) {
  if (!value) return null;
  // Firestore Timestamp has a toDate() method.
  if (typeof value.toDate === 'function') {
    try { return value.toDate().toISOString(); } catch { return null; }
  }
  // Already a Date.
  if (value instanceof Date) return value.toISOString();
  // Already a string (likely ISO) — pass through.
  if (typeof value === 'string') return value;
  // Numeric epoch.
  if (typeof value === 'number') return new Date(value).toISOString();
  return null;
}

async function searchIssues(args, ctx) {
  const query = String(args?.query || '').trim();
  const limit = Math.max(1, Math.min(10, Number(args?.limit) || 5));
  if (!query) return [];

  let candidates = [];
  try {
    candidates = await ctx.firestore.searchOpenIssuesForAgent(query, 50);
  } catch (err) {
    console.error('[search_issues] firestore failed:', err.message);
    return [];
  }

  const scored = candidates.map(issue => {
    const sumSim = jaccardSimilarity(query, issue.summary || '');
    const textSim = jaccardSimilarity(query, issue.text || '');
    const similarity = Math.max(sumSim, textSim * 0.8);
    return {
      id: issue.id,
      summary: (issue.summary || '').slice(0, 300),
      status: issue.status || 'open',
      priority: issue.priority || 'unknown',
      category: issue.category || 'other',
      createdAt: normalizeCreatedAt(issue.createdAt),
      similarity: Math.round(similarity * 100) / 100,
    };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

const schema = {
  type: 'function',
  function: {
    name: 'search_issues',
    description: 'Search open issues for ones similar to a query. Use this to find potential duplicates or related reports before classifying a new issue.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text (keywords or a short phrase).' },
        limit: { type: 'integer', description: 'Max results (1-10).', default: 5 },
      },
      required: ['query'],
    },
  },
};

module.exports = { searchIssues, schema };
