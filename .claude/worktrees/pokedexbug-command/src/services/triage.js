const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');
const { getConfig } = require('../config/config');
const firestore = require('./firestore');

const PRIORITY_COLORS = {
  critical: 0xff0000,
  high: 0xff8c00,
  medium: 0xffd700,
  low: 0x00cc00,
  unclassified: 0x808080,
};

function buildTriageButtons(issueId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`triage_ack_${issueId}`)
      .setLabel('Acknowledged')
      .setEmoji('👀')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`triage_fix_${issueId}`)
      .setLabel('Fixed')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`triage_wontfix_${issueId}`)
      .setLabel("Won't Fix")
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`triage_escalate_${issueId}`)
      .setLabel('Escalate')
      .setEmoji('🔺')
      .setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`triage_delete_${issueId}`)
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`triage_gather_${issueId}`)
      .setLabel('Gather Context')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

function buildIssueEmbed(issue, issueId) {
  const color = PRIORITY_COLORS[issue.priority] ?? 0x808080;
  const hasOriginalMessageLink = issue.guildId
    && issue.channelId
    && issue.messageId
    && issue.channelId !== 'mcp'
    && !String(issue.messageId).startsWith('mcp-');
  const messageLink = hasOriginalMessageLink
    ? `https://discord.com/channels/${issue.guildId}/${issue.channelId}/${issue.messageId}`
    : null;

  const embed = new EmbedBuilder()
    .setTitle(issue.summary)
    .setColor(color)
    .addFields(
      { name: 'Priority', value: issue.priority, inline: true },
      { name: 'Category', value: issue.category?.replace(/_/g, ' ') || 'other', inline: true },
      { name: 'Reporter', value: issue.reporterName, inline: true },
      { name: 'Reasoning', value: issue.reasoning },
    )
    .setFooter({ text: `Issue ID: ${issueId}` })
    .setTimestamp();

  if (issue.assigneeName) {
    embed.addFields({ name: 'Assigned To', value: issue.assigneeName, inline: true });
  }

  if (messageLink) {
    embed.addFields({ name: 'Original Message', value: `[Jump to message](${messageLink})` });
  } else if (issue.source === 'mcp') {
    embed.addFields({ name: 'Source', value: 'MCP Agent' });
  }

  // Attach first image as embed image
  if (issue.attachments?.length > 0) {
    const firstImage = issue.attachments.find(a => a.isImage);
    if (firstImage) {
      embed.setImage(firstImage.url);
    }

    // List all attachments
    const attLinks = issue.attachments.map(a => {
      const icon = a.isImage ? '🖼️' : '📎';
      const size = a.size ? ` (${Math.round(a.size / 1024)}KB)` : '';
      return `${icon} [${a.name}](${a.url})${size}`;
    });
    embed.addFields({ name: 'Attachments', value: attLinks.join('\n') });
  }

  if (issue.contextComplete === true) {
    embed.addFields({ name: '✅ Context Complete', value: 'Enough info for a developer to investigate' });
  } else if (issue.source === 'forum' && issue.contextComplete !== true) {
    embed.addFields({ name: '⏳ Gathering Context', value: 'Pokedex is talking to the reporter' });
  }

  return embed;
}

function findTriageChannel(guild) {
  const channelName = getConfig('triage_channel');
  return guild.channels.cache.find(ch => ch.name === channelName && ch.isTextBased());
}

async function postIssueEmbed(guild, issue, issueId) {
  const outputMode = getConfig('output_mode');
  if (outputMode === 'summary') return null;

  const channel = findTriageChannel(guild);
  if (!channel) {
    console.error(`Triage channel "${getConfig('triage_channel')}" not found`);
    return null;
  }

  const embed = buildIssueEmbed(issue, issueId);
  const buttons = buildTriageButtons(issueId);
  const msg = await channel.send({ embeds: [embed], components: buttons });

  // Store channel ID alongside message ID so MCP servers can post updates via REST API
  await firestore.updateIssueTriageChannelId(issueId, channel.id);

  return msg.id;
}

function buildDigestEmbed(issues) {
  const grouped = {};
  for (const issue of issues) {
    const key = issue.priority;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(issue);
  }

  const embed = new EmbedBuilder()
    .setTitle('Issue Digest')
    .setColor(0x5865f2)
    .setTimestamp();

  const priorityOrder = ['critical', 'high', 'medium', 'low', 'unclassified'];
  for (const priority of priorityOrder) {
    const items = grouped[priority];
    if (!items || items.length === 0) continue;

    const lines = items.map(i => {
      const link = `https://discord.com/channels/${i.guildId}/${i.channelId}/${i.messageId}`;
      return `• [${i.category}] ${i.summary} ([link](${link}))`;
    });
    embed.addFields({ name: `${priority.toUpperCase()} (${items.length})`, value: lines.join('\n').slice(0, 1024) });
  }

  if (issues.length === 0) {
    embed.setDescription('No new issues since last digest.');
  }

  return embed;
}

async function postDigest(guild) {
  const channel = findTriageChannel(guild);
  if (!channel) return;

  const interval = getConfig('summary_interval');
  const since = new Date();
  if (interval === 'weekly') {
    since.setDate(since.getDate() - 7);
  } else {
    since.setDate(since.getDate() - 1);
  }

  const issues = await firestore.getIssuesSince(since);
  const embed = buildDigestEmbed(issues);
  await channel.send({ embeds: [embed] });
}

function startDigestScheduler(guild) {
  const outputMode = getConfig('output_mode');
  if (outputMode !== 'summary' && outputMode !== 'both') return null;

  const interval = getConfig('summary_interval');
  const cronExpr = interval === 'weekly' ? '0 9 * * 1' : '0 9 * * *';

  return cron.schedule(cronExpr, () => {
    postDigest(guild).catch(err => console.error('Digest failed:', err));
  }, { timezone: 'UTC' });
}

module.exports = { postIssueEmbed, startDigestScheduler, findTriageChannel, buildIssueEmbed, buildTriageButtons };
