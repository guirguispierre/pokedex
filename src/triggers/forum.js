const { ChannelType, EmbedBuilder } = require('discord.js');
const admin = require('firebase-admin');
const { getConfig, getOwnerId } = require('../config/config');
const { classifyIssue } = require('../services/openrouter');
const agentTriage = require('../services/agentTriage');
const capabilityGap = require('../services/capabilityGap');
const firestore = require('../services/firestore');
const { postIssueEmbed, buildIssueEmbed } = require('../services/triage');
const { evaluateContext, buildConversationHistory, processConversationResponse } = require('../services/contextEvaluator');
const { findDuplicate, findDuplicateAI } = require('../services/duplicates');
const { canBotReplyInThread } = require('./thread');

function collectImageUrls(message) {
  if (!message?.attachments?.size) return [];
  const out = [];
  for (const [, att] of message.attachments) {
    if ((att.contentType || '').startsWith('image/')) out.push(att.url);
  }
  return out;
}

const STARTER_MSG_RETRIES = 3;
const STARTER_MSG_DELAY_MS = 2000;

async function handleForumPost(thread) {
  // Only handle forum channel threads
  if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

  // Check if this is the configured feedback forum
  const feedbackForum = getConfig('feedback_forum') || 'feedback';
  const parentName = thread.parent.name.toLowerCase();
  const parentId = thread.parent.id;
  if (parentName !== feedbackForum.toLowerCase() && parentId !== feedbackForum) return;

  // Join the thread so the bot can send messages
  try {
    await thread.join();
  } catch (err) {
    console.error('Failed to join forum thread:', err.message);
    return;
  }

  // Fetch starter message with retries
  let starterMessage = null;
  for (let i = 0; i < STARTER_MSG_RETRIES; i++) {
    try {
      starterMessage = await thread.fetchStarterMessage();
      if (starterMessage) break;
    } catch {
      // May not be available yet
    }
    await new Promise(resolve => setTimeout(resolve, STARTER_MSG_DELAY_MS));
  }

  if (!starterMessage || !starterMessage.content?.trim()) {
    console.warn(`Forum thread ${thread.id} has no starter message after retries — skipping`);
    return;
  }

  const text = starterMessage.content.trim();
  const guild = thread.guild;

  // Resolve reporter name early for the placeholder issue
  let reporterName = 'unknown';
  try {
    const member = await guild.members.fetch(thread.ownerId);
    reporterName = member.user.username;
  } catch {
    reporterName = starterMessage.author?.username || 'unknown';
  }

  // Phase 1: Save a placeholder issue with initialProcessing=true
  // This prevents thread.js from double-processing the starter message
  const placeholderData = {
    source: 'forum',
    threadId: thread.id,
    channelId: thread.parentId,
    guildId: guild.id,
    messageId: starterMessage.id,
    reporterId: thread.ownerId,
    reporterName,
    text,
    priority: 'unclassified',
    category: 'other',
    summary: text.slice(0, 100),
    reasoning: 'Pending classification',
    initialProcessing: true,
  };
  const issueId = await firestore.saveIssue(placeholderData);

  // Phase 2: Classify while the guard is active
  // Resolve forum tags
  const availableTags = thread.parent.availableTags || [];
  const forumTags = (thread.appliedTags || []).map(tagId => {
    const tag = availableTags.find(t => t.id === tagId);
    return tag?.name || 'unknown';
  });

  const classificationInput = `${thread.name}\n\n${text}`;
  const imageUrls = collectImageUrls(starterMessage);
  let classification;
  if (getConfig('agent_enabled') !== false) {
    classification = await agentTriage.triageIssue({
      text: classificationInput,
      images: imageUrls,
      ctx: {
        firestore,
        guild: thread.guild,
        channelId: thread.parentId || thread.id,
        reporterId: thread.ownerId,
        reporterName,
      },
    });
  } else {
    classification = await classifyIssue(classificationInput);
    classification.target = 'poke_product';
    classification.evidence = classification.evidence || { screenshot_text: null, related_issues: null, active_incident: null };
  }

  // --- Duplicate detection: check if this matches an existing open issue ---
  try {
    const openIssues = await firestore.getOpenIssues(100);
    // Exclude the placeholder we just created
    const otherIssues = openIssues.filter(i => i.id !== issueId);

    // Try Jaccard first (fast), then AI (accurate)
    let duplicateMatch = findDuplicate(classification.summary, text, otherIssues);
    if (!duplicateMatch) {
      duplicateMatch = await findDuplicateAI(classification.summary, classification.category, otherIssues);
    }

    if (duplicateMatch) {
      const existing = duplicateMatch.issue;
      const similarity = Math.round(duplicateMatch.score * 100);

      // Merge into existing issue: add reporter, append context
      await firestore.addReporter(existing.id, thread.ownerId, reporterName);
      await firestore.appendThreadContext(
        existing.id,
        `[New feedback post "${thread.name}" by ${reporterName}]: ${text.slice(0, 1500)}`
      );
      await firestore.updateIssueThreadId(existing.id, thread.id);

      // Delete the placeholder issue we created
      const db = admin.firestore();
      await db.collection('issues').doc(issueId).delete();

      // Refresh the triage embed on the existing issue
      const updatedIssue = await firestore.getIssueById(existing.id);
      const reporterCount = (updatedIssue.reporterIds || []).length;
      const triageChannelName = getConfig('triage_channel') || 'eng-triage';
      if (updatedIssue.triageMessageId) {
        const triageChannel = guild.channels.cache.find(
          ch => ch.name === triageChannelName && ch.isTextBased()
        );
        if (triageChannel) {
          try {
            const triageMsg = await triageChannel.messages.fetch(updatedIssue.triageMessageId);
            const embed = buildIssueEmbed(updatedIssue, existing.id);
            embed.addFields({
              name: 'Affected Users',
              value: `**${reporterCount}** unique reporter${reporterCount !== 1 ? 's' : ''}`,
              inline: true,
            });
            embed.setTimestamp();
            await triageMsg.edit({ embeds: [embed] });
          } catch { /* triage message may be deleted */ }
        }
      }

      // Notify in the thread that this was merged
      const mergeEmbed = new EmbedBuilder()
        .setColor(0xffa500)
        .setTitle('Linked to Existing Issue')
        .setDescription(
          `This feedback matches an existing issue. I've added your report as additional context.\n\n` +
          `Future messages here will automatically update the issue.`
        )
        .addFields(
          { name: 'Existing Issue', value: existing.summary || 'No summary', inline: false },
          { name: 'Match', value: `${similarity}%`, inline: true },
          { name: 'Priority', value: existing.priority || 'unclassified', inline: true },
          { name: 'Reporters', value: `**${reporterCount}**`, inline: true },
        )
        .setFooter({ text: `Issue ID: ${existing.id}` })
        .setTimestamp();

      await thread.send({ embeds: [mergeEmbed] });

      // Still ask for context on the existing issue
      const history = buildConversationHistory([starterMessage]);
      const evaluation = await evaluateContext(updatedIssue, history);
      await processConversationResponse(starterMessage, updatedIssue, existing.id, evaluation, {
        canReply: () => canBotReplyInThread(thread.id),
      });
      return;
    }
  } catch (err) {
    console.error('Forum duplicate detection failed, proceeding with new issue:', err.message);
  }

  // Collect attachments from starter message
  const attachments = [...starterMessage.attachments.values()].map(a => ({
    url: a.url,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    isImage: a.contentType?.startsWith('image/') || false,
  }));

  // Phase 3: Update the issue with full classification and clear the guard
  await firestore.updateIssueFields(issueId, {
    forumTags,
    priority: classification.priority,
    category: classification.category,
    summary: classification.summary,
    reasoning: classification.reasoning,
    target: classification.target || 'poke_product',
    evidence: classification.evidence || null,
    agentMeta: classification.agentMeta || null,
    lastEvaluatedAt: new Date().toISOString(),
    attachments,
    initialProcessing: false,
  });

  // Publish feedback to website automatically
  await firestore.saveFeedback({
    messageId: starterMessage.id,
    threadId: thread.id,
    threadName: thread.name,
    authorId: thread.ownerId,
    authorName: reporterName,
    content: text,
    summary: classification.summary,
    category: classification.category,
    priority: classification.priority,
    forumTags,
    attachments: attachments.filter(a => a.isImage).map(a => ({ url: a.url, name: a.name })),
  });

  // Post triage embed
  const savedIssue = await firestore.getIssueById(issueId);
  const triageMessageId = await postIssueEmbed(guild, savedIssue, issueId);
  if (triageMessageId) {
    await firestore.updateIssueTriageMessageId(issueId, triageMessageId);
  }

  // Record capability gap if agent surfaced one (mirrors pipeline.processIssue)
  if (classification.capability_gap && issueId) {
    try {
      await capabilityGap.record({
        gap: classification.capability_gap,
        issueId,
        guild: thread.guild,
        firestore,
        ownerId: getOwnerId(),
        channelName: getConfig('pokedex_self_channel') || 'pokedex-testing',
      });
    } catch (err) {
      console.error('forum: capability gap record failed:', err.message);
    }
  }

  // Run context evaluator for first follow-up (wrapped so failures don't break triage)
  try {
    const issueWithTriage = await firestore.getIssueById(issueId);
    const history = buildConversationHistory([starterMessage]);
    const evaluation = await evaluateContext(issueWithTriage, history);

    // Use shared helper for responseMode + auto-resolve (I2)
    await processConversationResponse(starterMessage, issueWithTriage, issueId, evaluation, {
      canReply: () => canBotReplyInThread(thread.id),
    });
  } catch (err) {
    const errorDetail = err instanceof Error ? (err.stack || err.message) : String(err);
    console.error('Context evaluator failed for issue', issueId, ':', errorDetail);
  }
}

module.exports = { handleForumPost };
