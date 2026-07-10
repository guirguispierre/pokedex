/**
 * Duplicate issue detection — Jaccard (fast) + AI-powered (accurate).
 */

const { getConfig } = require('../config/config');
const { hasOpenRouterConfig } = require('../config/featureGates');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/**
 * Fast Jaccard-based duplicate finder (pre-filter).
 */
function findDuplicate(newSummary, newText, existingIssues, threshold = 0.4) {
  let bestMatch = null;
  let bestScore = 0;

  for (const issue of existingIssues) {
    const summarySim = jaccardSimilarity(newSummary, issue.summary || '');
    const textSim = jaccardSimilarity(newText, issue.text || '');
    const score = (summarySim * 0.6) + (textSim * 0.4);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { issue, score, summarySimilarity: summarySim, textSimilarity: textSim };
    }
  }

  if (bestMatch && bestScore >= threshold) {
    return bestMatch;
  }

  return null;
}

/**
 * AI-powered duplicate detection via OpenRouter.
 * Sends the new issue summary + category against a list of existing open issues
 * and asks the AI to identify if it's a duplicate.
 *
 * @param {string} newSummary - Summary of the new issue
 * @param {string} newCategory - Category of the new issue
 * @param {Array} existingIssues - Array of existing open issues (need id, summary, category)
 * @param {number} confidenceThreshold - Minimum confidence to consider a match (0-100), default 70
 * @returns {Object|null} { issue, score } or null
 */
async function findDuplicateAI(newSummary, newCategory, existingIssues, confidenceThreshold = 70) {
  if (!existingIssues || existingIssues.length === 0) return null;
  if (!hasOpenRouterConfig()) return null;

  const model = getConfig('model');

  // Build the existing issues list for the prompt (cap at 50 to avoid token limits)
  const issueList = existingIssues.slice(0, 50).map((issue, i) => {
    const reporters = (issue.reporterIds || []).length || 1;
    return `[${i + 1}] ID: ${issue.id} | Category: ${issue.category || 'other'} | Priority: ${issue.priority || 'medium'} | Reporters: ${reporters}\nSummary: ${issue.summary || 'No summary'}`;
  }).join('\n\n');

  const systemPrompt = `You are a duplicate issue detector for poke.com's issue tracker. Your job is to determine if a NEW issue is a duplicate of any EXISTING issue.

Two issues are duplicates if they describe the SAME specific problem or feature request. Issues in the same product area but about DIFFERENT problems are NOT duplicates.

Examples:
- "Gmail labels not applying" and "Labels fail when applied to threads" → DUPLICATE (same bug)
- "Gmail labels not applying" and "Gmail sync is slow" → NOT DUPLICATE (different problems in same area)
- "Add PayPal payouts" and "Add crypto payouts" → NOT DUPLICATE (different feature requests, though related)
- "iMessage not sending" and "Messages stuck in iMessage" → DUPLICATE (same core problem)

## Existing Issues
${issueList}

## New Issue
Category: ${newCategory || 'other'}
Summary: ${newSummary}

If the new issue is a duplicate of an existing one, return:
{"isDuplicate": true, "matchIndex": <1-based index from list>, "confidence": <0-100>, "reason": "brief explanation"}

If NOT a duplicate, return:
{"isDuplicate": false, "confidence": 0, "reason": "brief explanation"}

Return ONLY valid JSON.`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://poke.com',
        'X-Title': 'Pokedex Duplicate Detector',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Is this new issue a duplicate of any existing issue?\n\nNew issue summary: ${newSummary}\nCategory: ${newCategory}` },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error(`Duplicate AI API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(content);

    if (parsed.isDuplicate && parsed.confidence >= confidenceThreshold && parsed.matchIndex >= 1) {
      const matchedIssue = existingIssues[parsed.matchIndex - 1];
      if (matchedIssue) {
        return {
          issue: matchedIssue,
          score: parsed.confidence / 100,
          reason: parsed.reason || 'AI-detected duplicate',
        };
      }
    }

    return null;
  } catch (err) {
    console.error('AI duplicate detection failed:', err.message);
    return null;
  }
}

/**
 * AI-powered batch duplicate detection — finds all duplicate clusters among a set of issues.
 * Used by the /feedback-triage reorganize command.
 *
 * @param {Array} issues - All open issues to check for duplicates
 * @returns {Array} Array of clusters: [{ canonical: issue, duplicates: [issue, ...], reason }]
 */
async function findDuplicateClustersAI(issues) {
  if (!issues || issues.length < 2) return [];
  if (!hasOpenRouterConfig()) return [];

  const model = getConfig('model');

  const issueList = issues.slice(0, 60).map((issue, i) => {
    const reporters = (issue.reporterIds || []).length || 1;
    return `[${i + 1}] ID: ${issue.id} | Category: ${issue.category || 'other'} | Priority: ${issue.priority || 'medium'} | Reporters: ${reporters}\nSummary: ${issue.summary || 'No summary'}`;
  }).join('\n\n');

  const systemPrompt = `You are a duplicate issue detector for poke.com's issue tracker. Analyze ALL of these issues and identify groups of duplicates — issues that describe the SAME specific problem or feature request.

Rules:
- Two issues are duplicates ONLY if they describe the SAME specific problem or request
- Issues in the same product area but about DIFFERENT problems are NOT duplicates
- Each group should have a "canonical" issue (the one with the most detail or most reporters) and "duplicates" (the others that should be merged into it)
- Issues that have no duplicates should NOT appear in any group

## Issues
${issueList}

Return ONLY valid JSON:
{
  "clusters": [
    {
      "canonicalIndex": <1-based index of the main issue to keep>,
      "duplicateIndices": [<1-based indices of issues to merge into canonical>],
      "reason": "Why these are the same issue"
    }
  ]
}

If no duplicates are found, return: {"clusters": []}`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://poke.com',
        'X-Title': 'Pokedex Duplicate Cluster Detector',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Find all duplicate clusters in the issues listed above.' },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error(`Duplicate cluster AI API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(content);
    const clusters = [];

    for (const cluster of (parsed.clusters || [])) {
      const canonicalIdx = cluster.canonicalIndex - 1;
      const dupeIndices = (cluster.duplicateIndices || []).map(i => i - 1);

      if (canonicalIdx >= 0 && canonicalIdx < issues.length) {
        const canonical = issues[canonicalIdx];
        const duplicates = dupeIndices
          .filter(i => i >= 0 && i < issues.length && i !== canonicalIdx)
          .map(i => issues[i]);

        if (duplicates.length > 0) {
          clusters.push({ canonical, duplicates, reason: cluster.reason || 'AI-detected duplicates' });
        }
      }
    }

    return clusters;
  } catch (err) {
    console.error('AI duplicate cluster detection failed:', err.message);
    return [];
  }
}

module.exports = { findDuplicate, findDuplicateAI, findDuplicateClustersAI, jaccardSimilarity };
