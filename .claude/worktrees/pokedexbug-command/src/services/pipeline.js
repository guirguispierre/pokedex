const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { classifyIssue } = require('./openrouter');
const firestore = require('./firestore');
const triage = require('./triage');
const { getConfig } = require('../config/config');
const { findDuplicate, findDuplicateAI } = require('./duplicates');

const PRIORITY_COLORS = {
  critical: 0xff0000,
  high: 0xff8c00,
  medium: 0xffd700,
  low: 0x00cc00,
  unclassified: 0x808080,
};

async function processIssue(message, text) {
  // Exact message duplicate check
  const isDupe = await firestore.isDuplicate(message.id);
  if (isDupe) return;

  // Classify with AI
  const classification = await classifyIssue(text);

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

  const classification = await classifyIssue(text);

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
}

module.exports = { processIssue, processIssueForced };
