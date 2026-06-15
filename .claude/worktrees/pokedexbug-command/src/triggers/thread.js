const { EmbedBuilder } = require('discord.js');
const firestore = require('../services/firestore');
const { classifyIssue } = require('../services/openrouter');
const triage = require('../services/triage');
const { getConfig } = require('../config/config');
const { evaluateContext, processEvaluation, buildConversationHistory } = require('../services/contextEvaluator');

const PRIORITY_COLORS = {
  critical: 0xff0000,
  high: 0xff8c00,
  medium: 0xffd700,
  low: 0x00cc00,
  unclassified: 0x808080,
};

// Debounce map — wait a bit in case the user sends multiple messages quickly
const pendingUpdates = new Map();
const DEBOUNCE_MS = 5000;

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
      // Get the updated issue with all context
      const updatedIssue = await firestore.getIssueByThreadId(threadId);
      if (!updatedIssue) return;

      if (updatedIssue.source === 'forum') {
        // Forum issues: use context evaluator for smart replies
        const allMessages = [];
        let lastId;
        const MAX_CONTEXT_MESSAGES = 500;
        while (allMessages.length < MAX_CONTEXT_MESSAGES) {
          const batch = await message.channel.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
          if (batch.size === 0) break;
          allMessages.push(...batch.values());
          if (batch.size < 100) break;
          lastId = batch.last().id;
        }
        allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        const history = buildConversationHistory(allMessages);
        const evaluation = await evaluateContext(updatedIssue, history);

        // Process triage updates, reclassification, and context complete badge
        await processEvaluation(message.guild, updatedIssue, updatedIssue.id, evaluation);

        // Reply in the thread if evaluator says to
        if (evaluation.shouldReply && evaluation.reply) {
          await message.channel.send(evaluation.reply);
        }
      } else {
        // Non-forum issues: existing behavior (reclassify + generic acknowledgement)
        // Build full context for reclassification
        const threadContext = updatedIssue.threadContext || [];
        const additionalInfo = threadContext.map(c => c.text).join('\n');
        const fullContext = `Original report: ${updatedIssue.text}\n\nAdditional information from reporter:\n${additionalInfo}`;

        // Reclassify with full context
        const newClassification = await classifyIssue(fullContext);

        // Update Firestore with new classification
        await firestore.updateIssueClassification(updatedIssue.id, newClassification);

        // Check if priority or category changed
        const priorityChanged = newClassification.priority !== updatedIssue.priority;
        const categoryChanged = newClassification.category !== updatedIssue.category;

        // Always update the triage embed with new context
        if (updatedIssue.triageMessageId) {
          const triageChannelName = getConfig('triage_channel') || 'eng-triage';
          const guild = message.guild;
          const triageChannel = guild.channels.cache.find(
            ch => ch.name === triageChannelName && ch.isTextBased()
          );

          if (triageChannel) {
            try {
              const triageMsg = await triageChannel.messages.fetch(updatedIssue.triageMessageId);
              const updatedEmbed = triage.buildIssueEmbed(
                { ...updatedIssue, ...newClassification, text: updatedIssue.text },
                updatedIssue.id
              );

              // Show additional context from the thread
              const contextSummary = threadContext.map((c, i) => `${i + 1}. ${c.text.slice(0, 150)}`).join('\n');
              if (contextSummary) {
                updatedEmbed.addFields({ name: '💬 Additional Context', value: contextSummary.slice(0, 1024) });
              }

              if (priorityChanged || categoryChanged) {
                updatedEmbed.addFields({ name: '🔄 Reclassified', value: 'Updated with additional context from reporter' });
              } else {
                updatedEmbed.addFields({ name: '🔄 Updated', value: 'New context added by reporter' });
              }

              updatedEmbed.setTimestamp();
              await triageMsg.edit({ embeds: [updatedEmbed] });
            } catch {
              // Triage message may have been deleted
            }
          }
        }

        // Acknowledge in the thread
        const color = PRIORITY_COLORS[newClassification.priority] ?? 0x808080;
        const updateEmbed = new EmbedBuilder()
          .setColor(color)
          .setDescription(`Got it — I've updated this issue with your new info.`)
          .setFooter({ text: `Issue ID: ${updatedIssue.id}` });

        if (priorityChanged || categoryChanged) {
          const changes = [];
          if (priorityChanged) changes.push(`Priority: ${updatedIssue.priority} → **${newClassification.priority}**`);
          if (categoryChanged) changes.push(`Category: ${updatedIssue.category.replace(/_/g, ' ')} → **${newClassification.category.replace(/_/g, ' ')}**`);
          updateEmbed.addFields({ name: 'Classification Updated', value: changes.join('\n') });
        }

        await message.channel.send({ embeds: [updateEmbed] });
      }
    } catch (err) {
      console.error('Error processing thread context update:', err);
    }
  }, DEBOUNCE_MS));

  return true; // Signal that this was an issue thread — don't create a new issue
}

module.exports = { handleThreadMessage };
