const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { classifyIssue } = require('./openrouter');
const agentTriage = require('./agentTriage');
const capabilityGap = require('./capabilityGap');
const firestore = require('./firestore');
const triage = require('./triage');
const { getConfig, getOwnerId } = require('../config/config');
const { findDuplicate, findDuplicateAI } = require('./duplicates');

const PRIORITY_COLORS = {
  critical: 0xff0000,
  high: 0xff8c00,
  medium: 0xffd700,
  low: 0x00cc00,
  unclassified: 0x808080,
};

function collectImageUrls(message) {
  if (!message?.attachments?.size) return [];
  const out = [];
  for (const [, att] of message.attachments) {
    if ((att.contentType || '').startsWith('image/')) {
      out.push(att.url);
    }
  }
  return out;
}

async function processIssue(message, text, opts = {}) {
  // Exact message duplicate check
  const isDupe = await firestore.isDuplicate(message.id);
  if (isDupe) return;

  // Classify via agent loop (tool-use + vision). Fall back to single-shot if disabled.
  const imageUrls = collectImageUrls(message);
  let classification;
  if (getConfig('agent_enabled') !== false) {
    classification = await agentTriage.triageIssue({
      text,
      images: imageUrls,
      ctx: {
        firestore,
        guild: message.guild,
        channelId: message.channel.id,
        reporterId: message.author.id,
        reporterName: message.author.username,
      },
      parentMessage: opts.parentMessage || null,
      triggerHint: opts.trigger || null,
    });
  } else {
    classification = await classifyIssue(text);
    classification.target = 'poke_product';
    classification.evidence = classification.evidence || { screenshot_text: null, related_issues: null, active_incident: null };
  }

  // --- Early-exit on chatter / question_to_bot / followup_on_existing ---
  if (classification.mentionType === 'chatter') {
    console.log(`[pipeline] mention classified as chatter, skipping. message ${message.id}`);
    return;
  }

  if (classification.mentionType === 'question_to_bot') {
    try {
      await message.reply({
        content: 'I do bug triage for poke.com — if you have a bug or suggestion, describe it and I\'ll log it. Try `/help` for commands.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }

  if (classification.mentionType === 'followup_on_existing'
      && Array.isArray(classification.evidence?.related_issues)
      && classification.evidence.related_issues.length > 0) {
    const relatedId = classification.evidence.related_issues[0];
    try {
      await firestore.appendThreadContext(relatedId, `[From mention by ${message.author.username}]: ${text}`);
      await message.reply({
        content: `Linked to existing issue \`${relatedId}\`. Adding your note as context.`,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.error('followup_on_existing append failed:', err.message);
    }
    return;
  }
  // Otherwise treat as new_issue and fall through to the normal save path.

  // --- Semantic duplicate detection (Jaccard fast → AI accurate) ---
  try {
    const openIssues = await firestore.getOpenIssues(100);
    let match = findDuplicate(classification.summary, text, openIssues);
    if (!match) {
      match = await findDuplicateAI(classification.summary, classification.category, openIssues);
    }

    if (match) {
      // Found a potential duplicate — notify the reporter and link it
      await handleDuplicate(message, classification, match);
      return;
    }
  } catch (err) {
    console.error('Duplicate detection failed, proceeding with new issue:', err.message);
    // Continue creating the issue if duplicate check fails
  }

  // Collect attachments (screenshots, files)
  const attachments = [];
  if (message.attachments?.size > 0) {
    for (const [, att] of message.attachments) {
      attachments.push({
        url: att.url,
        proxyUrl: att.proxyURL,
        name: att.name,
        size: att.size,
        contentType: att.contentType || '',
        width: att.width || null,
        height: att.height || null,
        isImage: (att.contentType || '').startsWith('image/'),
      });
    }
  }

  // Build issue data
  const issueData = {
    messageId: message.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    reporterId: message.author.id,
    reporterName: message.author.username,
    text,
    priority: classification.priority,
    category: classification.category,
    summary: classification.summary,
    reasoning: classification.reasoning,
    attachments: attachments.length > 0 ? attachments : null,
    target: classification.target || 'poke_product',
    evidence: classification.evidence || null,
    agentMeta: classification.agentMeta || null,
    lastEvaluatedAt: new Date().toISOString(),
  };

  if (classification.raw) {
    issueData.rawAiResponse = classification.raw;
  }

  // Save to Firestore
  let issueId;
  try {
    issueId = await firestore.saveIssue(issueData);
  } catch (err) {
    console.error('Firestore write failed:', err.message);
    issueId = 'unknown';
  }

  // Post to triage channel
  const triageMessageId = await triage.postIssueEmbed(message.guild, { ...issueData, messageId: message.id }, issueId);

  // Update Firestore with triage message ID
  if (issueId !== 'unknown' && triageMessageId) {
    try {
      await firestore.updateIssueTriageMessageId(issueId, triageMessageId);
    } catch {
      // Best effort
    }
  }

  // Record capability gap if the agent surfaced one
  if (classification.capability_gap && issueId !== 'unknown') {
    try {
      await capabilityGap.record({
        gap: classification.capability_gap,
        issueId,
        guild: message.guild,
        firestore,
        ownerId: getOwnerId(),
        channelName: getConfig('pokedex_self_channel') || 'pokedex-testing',
      });
    } catch (err) {
      console.error('capability gap record failed:', err.message);
    }
  }

  // Acknowledge reply as embed
  const ack = getConfig('acknowledge');
  if (ack === true || ack === 'true') {
    try {
      const color = PRIORITY_COLORS[classification.priority] ?? 0x808080;
      const ackEmbed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${classification.priority.toUpperCase()} — ${classification.category.replace(/_/g, ' ')}`)
        .setDescription(classification.summary)
        .setFooter({ text: `Issue ID: ${issueId}` });

      if (classification.follow_up) {
        // Create a thread for follow-up conversation
        const thread = await message.startThread({
          name: `${classification.category.replace(/_/g, ' ')}: ${classification.summary.slice(0, 80)}`,
          autoArchiveDuration: 1440,
        });

        if (issueId !== 'unknown') {
          await firestore.updateIssueThreadId(issueId, thread.id).catch(() => {});
        }

        ackEmbed.addFields({ name: 'Follow-up', value: classification.follow_up });
        await thread.send({ embeds: [ackEmbed] });
        await thread.send(`<@${message.author.id}> ${classification.follow_up}`);
      } else {
        await message.reply({ embeds: [ackEmbed] });
      }
    } catch {
      // Best effort
    }
  }
}

async function handleDuplicate(message, classification, match) {
  const existingIssue = match.issue;
  const similarity = Math.round(match.score * 100);

  // Append this report as additional context to the existing issue
  try {
    await firestore.appendThreadContext(existingIssue.id, `[Duplicate report by ${message.author.username}]: ${message.content}`);
  } catch {
    // Best effort
  }

  // Build duplicate notification embed
  const embed = new EmbedBuilder()
    .setTitle('🔁 Possible Duplicate Detected')
    .setColor(0xffa500)
    .setDescription(`This looks similar to an existing issue.`)
    .addFields(
      { name: 'Your Report', value: classification.summary, inline: false },
      { name: 'Existing Issue', value: existingIssue.summary || 'No summary', inline: false },
      { name: 'Match Confidence', value: `${similarity}%`, inline: true },
      { name: 'Status', value: existingIssue.status || 'open', inline: true },
      { name: 'Priority', value: existingIssue.priority || 'unknown', inline: true },
    )
    .setFooter({ text: `Existing Issue ID: ${existingIssue.id}` })
    .setTimestamp();

  // Add buttons so the user can override if it's NOT a duplicate
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dupe_confirm_${existingIssue.id}_${message.id}`)
      .setLabel('Yes, same issue')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`dupe_new_${message.id}`)
      .setLabel('No, create new issue')
      .setEmoji('🆕')
      .setStyle(ButtonStyle.Primary),
  );

  await message.reply({ embeds: [embed], components: [row] });
}

/**
 * Process an issue skipping duplicate detection (used when user overrides dupe check).
 */
async function processIssueForced(message, text) {
  const isDupe = await firestore.isDuplicate(message.id);
  if (isDupe) return;

  // Classify via agent loop (tool-use + vision). Fall back to single-shot if disabled.
  const imageUrls = collectImageUrls(message);
  let classification;
  if (getConfig('agent_enabled') !== false) {
    classification = await agentTriage.triageIssue({
      text,
      images: imageUrls,
      ctx: {
        firestore,
        guild: message.guild,
        channelId: message.channel.id,
        reporterId: message.author.id,
        reporterName: message.author.username,
      },
    });
  } else {
    classification = await classifyIssue(text);
    classification.target = 'poke_product';
    classification.evidence = classification.evidence || { screenshot_text: null, related_issues: null, active_incident: null };
  }

  const attachments = [];
  if (message.attachments?.size > 0) {
    for (const [, att] of message.attachments) {
      attachments.push({
        url: att.url, proxyUrl: att.proxyURL, name: att.name,
        size: att.size, contentType: att.contentType || '',
        width: att.width || null, height: att.height || null,
        isImage: (att.contentType || '').startsWith('image/'),
      });
    }
  }

  const issueData = {
    messageId: message.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    reporterId: message.author.id,
    reporterName: message.author.username,
    text,
    priority: classification.priority,
    category: classification.category,
    summary: classification.summary,
    reasoning: classification.reasoning,
    attachments: attachments.length > 0 ? attachments : null,
    target: classification.target || 'poke_product',
    evidence: classification.evidence || null,
    agentMeta: classification.agentMeta || null,
    lastEvaluatedAt: new Date().toISOString(),
  };

  if (classification.raw) issueData.rawAiResponse = classification.raw;

  let issueId;
  try {
    issueId = await firestore.saveIssue(issueData);
  } catch (err) {
    console.error('Firestore write failed:', err.message);
    issueId = 'unknown';
  }

  const triageMessageId = await triage.postIssueEmbed(message.guild, { ...issueData, messageId: message.id }, issueId);

  if (issueId !== 'unknown' && triageMessageId) {
    await firestore.updateIssueTriageMessageId(issueId, triageMessageId).catch(() => {});
  }

  // Record capability gap if the agent surfaced one
  if (classification.capability_gap && issueId !== 'unknown') {
    try {
      await capabilityGap.record({
        gap: classification.capability_gap,
        issueId,
        guild: message.guild,
        firestore,
        ownerId: getOwnerId(),
        channelName: getConfig('pokedex_self_channel') || 'pokedex-testing',
      });
    } catch (err) {
      console.error('capability gap record failed:', err.message);
    }
  }
}

module.exports = { processIssue, processIssueForced };
