const { getConfig } = require('../config/config');
const agentTools = require('./agentTools');

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low', 'unclassified'];
const VALID_TARGETS = ['poke_product', 'pokedex_bot'];

function buildSystemPrompt() {
  const priorities = getConfig('priorities') || ['critical', 'high', 'medium', 'low'];
  const categories = getConfig('categories') || ['bug', 'feature_request', 'ux_issue', 'performance', 'security', 'suggestion', 'other'];

  return `You are Pokedex, a smart issue triage bot for poke.com's Discord community.

## Platform Context
poke.com is an AI assistant living inside iMessage/WhatsApp/SMS. Integrations include Gmail, Outlook, Google Calendar, Notion, Linear, GitHub, Asana, Todoist, Ramp, Netlify, Vercel, Supabase. "Recipes" are workflow templates.

## Your job
Classify a reported issue. You have tools available: consider whether they would meaningfully improve the classification before calling them. Don't call tools just to call them. If the text (and image, if any) is clearly sufficient, go straight to the final JSON.

## Target routing
- target: "pokedex_bot" — the complaint is about THIS Discord bot (Pokedex). Phrases: "you're doing it wrong", "the bot misclassified", "pokedex ignored my message".
- target: "poke_product" — the complaint is about poke.com the product (integrations, AI behavior, messaging, etc.). This is the default.

## Capability gaps
If you identify that you could have triaged better *if* you had a capability you don't have (e.g., log query, video frame analysis, specific Recipe internals), report ONE gap in capability_gap: { title, detail }. Be disciplined — only genuinely load-bearing gaps. Wishful-thinking gaps are worse than no gaps.

## Vision
If an image is attached, extract visible error text, which screen/app is shown, and any relevant app state. Put findings in evidence.screenshot_text.

## Mention type (only set when called for a mention trigger; otherwise omit)
Set mentionType to one of:
- "new_issue": the message (or its parent, on a reply) describes a real issue. Proceed with full classification.
- "followup_on_existing": this is conversation about an already-reported issue. Use search_issues to find the best match; include its id in evidence.related_issues; set summary/reasoning briefly.
- "chatter": casual mention with no report ("lol @Pokedex is broken"). Do NOT create an issue.
- "question_to_bot": user is asking Pokedex something directly ("@Pokedex what do you do?"). Reply with a short help message pointing to /help. Do NOT create an issue.

## Output
Return ONLY valid JSON matching:
{
  "priority": one of [${priorities.map(p => `"${p}"`).join(', ')}],
  "category": one of [${categories.map(c => `"${c}"`).join(', ')}],
  "target": "poke_product" | "pokedex_bot",
  "summary": "one-line summary",
  "reasoning": "why this classification",
  "follow_up": "a question to ask the reporter, or null",
  "evidence": {
    "screenshot_text": "extracted text, or null",
    "related_issues": ["issueId", ...] | null,
    "active_incident": "name of active incident from get_poke_status, or null"
  },
  "capability_gap": { "title": "short", "detail": "1 sentence" } | null,
  "mentionType": "new_issue" | "followup_on_existing" | "chatter" | "question_to_bot" | null
}`;
}

function parseClassification(content) {
  let clean = (content || '').trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  let parsed;
  try { parsed = JSON.parse(clean); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!VALID_PRIORITIES.includes(parsed.priority)) parsed.priority = 'unclassified';
  if (!VALID_TARGETS.includes(parsed.target)) parsed.target = 'poke_product';
  const validCategories = getConfig('categories') || ['bug', 'feature_request', 'ux_issue', 'performance', 'security', 'suggestion', 'other'];
  if (!validCategories.includes(parsed.category)) parsed.category = 'other';
  if (typeof parsed.summary !== 'string') return null;
  parsed.reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  parsed.follow_up = typeof parsed.follow_up === 'string' ? parsed.follow_up : null;
  parsed.evidence = parsed.evidence && typeof parsed.evidence === 'object' ? parsed.evidence : {};
  parsed.evidence.screenshot_text = parsed.evidence.screenshot_text || null;
  parsed.evidence.related_issues = Array.isArray(parsed.evidence.related_issues) ? parsed.evidence.related_issues : null;
  parsed.evidence.active_incident = parsed.evidence.active_incident || null;
  parsed.capability_gap = parsed.capability_gap && typeof parsed.capability_gap === 'object'
    ? { title: String(parsed.capability_gap.title || '').slice(0, 100), detail: String(parsed.capability_gap.detail || '').slice(0, 500) }
    : null;
  parsed.mentionType = ['new_issue', 'followup_on_existing', 'chatter', 'question_to_bot'].includes(parsed.mentionType)
    ? parsed.mentionType
    : null;
  return parsed;
}

function fallbackClassification(text, reason) {
  return {
    priority: 'unclassified',
    category: 'other',
    target: 'poke_product',
    summary: String(text || '').slice(0, 100),
    reasoning: `Agent fallback: ${reason}`,
    follow_up: null,
    evidence: { screenshot_text: null, related_issues: null, active_incident: null },
    capability_gap: null,
    agentMeta: { fallbackReason: reason, toolCallsMade: 0, durationMs: 0 },
  };
}

async function triageIssue({ text, images = [], ctx, openrouter, parentMessage = null, triggerHint = null }) {
  const or = openrouter || require('./openrouter');
  const configuredMax = getConfig('agent_max_tool_calls');
  // Budget semantics: this caps the number of *individual tool dispatches*
  // across all iterations, not the number of agent loop rounds. A single
  // model turn may emit N parallel tool_calls; each counts toward the budget.
  // When toolCallsMade >= maxToolCalls, the next round is rejected with
  // fallbackReason: 'budget_exhausted'.
  const maxToolCalls = (typeof configuredMax === 'number' && configuredMax >= 0) ? configuredMax : 5;
  const startedAt = Date.now();

  const triggerLine = triggerHint === 'mention' ? '(Trigger: mention. Set mentionType in your output.)\n\n' : '';
  const baseContent = parentMessage
    ? `PARENT MESSAGE (the mention was a reply to this — classify its content, not the reply wrapper):\n[${parentMessage.author}]: ${parentMessage.content}\n\nREPLY FROM ${parentMessage.replierUsername || 'replier'}:\n${text}`
    : text;
  const userContent = triggerLine + baseContent;

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userContent },
  ];

  let toolCallsMade = 0;
  let pendingImages = images.slice();

  // +1 because the final iteration is for the model's classification response
  // after we've spent up to maxToolCalls on tool dispatch.
  for (let i = 0; i < maxToolCalls + 1; i++) {
    let response;
    try {
      response = await or.callWithTools({
        messages,
        tools: agentTools.TOOL_SCHEMAS,
        images: pendingImages,
      });
      pendingImages = []; // Images already attached on first successful call; never re-attach.
    } catch (err) {
      if (pendingImages.length > 0) {
        // Vision may be the culprit — drop images and retry once. We accept the false
        // positive that an unrelated 4xx/5xx wastes one retry; cost is negligible.
        pendingImages = [];
        continue;
      }
      return { ...fallbackClassification(text, `openrouter_error: ${String(err.message).slice(0, 200)}`), agentMeta: { fallbackReason: `openrouter_error: ${String(err.message).slice(0, 200)}`, toolCallsMade, durationMs: Date.now() - startedAt, modelUsed: getConfig('model') } };
    }

    if (response.tool_calls && response.tool_calls.length > 0) {
      if (toolCallsMade >= maxToolCalls) {
        return { ...fallbackClassification(text, 'budget_exhausted'), agentMeta: { fallbackReason: 'budget_exhausted', toolCallsMade, durationMs: Date.now() - startedAt, modelUsed: getConfig('model') } };
      }
      // Push the assistant turn ONCE with all tool_calls intact.
      messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls });
      for (const call of response.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
        const result = await agentTools.dispatch(call.function?.name, args, ctx);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
        toolCallsMade++;
      }
      continue;
    }

    const classification = parseClassification(response.content);
    if (!classification) {
      return { ...fallbackClassification(text, 'invalid_json'), agentMeta: { fallbackReason: 'invalid_json', toolCallsMade, durationMs: Date.now() - startedAt, modelUsed: getConfig('model') } };
    }
    return {
      ...classification,
      agentMeta: { toolCallsMade, durationMs: Date.now() - startedAt, modelUsed: getConfig('model') },
    };
  }

  return { ...fallbackClassification(text, 'budget_exhausted'), agentMeta: { fallbackReason: 'budget_exhausted', toolCallsMade, durationMs: Date.now() - startedAt, modelUsed: getConfig('model') } };
}

module.exports = { triageIssue, parseClassification, fallbackClassification };
