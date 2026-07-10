const { getConfig } = require('../config/config');
const { hasOpenRouterConfig } = require('../config/featureGates');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function openRouterDisabledResult(text, reason = 'OpenRouter disabled: OPENROUTER_API_KEY is missing') {
  return {
    priority: 'unclassified',
    category: 'other',
    summary: String(text || '').slice(0, 100),
    reasoning: reason,
    raw: null,
  };
}

function buildSystemPrompt() {
  const priorities = getConfig('priorities');
  const categories = getConfig('categories');

  return `You are Pokedex, a smart issue triage bot for poke.com's Discord community. You deeply understand the platform and its common issues.

## Platform Context
poke.com is an AI assistant that lives inside messaging apps (iMessage, WhatsApp, SMS). It acts as a proactive digital companion that:
- Connects to users' email, calendar, files, and productivity tools
- Integrates with services like Gmail, Outlook, Google Calendar, Notion, Linear, GitHub, Asana, Todoist, Ramp, Netlify, Vercel, Supabase
- Drafts replies, manages invoices, reschedules meetings, books travel
- Uses "Recipes" — pre-built workflow templates for common tasks
- Learns user preferences and context to provide personalized assistance
- Operates through natural text conversations in chat apps

## Common Issue Patterns
- Messaging integration bugs (iMessage/WhatsApp not receiving responses, delayed replies, messages not sending)
- Third-party connection failures (Gmail sync broken, calendar not updating, GitHub/Linear integration disconnected)
- AI response quality (wrong context, hallucinated info, ignored preferences, bad suggestions)
- Recipe/workflow issues (recipes not triggering, wrong actions taken, automation failures)
- Account/auth issues (login problems, OAuth failures, can't connect services)
- Performance (slow responses, timeouts, assistant not responding)
- Privacy/security concerns (data access questions, unauthorized actions, wrong data shown)
- Billing/subscription issues

## Your Job
Analyze the user's message and classify the issue. If the report is vague or missing critical info, include a follow-up question.

Return ONLY valid JSON with these exact fields:
{
  "priority": one of [${priorities.map(p => `"${p}"`).join(', ')}],
  "category": one of [${categories.map(c => `"${c}"`).join(', ')}],
  "summary": "One-line summary of the issue",
  "reasoning": "Brief explanation of why you chose this priority and category",
  "follow_up": "A follow-up question to ask the user for more details, or null if the report is clear enough"
}

## Priority Guidelines
- **critical**: Data loss, security/privacy breach, unauthorized actions taken, billing charged incorrectly, assistant taking destructive actions
- **high**: Core feature broken for many users (messaging not working, major integration down), can't login, assistant completely unresponsive
- **medium**: Specific integration broken, workaround exists, affects some users, AI giving wrong but non-harmful responses
- **low**: Minor UI glitch, feature request, recipe suggestion, nice-to-have improvement

If the message is unclear or not a real issue, use priority "low" and category "other" and ask a follow-up question to clarify.`;
}

function validateResponse(parsed) {
  const priorities = getConfig('priorities');
  const categories = getConfig('categories');

  if (!parsed || typeof parsed !== 'object') return false;
  if (!priorities.includes(parsed.priority)) return false;
  if (!categories.includes(parsed.category)) return false;
  if (typeof parsed.summary !== 'string') return false;
  if (typeof parsed.reasoning !== 'string') return false;
  // follow_up is optional — can be string or null
  if (parsed.follow_up !== null && parsed.follow_up !== undefined && typeof parsed.follow_up !== 'string') return false;
  return true;
}

async function classifyIssue(text) {
  const model = getConfig('model');

  if (!hasOpenRouterConfig()) {
    return openRouterDisabledResult(text);
  }

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://poke.com',
        'X-Title': 'Poke Issue Triage Bot',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: text },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error(`OpenRouter API error: ${response.status} ${response.statusText}`);
      return { priority: 'unclassified', category: 'other', summary: text.slice(0, 100), reasoning: 'API request failed', raw: null };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    // Strip markdown code fences if present (e.g. ```json ... ```)
    let cleanContent = content?.trim() ?? '';
    if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(cleanContent);
    } catch {
      console.error('Failed to parse OpenRouter response as JSON:', content);
      return { priority: 'unclassified', category: 'other', summary: text.slice(0, 100), reasoning: 'AI response was not valid JSON', raw: content };
    }

    if (!validateResponse(parsed)) {
      console.error('OpenRouter response failed validation:', parsed);
      return { priority: 'unclassified', category: 'other', summary: text.slice(0, 100), reasoning: 'AI response had invalid fields', raw: content };
    }

    return { ...parsed, raw: null };
  } catch (err) {
    console.error('OpenRouter request failed:', err.message);
    return { priority: 'unclassified', category: 'other', summary: text.slice(0, 100), reasoning: `Error: ${err.message}`, raw: null };
  }
}

async function evaluateIssueContext(issue, conversationHistory, extraHint) {
  const model = getConfig('model');

  if (!hasOpenRouterConfig()) {
    return { ...normalizeEvaluation({}), responseMode: 'ignore', shouldReply: false };
  }

  const transcript = conversationHistory
    .map(m => `[${m.role || (m.isBot ? 'BOT' : 'OTHER')}] ${m.content}`)
    .join('\n');

  const contextChecklist = {
    bug: 'steps to reproduce, expected vs actual behavior, environment/platform, frequency, screenshots or logs',
    feature_request: 'use case / problem being solved, current workaround, importance to their workflow',
    ux_issue: 'what they were trying to do, what confused them, where in the app',
    performance: 'what is slow, how slow (quantify), when it started, device/network info',
  };

  const checklist = contextChecklist[issue.category] || contextChecklist.bug;

  const systemPrompt = `You are Pokedex, an automated triage bot for poke.com's Discord. Your sole job is to gather just enough context from the original reporter so a developer can investigate, then file the report.

## Current Issue
- Summary: ${issue.summary}
- Priority: ${issue.priority}
- Category: ${(issue.category || 'other').replace(/_/g, ' ')}
- Original report: ${(issue.text || '').slice(0, 500)}

## Context Checklist (guidance, not rigid)
For this category, good reports usually include: ${checklist}

## IDENTITY
If no [BOT] message has appeared yet in the transcript, your reply MUST begin with: "I'm pokedex, an automated bot that collects bug details for the engineering team. I'm not support — I'll ask 1–3 quick questions, then file your report. A human follows up from there."
Never claim to be human. Never omit this introduction when it is the first [BOT] turn.

## WHOSE MESSAGES MATTER
Each transcript line is tagged [OP], [MOD], [OTHER], or [BOT].
- ONLY [OP] lines are bug information.
- [MOD] and [OTHER] lines are context for your awareness but must NOT drive your questions, summaries, contextFields, distinctBugs, or receipt.
- Never direct a question at [MOD] or [OTHER]. Stay silent toward them — respond only to [OP].

## CORE LOOP (evaluate after each [OP] message)
Ask yourself:
1. Do you have expected behavior, actual behavior, feature area, and frequency — all from [OP] lines?
2. Is the [OP] expressing frustration or urgency?
3. Have you already asked 2 or more questions in this conversation?
If YES to any of the above → set shouldFile=true and produce a receipt. Otherwise ask ONE question (askedQuestion=true). Bias toward filing early rather than asking more questions.

## QUESTION RULES
- One question per message — never two at once.
- Never ask the [OP] to perform diagnosis steps (re-run, restart, open incognito, clear cache, etc.).
- Never re-ask something the [OP] has already answered, even implicitly.
- If the [OP] pastes something that looks like a spec, treat it as multiple answers at once.

## BANNED OPENERS
Do not start any reply with: "Got it —", "Thanks for clarifying", "That's really helpful", "That's helpful context", or "So it sounds like".
Do not echo the user's message back as a mid-thread summary.

## OFF-LIMITS
Do not diagnose, offer workarounds, explain how poke.com works, or make promises.
If the [OP] asks a support question, respond with exactly: "That's a human question — I've flagged it on the ticket."

## MULTIPLE BUGS
If the [OP]'s messages surface 2 or more distinct bugs, populate distinctBugs with one entry per bug (each with summary, expected, actual, feature, frequency).

## FILING
When shouldFile=true:
- Set responseMode="reply", askedQuestion=false.
- Fill contextFields with values from [OP] lines only.
- Fill receipt with {issue, expected, actual, scope, expectedResponse}.
- Keep the reply field short or empty — the code renders the user-facing receipt from the receipt object.

## OTHER RULES
- responseMode: "ignore" for thanks, "ok", emoji-only, or third-party chatter. "react" when the [OP] confirms info without needing a reply. "reply" when a response is warranted.
- Return reclassify: true when new [OP] info could change priority or category.
- Mark complete: true ONLY when a developer would have enough to start without further questions.
- Only mark resolved: true when the [OP] unambiguously indicates resolution (e.g., "solved", "fixed", "nvm works now"). Hedged phrases like "we need this fixed" do NOT count.
- If unsure whether resolved, set resolved: false AND responseMode: "reply" with reply: "sounds like this is working now — should I close this out?"
${extraHint ? `\n## Additional Instruction\n${extraHint}` : ''}

Return ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "complete": boolean,
  "missing": ["list of what is still needed, or empty array"],
  "responseMode": "ignore" | "react" | "reply",
  "reply": "what to say to the [OP]" or null,
  "triageUpdate": "new context summary for the engineering triage embed" or null,
  "reclassify": boolean,
  "resolved": boolean,
  "resolvedReason": "one-line reason" or null,
  "askedQuestion": boolean — true when your reply contains a question directed at the [OP],
  "shouldFile": boolean — true when you have enough context to file or have hit the question limit,
  "contextFields": {
    "expected": "what the [OP] expected to happen" or null,
    "actual": "what actually happened" or null,
    "feature": "the feature or area involved" or null,
    "frequency": "how often it happens (always, sometimes, once)" or null
  },
  "distinctBugs": [
    { "summary": "...", "expected": "...", "actual": "...", "feature": "...", "frequency": "..." }
  ],
  "receipt": {
    "issue": "one-line description of the filed issue",
    "expected": "expected behavior",
    "actual": "actual behavior",
    "scope": "who/what is affected",
    "expectedResponse": "what the reporter wants to happen next"
  } or null
}`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://poke.com',
        'X-Title': 'Pokedex Context Evaluator',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Conversation so far:\n${transcript}` },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error(`Context evaluator API error: ${response.status}`);
      return { ...normalizeEvaluation({}), responseMode: 'ignore', shouldReply: false };
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(content);
    return normalizeEvaluation(parsed);
  } catch (err) {
    console.error('Context evaluator failed:', err.message);
    return { ...normalizeEvaluation({}), responseMode: 'ignore', shouldReply: false };
  }
}

function normalizeEvaluation(parsed = {}) {
  parsed = parsed || {};
  const cf = (parsed && typeof parsed.contextFields === 'object' && !Array.isArray(parsed.contextFields) && parsed.contextFields) || {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    complete: !!parsed.complete,
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    responseMode: ['ignore', 'react', 'reply'].includes(parsed.responseMode) ? parsed.responseMode : 'react',
    // Keep `shouldReply` as derived alias for forum-path callers until Task 15 unifies them.
    shouldReply: parsed.responseMode === 'reply',
    reply: typeof parsed.reply === 'string' ? parsed.reply : null,
    triageUpdate: typeof parsed.triageUpdate === 'string' ? parsed.triageUpdate : null,
    reclassify: !!parsed.reclassify,
    resolved: !!parsed.resolved,
    resolvedReason: typeof parsed.resolvedReason === 'string' ? parsed.resolvedReason : null,
    askedQuestion: !!parsed.askedQuestion,
    shouldFile: !!parsed.shouldFile,
    contextFields: {
      expected: str(cf.expected),
      actual: str(cf.actual),
      feature: str(cf.feature),
      frequency: str(cf.frequency),
    },
    distinctBugs: Array.isArray(parsed.distinctBugs) ? parsed.distinctBugs : [],
    receipt: (parsed && typeof parsed.receipt === 'object' && !Array.isArray(parsed.receipt) && parsed.receipt) || null,
  };
}

async function callWithTools({ messages, tools, images = [], model: overrideModel, maxTokens = 2000 }) {
  const model = overrideModel || getConfig('model');

  if (!hasOpenRouterConfig()) {
    throw new Error('OpenRouter disabled: OPENROUTER_API_KEY is missing');
  }

  // Inject images into the first user message if provided.
  const payloadMessages = messages.map(m => ({ ...m }));
  if (images.length > 0) {
    const firstUserIdx = payloadMessages.findIndex(m => m.role === 'user');
    if (firstUserIdx >= 0) {
      const existing = payloadMessages[firstUserIdx];
      const parts = [
        { type: 'text', text: typeof existing.content === 'string' ? existing.content : '' },
        ...images.map(url => ({ type: 'image_url', image_url: { url } })),
      ];
      payloadMessages[firstUserIdx] = { role: 'user', content: parts };
    }
  }

  const body = {
    model,
    messages: payloadMessages,
    max_tokens: maxTokens,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  } else {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://poke.com',
      'X-Title': 'Pokedex Agent Triage',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`openrouter ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('openrouter: no choices');

  return {
    content: typeof msg.content === 'string' ? msg.content : null,
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    usage: data.usage || null,
  };
}

module.exports = { classifyIssue, evaluateIssueContext, callWithTools, normalizeEvaluation };