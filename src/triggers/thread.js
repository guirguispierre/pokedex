const firestore = require('../services/firestore');
const { classifyIssue } = require('../services/openrouter');
const triage = require('../services/triage');
const { getConfig } = require('../config/config');
const { evaluateContext, processEvaluation, buildConversationHistory, processConversationResponse } = require('../services/contextEvaluator');

// Debounce map — wait a bit in case the user sends multiple messages quickly
const pendingUpdates = new Map();
const DEBOUNCE_MS = 5000;

// Rate-limit state: per-thread reply timestamps
const replyHistory = new Map(); // threadId -> [timestamps]

function canBotReplyInThread(threadId, nowMs = Date.now()) {
  const maxReplies = Number(require('../config/config').getConfig('agent_max_replies_per_thread_per_10m')) || 3;
  const windowMs = 10 * 60 * 1000;
  const history = (replyHistory.get(threadId) || []).filter(t => nowMs - t < windowMs);
  if (history.length >= maxReplies) {
    replyHistory.set(threadId, history);
    return false;
  }
  history.push(nowMs);
  replyHistory.set(threadId, history);
  return true;
}

function _reset() { replyHistory.clear(); }

function shouldAutoResolve(evaluation, messageAuthorId, reporterId) {
  if (!evaluation?.resolved) return false;
  if (messageAuthorId !== reporterId) return false;
  return true;
}

async function handleThreadMessage(message) {
  // Only handle messages in threads
  if (!message.channel.isThread()) return false;

  const threadId = message.channel.id;

  // Look up if this thread is linked to an issue
  const issue = await firestore.getIssueByThreadId(threadId);
  if (!issue) return false; // Not one of our issue threads — let caller handle it

  // Guard: forum.js is still processing this thread — don't interfere
  if (issue.initialProcessing) return true;

  const newText = message.content?.trim();
  if (!newText) return true; // Is an issue thread but empty message — still claim it

  // Append the new context to Firestore (include who sent it)
  const prefix = message.author.id === issue.reporterId ? '' : `[${message.author.username}]: `;
  await firestore.appendThreadContext(issue.id, `${prefix}${newText}`);

  // Debounce — if user is typing multiple messages, wait before reclassifying
  if (pendingUpdates.has(issue.id)) {
    clearTimeout(pendingUpdates.get(issue.id));
  }

  pendingUpdates.set(issue.id, setTimeout(async () => {
    pendingUpdates.delete(issue.id);
    try {
      const updatedIssue = await firestore.getIssueByThreadId(threadId);
      if (!updatedIssue) return;

      // Gather recent thread messages (cap 500).
      const allMessages = [];
      let lastId;
      const MAX = 500;
      while (allMessages.length < MAX) {
        const batch = await message.channel.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
        if (batch.size === 0) break;
        allMessages.push(...batch.values());
        if (batch.size < 100) break;
        lastId = batch.last().id;
      }
      allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      const { buildConversationHistory, collectNewImageUrls } = require('../services/contextEvaluator');
      const history = buildConversationHistory(allMessages);
      const newImages = collectNewImageUrls(allMessages, updatedIssue.lastEvaluatedAt);

      // Vision pre-pass: if there are new screenshots since last evaluation,
      // run agent triage on them to extract text, then pass that text as a hint
      // to the context evaluator.
      let visionSummary = null;
      if (newImages.length > 0) {
        const agentTriage = require('../services/agentTriage');
        const { getConfig } = require('../config/config');
        if (getConfig('agent_enabled') !== false) {
          try {
            const result = await agentTriage.triageIssue({
              text: `(vision-only follow-up for issue ${updatedIssue.id}) describe each screenshot briefly and extract visible error text`,
              images: newImages,
              ctx: { firestore, guild: message.guild, channelId: message.channel.id, reporterId: updatedIssue.reporterId },
            });
            visionSummary = result?.evidence?.screenshot_text || null;
          } catch (err) {
            console.error('thread vision pass failed:', err.message);
          }
        }
      }

      const evaluation = await require('../services/contextEvaluator').evaluateContext(
        updatedIssue,
        history,
        visionSummary ? `[Extracted from new screenshots]:\n${visionSummary}` : undefined
      );

      const isResolving = shouldAutoResolve(evaluation, message.author.id, updatedIssue.reporterId);

      if (!isResolving) {
        // Only run the regular evaluation flow when NOT resolving.
        await require('../services/contextEvaluator').processEvaluation(message.guild, updatedIssue, updatedIssue.id, evaluation);
      }

      // Unified auto-resolve + responseMode handling via shared helper
      await processConversationResponse(message, updatedIssue, updatedIssue.id, evaluation, {
        canReply: () => canBotReplyInThread(threadId),
      });

      // Bump lastEvaluatedAt so next invocation only fetches newer images.
      try { await firestore.setIssueLastEvaluatedAt(updatedIssue.id, new Date().toISOString()); } catch {}
    } catch (err) {
      console.error('Error processing thread context update:', err);
    }
  }, DEBOUNCE_MS));

  return true; // Signal that this was an issue thread — don't create a new issue
}

module.exports = { handleThreadMessage, canBotReplyInThread, _reset, shouldAutoResolve };
