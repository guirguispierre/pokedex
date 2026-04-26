const { evaluateIssueContext } = require('./openrouter');
const { classifyIssue } = require('./openrouter');
const firestore = require('./firestore');
const { buildIssueEmbed, findTriageChannel, postIssueEmbed } = require('./triage');

async function evaluateContext(issue, conversationHistory, extraHint) {
  return evaluateIssueContext(issue, conversationHistory, extraHint);
}

async function processEvaluation(guild, issue, issueId, evaluation) {
  // Update triage embed if there's new context to show
  if (evaluation.triageUpdate && issue.triageMessageId) {
    const triageChannel = findTriageChannel(guild, issue.target);
    if (triageChannel) {
      try {
        const triageMsg = await triageChannel.messages.fetch(issue.triageMessageId);
        const embed = buildIssueEmbed(issue, issueId);
        embed.addFields({ name: '💬 Context Update', value: evaluation.triageUpdate.slice(0, 1024) });
        embed.setTimestamp();
        await triageMsg.edit({ embeds: [embed] });
      } catch {
        // Triage message may have been deleted
      }
    }
  }

  // Reclassify if needed
  if (evaluation.reclassify) {
    const threadContext = issue.threadContext || [];
    const additionalInfo = threadContext.map(c => c.text).join('\n');
    const fullContext = `Original report: ${issue.text}\n\nAdditional information:\n${additionalInfo}`;
    const newClassification = await classifyIssue(fullContext);
    await firestore.updateIssueClassification(issueId, newClassification);
    // Move triage embed to new channel if target flipped (I4)
    await maybeMoveTriageEmbedAcrossChannels(guild, issue, newClassification, issueId);
  }

  // Mark context complete
  if (evaluation.complete && !issue.contextComplete) {
    await firestore.updateIssueFields(issueId, {
      contextComplete: true,
      contextCompletedAt: new Date().toISOString(),
    });
    await updateContextBadge(guild, { ...issue, contextComplete: true }, issueId);
  }
}

async function updateContextBadge(guild, issue, issueId) {
  if (!issue.triageMessageId) return;
  const triageChannel = findTriageChannel(guild, issue.target);
  if (!triageChannel) return;

  try {
    const triageMsg = await triageChannel.messages.fetch(issue.triageMessageId);
    const embed = buildIssueEmbed(issue, issueId);
    embed.setTimestamp();
    await triageMsg.edit({ embeds: [embed] });
  } catch {
    // Triage message may have been deleted
  }
}

function buildConversationHistory(messages) {
  return messages.map(m => ({
    author: m.author?.username || 'unknown',
    isBot: m.author?.bot || false,
    content: m.content || '',
    attachments: [...(m.attachments?.values() || [])].map(a => ({ url: a.url, name: a.name })),
    createdAt: m.createdAt?.toISOString() || new Date().toISOString(),
  }));
}

function collectNewImageUrls(messages, sinceIso) {
  const cutoff = sinceIso ? Date.parse(sinceIso) : 0;
  const urls = [];
  for (const m of messages) {
    const createdAt = m.createdAt?.getTime?.() || Date.parse(m.createdAt) || 0;
    if (createdAt <= cutoff) continue;
    const atts = m.attachments ? (m.attachments.values ? Array.from(m.attachments.values()) : m.attachments) : [];
    for (const a of atts) {
      if ((a.contentType || '').startsWith('image/') && a.url) urls.push(a.url);
    }
  }
  return urls;
}

/**
 * Handle the conversational side-effects of an evaluator response:
 * - Auto-resolve when reporter indicates resolution
 * - responseMode: ignore | react | reply (rate-limited via canReply)
 *
 * @param {Message} message - the Discord message that triggered evaluation
 * @param {Object} issue - the current issue document
 * @param {string} issueId - the issue id
 * @param {Object} evaluation - the evaluator return shape (responseMode, resolved, etc.)
 * @param {Object} options
 * @param {Function} options.canReply - () => boolean, rate-limit check
 */
async function processConversationResponse(message, issue, issueId, evaluation, options = {}) {
  const canReply = typeof options.canReply === 'function' ? options.canReply : () => true;

  const isReporter = message.author.id === issue.reporterId;
  const isResolving = evaluation?.resolved && isReporter;

  // Auto-resolve takes precedence over normal responseMode handling.
  if (isResolving) {
    try {
      await firestore.updateIssueResolution(issueId, {
        resolvedBy: 'reporter',
        resolvedReason: evaluation.resolvedReason,
      });
    } catch (err) {
      console.error('processConversationResponse: updateIssueResolution failed', err.message);
    }
    try {
      await message.channel.send({ content: 'Marked as resolved — reply if it comes back.' });
    } catch {}
    try {
      await updateContextBadge(message.guild, { ...issue, status: 'resolved' }, issueId);
    } catch {}
    return;
  }

  // responseMode handling
  if (evaluation?.responseMode === 'reply' && evaluation.reply && canReply()) {
    try { await message.channel.send({ content: evaluation.reply }); } catch {}
  } else if (evaluation?.responseMode === 'react') {
    try { await message.react('✅'); } catch {}
  }
  // ignore: do nothing
}

/**
 * Detect when a re-classification has flipped the issue's target and move the
 * triage embed across channels. Used after processEvaluation when reclassify
 * was true and the new classification has a different target than the stored one.
 *
 * @param {Object} guild
 * @param {Object} oldIssue - previous issue state with old target/triageMessageId
 * @param {Object} newClassification - { target, priority, category, summary, ... }
 * @param {string} issueId
 */
async function maybeMoveTriageEmbedAcrossChannels(guild, oldIssue, newClassification, issueId) {
  const oldTarget = oldIssue.target || 'poke_product';
  const newTarget = newClassification.target || 'poke_product';
  if (oldTarget === newTarget) return; // No move needed.

  const oldChannel = findTriageChannel(guild, oldTarget);
  const newChannel = findTriageChannel(guild, newTarget);
  if (!oldChannel || !newChannel || oldChannel.id === newChannel.id) return;

  // 1. Edit old embed to a "moved" stub.
  if (oldIssue.triageMessageId) {
    try {
      const oldMsg = await oldChannel.messages.fetch(oldIssue.triageMessageId);
      const stubEmbed = buildIssueEmbed(
        { ...oldIssue, ...newClassification, summary: `[Moved to #${newChannel.name}]: ${newClassification.summary || oldIssue.summary}` },
        issueId
      );
      await oldMsg.edit({ embeds: [stubEmbed] });
    } catch (err) {
      console.error('maybeMoveTriageEmbedAcrossChannels: edit old failed', err.message);
    }
  }

  // 2. Post fresh embed in new channel and update issue with new triageMessageId/triageChannelId.
  try {
    const updatedIssueShape = { ...oldIssue, ...newClassification, target: newTarget };
    const newMessageId = await postIssueEmbed(guild, updatedIssueShape, issueId);
    if (newMessageId) {
      await firestore.updateIssueFields(issueId, {
        target: newTarget,
        triageMessageId: newMessageId,
        triageChannelId: newChannel.id,
      });
    }
  } catch (err) {
    console.error('maybeMoveTriageEmbedAcrossChannels: post new failed', err.message);
  }
}

module.exports = { evaluateContext, processEvaluation, updateContextBadge, buildConversationHistory, collectNewImageUrls, processConversationResponse, maybeMoveTriageEmbedAcrossChannels };
