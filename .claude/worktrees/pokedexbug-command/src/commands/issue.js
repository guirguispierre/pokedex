const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const firestore = require('../services/firestore');
const { buildIssueEmbed, postIssueEmbed } = require('../services/triage');
const { classifyIssue } = require('../services/openrouter');
const { getConfig } = require('../config/config');

const PRIORITY_COLORS = {
  critical: 0xff0000,
  high: 0xff8c00,
  medium: 0xffd700,
  low: 0x00cc00,
  unclassified: 0x808080,
};

const STATUS_CHOICES = [
  { name: 'Open', value: 'open' },
  { name: 'Closed', value: 'closed' },
  { name: 'All', value: 'all' },
];

const commandData = new SlashCommandBuilder()
  .setName('issue')
  .setDescription('Manage triaged issues')
  .addSubcommand(sub =>
    sub.setName('close')
      .setDescription('Close/resolve an issue')
      .addStringOption(opt => opt.setName('id').setDescription('Issue ID').setRequired(true).setAutocomplete(true))
      .addStringOption(opt => opt.setName('reason').setDescription('Closure reason').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('reopen')
      .setDescription('Reopen a closed issue')
      .addStringOption(opt => opt.setName('id').setDescription('Issue ID').setRequired(true).setAutocomplete(true)))
  .addSubcommand(sub =>
    sub.setName('view')
      .setDescription('View details of an issue')
      .addStringOption(opt => opt.setName('id').setDescription('Issue ID').setRequired(true).setAutocomplete(true)))
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('List open issues')
      .addStringOption(opt =>
        opt.setName('filter').setDescription('Filter by priority')
          .setRequired(false)
          .addChoices(
            { name: 'Critical', value: 'critical' },
            { name: 'High', value: 'high' },
            { name: 'Medium', value: 'medium' },
            { name: 'Low', value: 'low' },
          ))
      .addIntegerOption(opt => opt.setName('limit').setDescription('Max issues to show (default: 10)').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Show issue counts and stats'))
  .addSubcommand(sub =>
    sub.setName('mine')
      .setDescription('Show your recent issues')
      .addStringOption(opt =>
        opt.setName('status')
          .setDescription('Which issues to include')
          .setRequired(false)
          .addChoices(...STATUS_CHOICES))
      .addIntegerOption(opt => opt.setName('limit').setDescription('Max issues to show (default: 5)').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('search')
      .setDescription('Search saved issues by keyword')
      .addStringOption(opt => opt.setName('query').setDescription('Keyword or phrase').setRequired(true))
      .addStringOption(opt =>
        opt.setName('status')
          .setDescription('Which issues to include')
          .setRequired(false)
          .addChoices(...STATUS_CHOICES))
      .addIntegerOption(opt => opt.setName('limit').setDescription('Max issues to show (default: 8)').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('assign')
      .setDescription('Assign an issue to a team member')
      .addStringOption(opt => opt.setName('id').setDescription('Issue ID').setRequired(true).setAutocomplete(true))
      .addUserOption(opt => opt.setName('user').setDescription('Who should own it (default: you)').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('note')
      .setDescription('Add an internal note to an issue')
      .addStringOption(opt => opt.setName('id').setDescription('Issue ID').setRequired(true).setAutocomplete(true))
      .addStringOption(opt => opt.setName('note').setDescription('Internal note').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('context')
      .setDescription('Add follow-up context to an open issue without creating a new one')
      .addStringOption(opt => opt.setName('id').setDescription('Issue ID').setRequired(true).setAutocomplete(true))
      .addStringOption(opt => opt.setName('text').setDescription('Additional context, details, or reproduction steps').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('revive')
      .setDescription('Reopen a deleted issue and start a thread so the reporter can add context')
      .addStringOption(opt => opt.setName('id').setDescription('Issue ID').setRequired(true).setAutocomplete(true))
      .addUserOption(opt => opt.setName('user').setDescription('The reporter to ping (default: original reporter)').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('recover')
      .setDescription('Scrape a thread to recreate a hard-deleted issue and continue the conversation')
      .addChannelOption(opt =>
        opt.setName('thread')
          .setDescription('The thread to scrape (or run this inside the thread)')
          .addChannelTypes(ChannelType.PublicThread, ChannelType.PrivateThread)
          .setRequired(false)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (['close', 'reopen', 'assign', 'note', 'revive', 'recover'].includes(sub)) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: 'You need **Manage Messages** permission to do that.', ephemeral: true });
    }
  }

  switch (sub) {
    case 'close': return handleClose(interaction);
    case 'reopen': return handleReopen(interaction);
    case 'view': return handleView(interaction);
    case 'list': return handleList(interaction);
    case 'status': return handleStatus(interaction);
    case 'mine': return handleMine(interaction);
    case 'search': return handleSearch(interaction);
    case 'assign': return handleAssign(interaction);
    case 'note': return handleNote(interaction);
    case 'context': return handleContext(interaction);
    case 'revive': return handleRevive(interaction);
    case 'recover': return handleRecover(interaction);
    default:
      return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
  }
}

async function handleClose(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const issueId = interaction.options.getString('id');
  const reason = interaction.options.getString('reason') || 'Resolved';

  const issue = await firestore.getIssueById(issueId);
  if (!issue) return interaction.editReply(`Issue \`${issueId}\` not found.`);
  if (issue.status === 'closed') return interaction.editReply(`Issue \`${issueId}\` is already closed.`);

  await firestore.updateIssueStatus(issueId, 'closed', interaction.user.id);
  const updatedIssue = await firestore.getIssueById(issueId);

  await updateTriageEmbed(interaction.guild, updatedIssue, issueId, 'closed', reason, interaction.user.username);

  if (updatedIssue.threadId) {
    try {
      const thread = await interaction.guild.channels.fetch(updatedIssue.threadId);
      if (thread?.isThread()) {
        const closeEmbed = new EmbedBuilder()
          .setColor(0x808080)
          .setTitle('Issue Closed')
          .setDescription(`Closed by **${interaction.user.username}**`)
          .addFields({ name: 'Reason', value: reason })
          .setTimestamp();
        await thread.send({ embeds: [closeEmbed] });
        await thread.setArchived(true);
      }
    } catch {
      // Thread may already be archived or deleted
    }
  }

  await interaction.editReply(`Closed issue \`${issueId}\` — ${reason}`);
}

async function handleReopen(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const issueId = interaction.options.getString('id');

  const issue = await firestore.getIssueById(issueId);
  if (!issue) return interaction.editReply(`Issue \`${issueId}\` not found.`);
  if (issue.status === 'open') return interaction.editReply(`Issue \`${issueId}\` is already open.`);
  if (issue.status === 'deleted') {
    // Clear deletion metadata when reopening a soft-deleted issue
    const admin = require('firebase-admin');
    const db = admin.firestore();
    await db.collection('issues').doc(issueId).update({
      deletedAt: admin.firestore.FieldValue.delete(),
      deletedBy: admin.firestore.FieldValue.delete(),
    });
  }

  await firestore.updateIssueStatus(issueId, 'open', null);
  const updatedIssue = await firestore.getIssueById(issueId);

  await updateTriageEmbed(interaction.guild, updatedIssue, issueId, 'reopened', null, interaction.user.username);

  if (updatedIssue.threadId) {
    try {
      const thread = await interaction.guild.channels.fetch(updatedIssue.threadId);
      if (thread?.isThread()) {
        await thread.setArchived(false);
        const reopenEmbed = new EmbedBuilder()
          .setColor(0xff8c00)
          .setTitle('Issue Reopened')
          .setDescription(`Reopened by **${interaction.user.username}**`)
          .setTimestamp();
        await thread.send({ embeds: [reopenEmbed] });
      }
    } catch {
      // Thread may not exist
    }
  }

  await interaction.editReply(`Reopened issue \`${issueId}\``);
}

async function handleRevive(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const issueId = interaction.options.getString('id');
  const targetUser = interaction.options.getUser('user');

  const issue = await firestore.getIssueById(issueId);
  if (!issue) return interaction.editReply(`Issue \`${issueId}\` not found.`);

  // Reopen the issue if it's not already open
  if (issue.status !== 'open') {
    // Clear deletion metadata if it was soft-deleted
    if (issue.status === 'deleted') {
      const admin = require('firebase-admin');
      const db = admin.firestore();
      await db.collection('issues').doc(issueId).update({
        deletedAt: admin.firestore.FieldValue.delete(),
        deletedBy: admin.firestore.FieldValue.delete(),
      });
    }
    await firestore.updateIssueStatus(issueId, 'open', null);
  }

  const updatedIssue = await firestore.getIssueById(issueId);

  // Re-post the triage embed since the old one was likely deleted
  await postIssueEmbed(interaction.guild, updatedIssue, issueId);
  // Refetch to get the new triageMessageId
  const issueFinal = await firestore.getIssueById(issueId);

  // Determine who to ping — explicit user or original reporter
  const reporterMention = targetUser
    ? `<@${targetUser.id}>`
    : (issue.reporterId ? `<@${issue.reporterId}>` : issue.reporterName || 'the reporter');

  // Create a thread in the current channel for the conversation
  const threadName = `${(issue.category || 'issue').replace(/_/g, ' ')}: ${(issue.summary || issueId).slice(0, 80)}`;
  const thread = await interaction.channel.threads.create({
    name: threadName,
    autoArchiveDuration: 1440,
    reason: `Revived issue ${issueId} for additional context`,
  });

  // Link the thread to the issue so thread.js auto-handles future messages
  await firestore.updateIssueThreadId(issueId, thread.id);

  // Send the intro embed so Pokedex starts the conversation
  const color = PRIORITY_COLORS[issue.priority] ?? 0x808080;
  const introEmbed = new EmbedBuilder()
    .setColor(color)
    .setTitle('Issue Revived — Need More Context')
    .setDescription(
      `This issue was previously deleted but has been reopened so we can gather more information.\n\n` +
      `**Summary:** ${issue.summary || 'N/A'}\n` +
      `**Priority:** ${issue.priority || 'unclassified'}\n` +
      `**Category:** ${(issue.category || 'other').replace(/_/g, ' ')}`
    )
    .addFields(
      { name: 'Original Report', value: (issue.text || 'No description').slice(0, 1024) },
      { name: 'What to do', value: 'Please share any additional details, steps to reproduce, screenshots, or context that can help us investigate. Just type in this thread and I\'ll track everything automatically.' },
    )
    .setFooter({ text: `Issue ID: ${issueId}` })
    .setTimestamp();

  await thread.send({ content: `${reporterMention}`, embeds: [introEmbed] });

  await interaction.editReply(`Revived issue \`${issueId}\` — thread created: ${thread.toString()}`);
}

async function handleRecover(interaction) {
  await interaction.deferReply({ ephemeral: true });

  // Resolve the thread — either from the option or the current channel
  const threadOption = interaction.options.getChannel('thread');
  const thread = threadOption || (interaction.channel.isThread() ? interaction.channel : null);
  if (!thread || !thread.isThread()) {
    return interaction.editReply('Run this inside a thread, or pass a thread with the `thread` option.');
  }

  // Check if this thread is already linked to a live issue
  const existing = await firestore.getIssueByThreadId(thread.id);
  if (existing) {
    return interaction.editReply(`This thread is already linked to issue \`${existing.id}\` (status: ${existing.status}). Use \`/issue reopen\` instead.`);
  }

  // Scrape all messages from the thread (capped to prevent resource exhaustion)
  let allMessages = [];
  let lastId;
  const MAX_RECOVER_MESSAGES = 500;
  while (allMessages.length < MAX_RECOVER_MESSAGES) {
    const batch = await thread.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
    if (batch.size === 0) break;
    allMessages.push(...batch.values());
    if (batch.size < 100) break;
    lastId = batch.last().id;
  }

  // Sort oldest first
  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  if (allMessages.length === 0) {
    return interaction.editReply('The thread has no messages to recover.');
  }

  // Identify the reporter — first non-bot message author
  const firstHumanMsg = allMessages.find(m => !m.author.bot);
  const reporter = firstHumanMsg?.author;

  // Build the full conversation text for AI classification
  const humanMessages = allMessages.filter(m => !m.author.bot && m.content?.trim());
  const conversationText = humanMessages.map(m => m.content.trim()).join('\n');

  if (!conversationText) {
    return interaction.editReply('No user messages found in the thread to build an issue from.');
  }

  // Classify the scraped conversation
  const classification = await classifyIssue(conversationText);

  // Collect any attachments from the conversation
  const attachments = [];
  for (const msg of humanMessages) {
    for (const att of msg.attachments.values()) {
      attachments.push({ url: att.url, name: att.name, contentType: att.contentType });
    }
  }

  // Save the new issue
  const issueData = {
    text: conversationText,
    reporterId: reporter?.id || 'unknown',
    reporterName: reporter?.username || 'unknown',
    guildId: interaction.guild.id,
    channelId: thread.parentId,
    messageId: firstHumanMsg?.id || null,
    threadId: thread.id,
    priority: classification.priority,
    category: classification.category,
    summary: classification.summary,
    reasoning: classification.reasoning,
    attachments,
    source: 'recovered',
  };

  // Build threadContext from all human messages (except the first which becomes the main text)
  const contextEntries = humanMessages.slice(1).map(m => ({
    text: `${m.author.id === reporter?.id ? '' : `[${m.author.username}]: `}${m.content.trim()}`,
    addedAt: m.createdAt.toISOString(),
  }));
  if (contextEntries.length > 0) {
    issueData.threadContext = contextEntries;
  }

  const issueId = await firestore.saveIssue(issueData);

  // Post triage embed
  const savedIssue = await firestore.getIssueById(issueId);
  await postIssueEmbed(interaction.guild, savedIssue, issueId);

  // Unarchive the thread if it was archived
  if (thread.archived) {
    try { await thread.setArchived(false); } catch { /* may lack perms */ }
  }

  // Send a continuation message in the thread so Pokedex keeps the conversation going
  const color = PRIORITY_COLORS[classification.priority] ?? 0x808080;
  const recoverEmbed = new EmbedBuilder()
    .setColor(color)
    .setTitle('Issue Recovered')
    .setDescription(
      `I've recreated this issue from the conversation in this thread.\n\n` +
      `**Summary:** ${classification.summary}\n` +
      `**Priority:** ${classification.priority}\n` +
      `**Category:** ${(classification.category || 'other').replace(/_/g, ' ')}`
    )
    .addFields({
      name: 'What happens next',
      value: 'This thread is now linked to the new issue. Any messages you send here will automatically update the issue and I\'ll keep tracking everything.',
    })
    .setFooter({ text: `New Issue ID: ${issueId}` })
    .setTimestamp();

  const mention = reporter ? `<@${reporter.id}>` : '';
  await thread.send({ content: mention, embeds: [recoverEmbed] });

  // Ask the follow-up question if the AI generated one
  if (classification.follow_up) {
    await thread.send(classification.follow_up);
  }

  await interaction.editReply(`Recovered issue \`${issueId}\` from thread ${thread.toString()} — Pokedex is now tracking it.`);
}

async function handleView(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const issueId = interaction.options.getString('id');

  const issue = await firestore.getIssueById(issueId);
  if (!issue) return interaction.editReply(`Issue \`${issueId}\` not found.`);

  const color = PRIORITY_COLORS[issue.priority] ?? 0x808080;
  const hasMessageLink = issue.guildId && issue.channelId && issue.messageId
    && issue.channelId !== 'mcp'
    && !String(issue.messageId).startsWith('mcp-');
  const messageLink = hasMessageLink
    ? `https://discord.com/channels/${issue.guildId}/${issue.channelId}/${issue.messageId}`
    : null;

  const embed = new EmbedBuilder()
    .setTitle(issue.summary || 'Untitled Issue')
    .setColor(color)
    .addFields(
      { name: 'Status', value: (issue.status || 'open').toUpperCase(), inline: true },
      { name: 'Priority', value: issue.priority || 'unclassified', inline: true },
      { name: 'Category', value: issue.category?.replace(/_/g, ' ') || 'other', inline: true },
      { name: 'Reporter', value: issue.reporterName || 'unknown', inline: true },
    );

  if (issue.assigneeName) {
    embed.addFields({ name: 'Assigned To', value: issue.assigneeName, inline: true });
  }

  if (messageLink) {
    embed.addFields({ name: 'Original Message', value: `[Jump](${messageLink})` });
  } else if (issue.source === 'mcp') {
    embed.addFields({ name: 'Source', value: 'MCP Agent', inline: true });
  }

  if (issue.reasoning) {
    embed.addFields({ name: 'AI Reasoning', value: issue.reasoning });
  }

  if (issue.text) {
    embed.addFields({ name: 'Report', value: issue.text.slice(0, 1024) });
  }

  const threadContext = issue.threadContext || [];
  if (threadContext.length > 0) {
    const ctx = threadContext.map((c, i) => `${i + 1}. ${c.text.slice(0, 100)}`).join('\n');
    embed.addFields({ name: 'Thread Context', value: ctx.slice(0, 1024) });
  }

  const notes = Array.isArray(issue.notes) ? issue.notes : [];
  if (notes.length > 0) {
    const noteLines = notes
      .slice(-3)
      .map(note => `• **${note.authorName || 'unknown'}** ${formatRelativeTime(note.createdAt)}\n${note.text}`)
      .join('\n')
      .slice(0, 1024);
    embed.addFields({ name: `Internal Notes (${notes.length})`, value: noteLines });
  }

  if (issue.closedBy) {
    embed.addFields({ name: 'Closed By', value: `<@${issue.closedBy}>`, inline: true });
  }

  embed.setFooter({ text: `Issue ID: ${issueId}` }).setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const filter = interaction.options.getString('filter');
  const limit = Math.min(interaction.options.getInteger('limit') || 10, 25);

  let issues = await firestore.getOpenIssues(limit);

  if (filter) {
    issues = issues.filter(i => i.priority === filter);
  }

  if (issues.length === 0) {
    return interaction.editReply(filter ? `No open **${filter}** issues.` : 'No open issues!');
  }

  const embed = new EmbedBuilder()
    .setTitle(`Open Issues${filter ? ` — ${filter.toUpperCase()}` : ''}`)
    .setColor(0x5865f2)
    .setDescription(`Showing ${issues.length} open issue${issues.length !== 1 ? 's' : ''}`);

  for (const issue of issues.slice(0, limit)) {
    embed.addFields({
      name: `${priorityEmoji(issue.priority)} ${issue.summary?.slice(0, 80) || 'Untitled'}`,
      value: buildIssueListValue(issue),
    });
  }

  embed.setFooter({ text: 'Use /issue view <id> for details • /issue close <id> to resolve' });
  await interaction.editReply({ embeds: [embed] });
}

async function handleStatus(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const counts = await firestore.getIssueCounts();

  const priorityLines = Object.entries(counts.byPriority)
    .sort(([a], [b]) => {
      const order = ['critical', 'high', 'medium', 'low', 'unclassified'];
      return order.indexOf(a) - order.indexOf(b);
    })
    .map(([priority, count]) => `${priorityEmoji(priority)} ${priority}: **${count}**`);

  const embed = new EmbedBuilder()
    .setTitle('Issue Dashboard')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Open', value: `**${counts.open}**`, inline: true },
      { name: 'Closed', value: `**${counts.closed}**`, inline: true },
      { name: 'Total', value: `**${counts.total}**`, inline: true },
    );

  if (priorityLines.length > 0) {
    embed.addFields({ name: 'Open by Priority', value: priorityLines.join('\n') });
  }

  embed.setFooter({ text: 'Use /issue list to see details' }).setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function handleMine(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const status = interaction.options.getString('status') || 'all';
  const limit = Math.min(interaction.options.getInteger('limit') || 5, 10);

  const issues = await firestore.getRecentIssuesByReporter(interaction.user.id, { status, limit });
  if (issues.length === 0) {
    return interaction.editReply(`No ${status === 'all' ? '' : `${status} `}issues found for you yet.`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`Your Issues${status !== 'all' ? ` — ${status.toUpperCase()}` : ''}`)
    .setColor(0x5865f2)
    .setDescription(`Showing ${issues.length} recent report${issues.length === 1 ? '' : 's'}`);

  for (const issue of issues) {
    embed.addFields({
      name: `${priorityEmoji(issue.priority)} ${issue.summary?.slice(0, 80) || 'Untitled'}`,
      value: buildIssueListValue(issue),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleSearch(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const query = interaction.options.getString('query');
  const status = interaction.options.getString('status') || 'all';
  const limit = Math.min(interaction.options.getInteger('limit') || 8, 10);

  const issues = await firestore.searchIssues(query, { status, limit });
  if (issues.length === 0) {
    return interaction.editReply(`No issues matched \`${query}\`.`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`Search Results for "${query}"`)
    .setColor(0x5865f2)
    .setDescription(`Found ${issues.length} matching issue${issues.length === 1 ? '' : 's'}`);

  for (const issue of issues) {
    embed.addFields({
      name: `${priorityEmoji(issue.priority)} ${issue.summary?.slice(0, 80) || 'Untitled'}`,
      value: buildIssueListValue(issue),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleAssign(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const issueId = interaction.options.getString('id');
  const assignee = interaction.options.getUser('user') || interaction.user;

  const issue = await firestore.getIssueById(issueId);
  if (!issue) return interaction.editReply(`Issue \`${issueId}\` not found.`);

  await firestore.assignIssue(issueId, {
    assigneeId: assignee.id,
    assigneeName: assignee.username,
    assignedBy: interaction.user.id,
  });

  const updatedIssue = await firestore.getIssueById(issueId);
  await updateTriageEmbed(interaction.guild, updatedIssue, issueId, 'assigned', assignee.username, interaction.user.username);

  await interaction.editReply(`Assigned issue \`${issueId}\` to **${assignee.username}**.`);
}

async function handleNote(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const issueId = interaction.options.getString('id');
  const noteText = interaction.options.getString('note').trim();

  const issue = await firestore.getIssueById(issueId);
  if (!issue) return interaction.editReply(`Issue \`${issueId}\` not found.`);

  await firestore.addIssueNote(issueId, {
    text: noteText,
    authorId: interaction.user.id,
    authorName: interaction.user.username,
  });

  const updatedIssue = await firestore.getIssueById(issueId);
  await updateTriageEmbed(interaction.guild, updatedIssue, issueId, 'noted', noteText, interaction.user.username);

  await interaction.editReply(`Added note to issue \`${issueId}\`.`);
}

async function handleContext(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const issueId = interaction.options.getString('id');
  const text = interaction.options.getString('text').trim();

  const issue = await firestore.getIssueById(issueId);
  if (!issue) return interaction.editReply(`Issue \`${issueId}\` not found.`);

  if (issue.status === 'closed' || issue.status === 'fixed' || issue.status === 'wontfix') {
    return interaction.editReply(`Issue \`${issueId}\` is closed. Reopen it first with \`/issue reopen ${issueId}\`.`);
  }

  const contextEntry = `${interaction.user.username}: ${text}`;
  await firestore.appendThreadContext(issueId, contextEntry);

  const updatedIssue = await firestore.getIssueById(issueId);
  await updateTriageEmbed(interaction.guild, updatedIssue, issueId, 'context', text, interaction.user.username);

  // If the issue has a thread, post the context there too
  if (updatedIssue.threadId) {
    try {
      const thread = await interaction.guild.channels.fetch(updatedIssue.threadId);
      if (thread?.isThread()) {
        const contextEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('Additional Context Added')
          .setDescription(text.slice(0, 4096))
          .setFooter({ text: `Added by ${interaction.user.username} via /issue context` })
          .setTimestamp();
        await thread.send({ embeds: [contextEmbed] });
      }
    } catch {
      // Thread may not exist
    }
  }

  const contextCount = (updatedIssue.threadContext || []).length;
  await interaction.editReply(`Added context to issue \`${issueId}\` (${contextCount} context entries total).`);
}

function buildIssueListValue(issue) {
  const status = (issue.status || 'open').toUpperCase();
  const category = issue.category?.replace(/_/g, ' ') || 'other';
  const assignee = issue.assigneeName ? ` • assigned: ${issue.assigneeName}` : '';
  const hasMessageLink = issue.guildId && issue.channelId && issue.messageId
    && issue.channelId !== 'mcp'
    && !String(issue.messageId).startsWith('mcp-');
  const link = hasMessageLink
    ? ` • [jump](https://discord.com/channels/${issue.guildId}/${issue.channelId}/${issue.messageId})`
    : '';

  return `\`${issue.id}\` • ${status} • ${category}${assignee}${link}`;
}

function priorityEmoji(priority) {
  if (priority === 'critical') return '🔴';
  if (priority === 'high') return '🟠';
  if (priority === 'medium') return '🟡';
  if (priority === 'low') return '🟢';
  return '⚪';
}

function formatRelativeTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

async function updateTriageEmbed(guild, issue, issueId, action, detail, username) {
  const triageChannelName = getConfig('triage_channel') || 'eng-triage';
  if (!issue?.triageMessageId) return;

  const triageChannel = guild.channels.cache.find(
    channel => channel.name === triageChannelName && channel.isTextBased()
  );
  if (!triageChannel) return;

  try {
    const triageMsg = await triageChannel.messages.fetch(issue.triageMessageId);
    const embed = buildIssueEmbed(issue, issueId);

    if (action === 'closed') {
      embed.setColor(0x808080);
      embed.addFields({ name: '✅ Closed', value: `By **${username}** — ${detail}` });
    } else if (action === 'reopened') {
      embed.addFields({ name: '🔄 Reopened', value: `By **${username}**` });
    } else if (action === 'assigned') {
      embed.addFields({ name: '👤 Assigned', value: `Set to **${detail}** by **${username}**` });
    } else if (action === 'noted') {
      embed.addFields({ name: '📝 Latest Note', value: `**${username}**: ${detail.slice(0, 240)}` });
    } else if (action === 'context') {
      embed.addFields({ name: '💬 Context Added', value: `**${username}**: ${detail.slice(0, 240)}` });
    }

    embed.setTimestamp();
    await triageMsg.edit({ embeds: [embed] });
  } catch {
    // Triage message may have been deleted
  }
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  try {
    const issues = await firestore.getAllIssues(50);
    const filtered = issues
      .filter(i => {
        const id = i.id.toLowerCase();
        const summary = (i.summary || '').toLowerCase();
        return id.includes(focused) || summary.includes(focused);
      })
      .slice(0, 25)
      .map(i => ({
        name: `${i.id.slice(0, 8)}… | ${(i.status || 'open').toUpperCase()} | ${(i.summary || 'Untitled').slice(0, 60)}`,
        value: i.id,
      }));
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
}

module.exports = { data: commandData, execute, autocomplete };
