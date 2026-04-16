const express = require('express');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const firestore = require('../services/firestore');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// --- API Authentication ---
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY || '';

function apiAuth(req, res, next) {
  if (!DASHBOARD_API_KEY) {
    const ip = req.ip || req.connection.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      return next();
    }
    return res.status(403).json({ error: 'Dashboard API is restricted to localhost. Set DASHBOARD_API_KEY to enable remote access.' });
  }

  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (!provided || typeof provided !== 'string') {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  // timingSafeEqual throws if buffers differ in length — check first to avoid 500
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(DASHBOARD_API_KEY);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
}

// --- Rate Limiting ---
const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Try again later.' },
});

// Apply rate limiting globally to all routes
app.use(limiter);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API: Get all recipes (public — no auth required)
app.get('/api/recipes', async (req, res) => {
  try {
    const { tag, source, limit: limitParam, search } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limitParam) || 200, 1), 500);
    let recipes = await firestore.getApprovedRecipes(safeLimit);

    // Note: In-memory filtering is limited to the top N recipes by shareCount.
    // If the collection exceeds safeLimit, filtered results may be incomplete.
    if (tag) recipes = recipes.filter(r => (r.tags || []).includes(tag.toLowerCase()));
    if (source) recipes = recipes.filter(r => (r.source || '').toLowerCase() === source.toLowerCase());
    if (search) {
      const q = search.toLowerCase();
      recipes = recipes.filter(r =>
        (r.title || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q) ||
        (r.tags || []).some(t => t.includes(q))
      );
    }

    // Convert Firestore timestamps
    recipes = recipes.map(r => ({
      ...r,
      createdAt: r.createdAt?.toDate?.()?.toISOString() || null,
      updatedAt: r.updatedAt?.toDate?.()?.toISOString() || null,
    }));

    res.json({ recipes, total: recipes.length });
  } catch (err) {
    console.error('Recipes API error:', err);
    res.status(500).json({ error: 'Failed to fetch recipes' });
  }
});

// Apply auth to all remaining API routes (rate limiting is global)
app.use('/api', apiAuth);

// API: Get all issues
app.get('/api/issues', async (req, res) => {
  try {
    const { status, priority, category, limit: limitParam } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limitParam) || 100, 1), 500);
    let issues = await firestore.getAllIssues(safeLimit);

    if (status) issues = issues.filter(i => i.status === status);
    if (priority) issues = issues.filter(i => i.priority === priority);
    if (category) issues = issues.filter(i => i.category === category);

    // Convert Firestore timestamps to ISO strings
    issues = issues.map(i => ({
      ...i,
      createdAt: i.createdAt?.toDate?.()?.toISOString() || null,
      closedAt: i.closedAt?.toDate?.()?.toISOString() || null,
      updatedAt: i.updatedAt?.toDate?.()?.toISOString() || null,
    }));

    res.json({ issues, total: issues.length });
  } catch (err) {
    console.error('Dashboard API error:', err);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

// API: Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const counts = await firestore.getIssueCounts();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// API: Get single issue
app.get('/api/issues/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid issue ID format' });
    }

    const issue = await firestore.getIssueById(id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    res.json({
      ...issue,
      createdAt: issue.createdAt?.toDate?.()?.toISOString() || null,
      closedAt: issue.closedAt?.toDate?.()?.toISOString() || null,
      updatedAt: issue.updatedAt?.toDate?.()?.toISOString() || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch issue' });
  }
});

// Catch-all: serve frontend for SPA routing
app.use((req, res) => {
  const reqPath = req.path;
  // Serve recipes page for /recipes route
  if (reqPath === '/recipes' || reqPath === '/recipes/') {
    return res.sendFile(path.join(__dirname, 'public', 'recipes.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function startDashboard() {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Dashboard running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { startDashboard };
