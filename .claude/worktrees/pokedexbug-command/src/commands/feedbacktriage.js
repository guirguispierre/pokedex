const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');
const firestore = require('../services/firestore');
const { classifyIssue } = require('../services/openrouter');
const { findDuplicate, findDuplicateAI, findDuplicateClustersAI } = require('../services/duplicates');
const { postIssueEmbed, buildIssueEmbed } = require('../services/triage');
const { getConfig } = require('../config/config');

const PRIORITY_COLORS = {
  critical: 0xff0000,
  high: 0xff8c00,
  medium: 0xffd700,
  low: 0x00cc00,
  unclassified: 0x808080,
};

const commandData = new SlashCommandBuilder()
  .setName('feedback-triage')
  .setDescription('Triage a feedback forum post into an issue — finds duplicates, tracks reporters, and adds context')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(sub =>
    sub.setName('run')
      .setDescription('Triage this forum post — AI classifies, detects duplicates, creates or merges issues'))
  .addSubcommand(sub =>
    sub.setName('merge')
      .setDescription('Manually merge this forum post into an existing issue (when AI misses the duplicate)')
      .addStringOption(opt =>
        opt.setName('target')
          .setDescription('Issue ID to merge this post into')
          .setRequired(true)
          .setAutocomplete(true)))
  .addSubcommand(sub =>
    sub.setName('scrape')
      .setDescription('Bulk-scrape all feedback forum posts — triage, deduplicate, and create issues automatically')
      .addChannelOption(opt =>
        opt.setName('forum')
          .setDescription('The feedback forum channel (defaults to #feedback)')
          .addChannelTypes(ChannelType.GuildForum)
          .setRequired(false))
      .addBooleanOption(opt =>
        opt.setName('include-archived')
          .setDescription('Also process archived/closed posts (default: false)')
          .setRequired(false))
      .addIntegerOption(opt =>
        opt.setName('limit')
          .setDescription('Max posts to process (default: 50, max: 200)')
          .setMinValue(1)
          .setMaxValue(200)
          .setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('reorganize')
      .setDescription('AI-scan all open issues for duplicates and merge them automatically'));

async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'merge') {
    return executeMerge(interaction);
  }

  if (subcommand === 'scrape') {
    return executeScrape(interaction);
  }

  if (subcommand === 'reorganize') {
    return executeReorganize(interaction);
  }

  return executeTriage(interaction);
}

async function executeTriage(interaction) {
  const channel = interaction.channel;

  // Must be used inside a forum thread
  if (!channel.isThread() || !channel.parent || channel.parent.type !== ChannelType.GuildForum) {
    return interaction.reply({
      content: 'This command must be used inside a **forum post** (e.g. #feedback).',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  // 1. Scrape all messages from the forum thread
  const { messages, starterMessage, reporters } = await scrapeThread(channel);

  if (!starterMessage) {
    return interaction.editReply('Could not fetch the starter message for this forum post.');
  }

  const threadTitle = channel.name;
  const fullText = buildFullText(threadTitle, starterMessage, messages);

  // Resolve forum tags
  const availableTags = channel.parent.availableTags || [];
  const forumTags = (channel.appliedTags || []).map(tagId => {
    const tag = availableTags.find(t => t.id === tagId);
    return tag?.name || 'unknown';
  });

  // 2. Check if this thread already has a linked issue
  const existingLinked = await firestore.getIssueByThreadId(channel.id);
  if (existingLinked) {
    // Already linked — update context and reporter count
    return handleExistingLinked(interaction, existingLinked, messages, reporters, fullText);
  }

  // 3. AI classify the feedback
  const classification = await classifyIssue(fullText);

  // 4. Check for similar existing issues (Jaccard fast → AI accurate)
  let duplicateMatch = null;
  try {
    const openIssues = await firestore.getOpenIssues(100);
    duplicateMatch = findDuplicate(classification.summary, fullText, openIssues);
    if (!duplicateMatch) {
      duplicateMatch = await findDuplicateAI(classification.summary, classification.category, openIssues);
    }
  } catch (err) {
    console.error('Duplicate detection failed during feedback-triage:', err.message);
  }

  if (duplicateMatch) {
    return handleDuplicate(interaction, channel, classification, duplicateMatch, reporters, messages, forumTags);
  }

  // 5. No duplicate — create new issue
  return handleNewIssue(interaction, channel, starterMessage, classification, reporters, messages, forumTags, fullText);
}

/**
 * Manual merge — merge this forum post into an existing issue when AI didn't catch the duplicate.
 */
async function executeMerge(interaction) {
  const channel = interaction.channel;

  // Must be used inside a forum thread
  if (!channel.isThread() || !channel.parent || channel.parent.type !== ChannelType.GuildForum) {
    return interaction.reply({
      content: 'This command must be used inside a **forum post** (e.g. #feedback).',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const targetId = interaction.options.getString('target').trim();
  const db = admin.firestore();

  // Validate target issue exists
  const targetDoc = await db.collection('issues').doc(targetId).get();
  if (!targetDoc.exists) {
    return interaction.editReply(`Issue \`${targetId}\` not found.`);
  }
  const targetData = targetDoc.data();

  if (targetData.status === 'closed' || targetData.status === 'merged') {
    return interaction.editReply(`Issue \`${targetId}\` is **${targetData.status}** — pick an open issue to merge into.`);
  }

  // Scrape this forum thread
  const { messages, starterMessage, reporters } = await scrapeThread(channel);
  if (!starterMessage) {
    return interaction.editReply('Could not fetch the starter message for this forum post.');
  }

  const threadTitle = channel.name;
  const fullText = buildFullText(threadTitle, starterMessage, messages);

  // Check if this thread already has a linked issue
  const existingLinked = await firestore.getIssueByThreadId(channel.id);

  // Add all reporters from this thread to the target issue
  let reporterCount = (targetData.reporterIds || []).length;
  for (const r of reporters) {
    const result = await firestore.addReporter(targetId, r.id, r.name);
    if (result) reporterCount = (result.reporterIds || []).length;
  }

  // Append this thread's conversation as context
  const humanMessages = messages.filter(m => !m.author.bot && m.content?.trim());
  const contextSummary = humanMessages.map(m => `${m.author.username}: ${m.content.trim()}`).join('\n');
  const starterContent = starterMessage.content?.trim() || '';

  // Add the full post content as context
  const mergeContextText = `[Manual merge from feedback post "${threadTitle}" — ${reporters.length} reporter${reporters.length !== 1 ? 's' : ''}]: ${starterContent}${contextSummary ? '\n' + contextSummary : ''}`;
  await firestore.appendThreadContext(targetId, mergeContextText.slice(0, 2000));

  // Collect attachments from this thread and merge them
  const attachments = [];
  for (const msg of [starterMessage, ...messages]) {
    for (const att of msg.attachments.values()) {
      attachments.push({
        url: att.url,
        name: att.name,
        contentType: att.contentType,
        size: att.size,
        isImage: att.contentType?.startsWith('image/') || false,
      });
    }
  }

  const updateData = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    mergeHistory: admin.firestore.FieldValue.arrayUnion({
      mergedAt: new Date().toISOString(),
      mergedBy: interaction.user.username,
      mergedByUserId: interaction.user.id,
      sourceThreadId: channel.id,
      sourceThreadName: threadTitle,
      reporterCount: reporters.length,
      reason: 'Manual merge via /feedback-triage merge',
    }),
  };

  // Merge attachments if any
  if (attachments.length > 0) {
    const existingAttachments = targetData.attachments || [];
    updateData.attachments = [...existingAttachments, ...attachments];
  }

  await db.collection('issues').doc(targetId).update(updateData);

  // Link this thread to the target issue for auto-tracking
  await firestore.updateIssueThreadId(targetId, channel.id);

  // If this thread had its own issue, mark it as merged
  if (existingLinked) {
    await db.collection('issues').doc(existingLinked.id).update({
      status: 'merged',
      mergedInto: targetId,
      closedBy: interaction.user.id,
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Refresh the triage embed on the target issue
  const updatedIssue = await firestore.getIssueById(targetId);
  await refreshTriageEmbed(interaction.guild, updatedIssue, targetId, reporterCount);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🔀 Feedback Merged Into Issue')
    .setDescription(
      `This forum post has been merged into issue \`${targetId}\`.\n\n` +
      `Future messages in this thread will automatically update the target issue.`
    )
    .addFields(
      { name: 'Target Issue', value: `\`${targetId}\`\n${(targetData.summary || 'No summary').slice(0, 200)}` },
      { name: 'This Post', value: threadTitle, inline: true },
      { name: 'Reporters Added', value: `${reporters.length}`, inline: true },
      { name: 'Total Reporters', value: `**${reporterCount}**`, inline: true },
      { name: 'Attachments Added', value: `${attachments.length}`, inline: true },
      { name: 'Merged By', value: interaction.user.username, inline: true },
    );

  if (existingLinked) {
    embed.addFields({ name: 'Previous Issue', value: `\`${existingLinked.id}\` was marked as merged` });
  }

  embed.setFooter({ text: `Target Issue ID: ${targetId}` }).setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

/**
 * Bulk-scrape all posts in a feedback forum — triage each, deduplicate, create/merge issues.
 */
async function executeScrape(interaction) {
  const forumChannel = interaction.options.getChannel('forum')
    || interaction.guild.channels.cache.find(ch => ch.type === ChannelType.GuildForum && ch.name.toLowerCase().includes('feedback'));

  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    return interaction.reply({
      content: 'Could not find a feedback forum channel. Use the `forum` option to specify one.',
      ephemeral: true,
    });
  }

  const includeArchived = interaction.options.getBoolean('include-archived') ?? false;
  const maxPosts = interaction.options.getInteger('limit') || 50;

  await interaction.deferReply();

  // --- Fetch all threads from the forum ---
  const threads = [];

  // Active threads
  try {
    const active = await forumChannel.threads.fetchActive();
    threads.push(...active.threads.values());
  } catch (err) {
    console.error('Failed to fetch active threads:', err.message);
  }

  // Archived threads (if requested)
  if (includeArchived) {
    try {
      let hasMore = true;
      let beforeTimestamp;
      while (hasMore && threads.length < maxPosts + 50) {
        const archived = await forumChannel.threads.fetchArchived({
          limit: 100,
          ...(beforeTimestamp && { before: beforeTimestamp }),
        });
        threads.push(...archived.threads.values());
        hasMore = archived.hasMore;
        if (archived.threads.size > 0) {
          const oldest = [...archived.threads.values()].pop();
          beforeTimestamp = oldest.archiveTimestamp;
        } else {
          hasMore = false;
        }
      }
    } catch (err) {
      console.error('Failed to fetch archived threads:', err.message);
    }
  }

  if (threads.length === 0) {
    return interaction.editReply(`No posts found in ${forumChannel}.`);
  }

  // Sort by creation date (oldest first) so duplicate detection builds up naturally
  threads.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // --- Filter out already-scraped threads ---
  // Page through all issues with threadIds to know which posts are already linked
  const allIssuesWithThread = await firestore.getAllIssuesWithThreadId();
  const scrapedThreadIds = new Set(
    allIssuesWithThread.map(i => i.threadId)
  );

  const newThreads = threads.filter(t => !scrapedThreadIds.has(t.id));
  const alreadyScrapedCount = threads.length - newThreads.length;

  // Cap to limit
  const toProcess = newThreads.slice(0, maxPosts);

  // --- Progress embed ---
  const stats = { created: 0, merged: 0, updated: 0, skipped: 0, alreadyScraped: alreadyScrapedCount, errored: 0, total: toProcess.length };
  const results = []; // { thread, outcome, issueId, summary }

  const progressEmbed = () => {
    const processed = stats.created + stats.merged + stats.updated + stats.skipped + stats.errored;
    const pct = stats.total > 0 ? Math.round((processed / stats.total) * 100) : 100;
    const bar = buildProgressBar(pct);

    return new EmbedBuilder()
      .setTitle('Scraping Feedback Forum...')
      .setColor(0x5865f2)
      .setDescription(
        `Processing **${forumChannel.name}** — ${processed}/${stats.total} new posts\n${bar} ${pct}%` +
        (stats.alreadyScraped > 0 ? `\n_${stats.alreadyScraped} already-scraped post${stats.alreadyScraped !== 1 ? 's' : ''} skipped_` : '')
      )
      .addFields(
        { name: 'New Issues', value: `${stats.created}`, inline: true },
        { name: 'Merged', value: `${stats.merged}`, inline: true },
        { name: 'Updated', value: `${stats.updated}`, inline: true },
        { name: 'Skipped', value: `${stats.skipped}`, inline: true },
        { name: 'Errors', value: `${stats.errored}`, inline: true },
      )
      .setTimestamp();
  };

  await interaction.editReply({ embeds: [progressEmbed()] });

  // Update progress every 5 posts
  let lastUpdate = 0;
  const maybeUpdateProgress = async () => {
    const processed = stats.created + stats.merged + stats.updated + stats.skipped + stats.errored;
    if (processed - lastUpdate >= 5 || processed === stats.total) {
      lastUpdate = processed;
      try {
        await interaction.editReply({ embeds: [progressEmbed()] });
      } catch { /* interaction may have expired */ }
    }
  };

  // --- Process each thread ---
  for (const thread of toProcess) {
    try {
      const result = await processOneThread(interaction.guild, thread, forumChannel);
      results.push({ thread, ...result });
      stats[result.outcome]++;
    } catch (err) {
      console.error(`Scrape error on thread ${thread.id} (${thread.name}):`, err.message);
      results.push({ thread, outcome: 'errored', summary: err.message });
      stats.errored++;
    }
    await maybeUpdateProgress();
  }

  // --- Final summary ---
  const summaryEmbed = new EmbedBuilder()
    .setTitle('Feedback Scrape Complete')
    .setColor(stats.errored > 0 ? 0xffa500 : 0x2ecc71)
    .setDescription(
      `Processed **${stats.total}** new posts from **#${forumChannel.name}**` +
      (stats.alreadyScraped > 0 ? ` (${stats.alreadyScraped} already scraped)` : '')
    )
    .addFields(
      { name: 'New Issues Created', value: `${stats.created}`, inline: true },
      { name: 'Merged into Existing', value: `${stats.merged}`, inline: true },
      { name: 'Already Scraped', value: `${stats.alreadyScraped}`, inline: true },
      { name: 'Skipped (empty)', value: `${stats.skipped}`, inline: true },
      { name: 'Errors', value: `${stats.errored}`, inline: true },
    )
    .setTimestamp();

  // Add breakdown of created/merged issues (up to 15)
  const noteworthy = results.filter(r => r.outcome === 'created' || r.outcome === 'merged');
  if (noteworthy.length > 0) {
    const lines = noteworthy.slice(0, 15).map(r => {
      const icon = r.outcome === 'created' ? '🆕' : '🔀';
      const id = r.issueId ? ` \`${r.issueId}\`` : '';
      return `${icon} **${r.thread.name.slice(0, 40)}**${id} — ${(r.summary || 'No summary').slice(0, 80)}`;
    });
    if (noteworthy.length > 15) lines.push(`_...and ${noteworthy.length - 15} more_`);
    summaryEmbed.addFields({ name: 'Issue Breakdown', value: lines.join('\n').slice(0, 1024) });
  }

  // Show errored threads if any
  const errored = results.filter(r => r.outcome === 'errored');
  if (errored.length > 0) {
    const lines = errored.slice(0, 10).map(r =>
      `**${r.thread.name.slice(0, 30)}** — ${(r.summary || 'Unknown error').slice(0, 60)}`
    );
    summaryEmbed.addFields({ name: 'Errors', value: lines.join('\n').slice(0, 1024) });
  }

  await interaction.editReply({ embeds: [summaryEmbed] });
}

/**
 * Process a single forum thread — classify, deduplicate, create or merge.
 * Returns { outcome: 'created'|'merged'|'updated'|'skipped', issueId?, summary? }
 */
async function processOneThread(guild, thread, forumChannel) {
  // Scrape messages
  const { messages, starterMessage, reporters } = await scrapeThread(thread);

  if (!starterMessage || (!starterMessage.content?.trim() && messages.length === 0)) {
    return { outcome: 'skipped', summary: 'Empty thread' };
  }

  const threadTitle = thread.name;
  const fullText = buildFullText(threadTitle, starterMessage, messages);

  // Skip very short content (likely noise)
  if (fullText.length < 20) {
    return { outcome: 'skipped', summary: 'Too short' };
  }

  // Resolve forum tags
  const availableTags = forumChannel.availableTags || [];
  const forumTags = (thread.appliedTags || []).map(tagId => {
    const tag = availableTags.find(t => t.id === tagId);
    return tag?.name || 'unknown';
  });

  // Check if already linked to an issue
  const existingLinked = await firestore.getIssueByThreadId(thread.id);
  if (existingLinked) {
    // Update context and reporters on the existing issue
    let reporterCount = (existingLinked.reporterIds || []).length;
    for (const r of reporters) {
      const result = await firestore.addReporter(existingLinked.id, r.id, r.name);
      if (result) reporterCount = (result.reporterIds || []).length;
    }

    const existingContextCount = (existingLinked.threadContext || []).length;
    const humanMessages = messages.filter(m => !m.author.bot && m.content?.trim());
    const newMessages = humanMessages.slice(existingContextCount);
    for (const msg of newMessages) {
      await firestore.appendThreadContext(existingLinked.id, `${msg.author.username}: ${msg.content.trim()}`);
    }

    const updatedIssue = await firestore.getIssueById(existingLinked.id);
    await refreshTriageEmbed(guild, updatedIssue, existingLinked.id, reporterCount);

    return { outcome: 'updated', issueId: existingLinked.id, summary: existingLinked.summary };
  }

  // AI classify
  const classification = await classifyIssue(fullText);

  // Duplicate check (Jaccard fast → AI accurate)
  let duplicateMatch = null;
  try {
    const openIssues = await firestore.getOpenIssues(100);
    duplicateMatch = findDuplicate(classification.summary, fullText, openIssues);
    if (!duplicateMatch) {
      duplicateMatch = await findDuplicateAI(classification.summary, classification.category, openIssues);
    }
  } catch (err) {
    console.error('Duplicate detection failed during scrape:', err.message);
  }

  if (duplicateMatch) {
    // Merge into existing issue
    const existing = duplicateMatch.issue;

    let reporterCount = (existing.reporterIds || []).length;
    for (const r of reporters) {
      const result = await firestore.addReporter(existing.id, r.id, r.name);
      if (result) reporterCount = (result.reporterIds || []).length;
    }

    const humanMessages = messages.filter(m => !m.author.bot && m.content?.trim());
    const contextSummary = humanMessages.map(m => `${m.author.username}: ${m.content.trim()}`).join('\n');
    if (contextSummary) {
      await firestore.appendThreadContext(
        existing.id,
        `[Scraped from "${threadTitle}" — ${reporters.length} reporter${reporters.length !== 1 ? 's' : ''}]: ${contextSummary.slice(0, 1500)}`
      );
    }

    await firestore.updateIssueThreadId(existing.id, thread.id);

    const updatedIssue = await firestore.getIssueById(existing.id);
    await refreshTriageEmbed(guild, updatedIssue, existing.id, reporterCount);

    return {
      outcome: 'merged',
      issueId: existing.id,
      summary: `${Math.round(duplicateMatch.score * 100)}% match → ${(existing.summary || 'Untitled').slice(0, 60)}`,
    };
  }

  // New issue
  const attachments = [];
  for (const msg of [starterMessage, ...messages]) {
    for (const att of msg.attachments.values()) {
      attachments.push({
        url: att.url,
        name: att.name,
        contentType: att.contentType,
        size: att.size,
        isImage: att.contentType?.startsWith('image/') || false,
      });
    }
  }

  const reporterList = reporters.map(r => ({
    id: r.id,
    name: r.name,
    addedAt: new Date().toISOString(),
  }));

  const issueData = {
    source: 'feedback-scrape',
    threadId: thread.id,
    channelId: thread.parentId,
    guildId: guild.id,
    messageId: starterMessage.id,
    reporterId: thread.ownerId,
    reporterName: reporters[0]?.name || 'unknown',
    reporterIds: reporterList,
    text: fullText,
    forumTags,
    priority: classification.priority,
    category: classification.category,
    summary: classification.summary,
    reasoning: classification.reasoning,
    attachments: attachments.length > 0 ? attachments : null,
  };

  if (classification.raw) issueData.rawAiResponse = classification.raw;

  const humanMessages = messages.filter(m => !m.author.bot && m.content?.trim());
  if (humanMessages.length > 0) {
    issueData.threadContext = humanMessages.map(m => ({
      text: `${m.author.username}: ${m.content.trim()}`,
      addedAt: m.createdAt.toISOString(),
    }));
  }

  const issueId = await firestore.saveIssue(issueData);

  const savedIssue = await firestore.getIssueById(issueId);
  const triageMessageId = await postIssueEmbed(guild, savedIssue, issueId);
  if (triageMessageId) {
    await firestore.updateIssueTriageMessageId(issueId, triageMessageId);
  }

  return { outcome: 'created', issueId, summary: classification.summary };
}

/**
 * Reorganize — AI-scan all open issues for duplicate clusters and merge them.
 */
async function executeReorganize(interaction) {
  await interaction.deferReply();

  // Fetch all open issues
  const openIssues = await firestore.getOpenIssues(100);
  if (openIssues.length < 2) {
    return interaction.editReply('Not enough open issues to check for duplicates.');
  }

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle('Reorganizing Issues...')
      .setColor(0x5865f2)
      .setDescription(`Scanning **${openIssues.length}** open issues for duplicates using AI...`)
      .setTimestamp()],
  });

  // AI-powered batch duplicate detection
  const clusters = await findDuplicateClustersAI(openIssues);

  if (clusters.length === 0) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('No Duplicates Found')
        .setColor(0x2ecc71)
        .setDescription(`Scanned **${openIssues.length}** open issues — no duplicates detected.`)
        .setTimestamp()],
    });
  }

  // Merge each cluster
  let totalMerged = 0;
  const mergeResults = [];

  for (const cluster of clusters) {
    const canonical = cluster.canonical;
    let reporterCount = (canonical.reporterIds || []).length;

    for (const dupe of cluster.duplicates) {
      // Add reporters from duplicate to canonical
      const dupeReporters = dupe.reporterIds || [];
      for (const r of dupeReporters) {
        const result = await firestore.addReporter(canonical.id, r.id, r.name);
        if (result) reporterCount = (result.reporterIds || []).length;
      }
      // If no reporterIds array, add the single reporter
      if (dupeReporters.length === 0 && dupe.reporterId) {
        const result = await firestore.addReporter(canonical.id, dupe.reporterId, dupe.reporterName || 'unknown');
        if (result) reporterCount = (result.reporterIds || []).length;
      }

      // Append the duplicate's text as context
      const contextText = `[Merged from duplicate issue ${dupe.id}]: ${(dupe.text || '').slice(0, 1500)}`;
      await firestore.appendThreadContext(canonical.id, contextText);

      // Merge thread context from duplicate
      const dupeContext = dupe.threadContext || [];
      for (const ctx of dupeContext) {
        await firestore.appendThreadContext(canonical.id, ctx.text);
      }

      // Merge attachments
      if (dupe.attachments && dupe.attachments.length > 0) {
        const canonicalDoc = await firestore.getIssueById(canonical.id);
        const existingAttachments = canonicalDoc.attachments || [];
        await firestore.updateIssueFields(canonical.id, {
          attachments: [...existingAttachments, ...dupe.attachments],
        });
      }

      // If duplicate has a threadId, link it to the canonical issue
      if (dupe.threadId) {
        await firestore.updateIssueThreadId(canonical.id, dupe.threadId);
      }

      // Record merge history
      await firestore.updateIssueFields(canonical.id, {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        mergeHistory: admin.firestore.FieldValue.arrayUnion({
          mergedAt: new Date().toISOString(),
          mergedBy: interaction.user.username,
          mergedByUserId: interaction.user.id,
          sourceIssueId: dupe.id,
          sourceSummary: (dupe.summary || '').slice(0, 100),
          reason: `Reorganize: ${cluster.reason}`,
        }),
      });

      // Mark duplicate as merged
      await firestore.updateIssueFields(dupe.id, {
        status: 'merged',
        mergedInto: canonical.id,
        closedBy: interaction.user.id,
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      totalMerged++;
    }

    // Refresh triage embed on canonical
    const updatedCanonical = await firestore.getIssueById(canonical.id);
    await refreshTriageEmbed(interaction.guild, updatedCanonical, canonical.id, reporterCount);

    mergeResults.push({
      canonical: canonical.summary || canonical.id,
      canonicalId: canonical.id,
      merged: cluster.duplicates.map(d => d.summary || d.id),
      mergedIds: cluster.duplicates.map(d => d.id),
      reason: cluster.reason,
      reporterCount,
    });
  }

  // Build summary embed
  const embed = new EmbedBuilder()
    .setTitle('Reorganization Complete')
    .setColor(0x2ecc71)
    .setDescription(
      `Scanned **${openIssues.length}** open issues.\n` +
      `Found **${clusters.length}** duplicate group${clusters.length !== 1 ? 's' : ''} — merged **${totalMerged}** issue${totalMerged !== 1 ? 's' : ''}.`
    )
    .setTimestamp();

  for (const result of mergeResults.slice(0, 10)) {
    const mergedList = result.mergedIds.map((id, i) =>
      `\`${id.slice(0, 8)}…\` ${(result.merged[i] || '').slice(0, 50)}`
    ).join('\n');

    embed.addFields({
      name: `\`${result.canonicalId.slice(0, 8)}…\` ${result.canonical.slice(0, 50)} (${result.reporterCount} reporters)`,
      value: `**Merged in:**\n${mergedList}\n*${result.reason}*`.slice(0, 1024),
    });
  }

  if (mergeResults.length > 10) {
    embed.addFields({ name: '...', value: `_and ${mergeResults.length - 10} more groups_` });
  }

  embed.setFooter({ text: `Reorganized by ${interaction.user.username}` });

  return interaction.editReply({ embeds: [embed] });
}

function buildProgressBar(pct) {
  const filled = Math.round(pct / 5);
  const empty = 20 - filled;
  return '`' + '█'.repeat(filled) + '░'.repeat(empty) + '`';
}

/**
 * Thread already linked to an issue — refresh context and reporter list.
 */
async function handleExistingLinked(interaction, issue, messages, reporters, fullText) {
  // Add any new reporters
  let reporterCount = (issue.reporterIds || []).length;
  for (const r of reporters) {
    const result = await firestore.addReporter(issue.id, r.id, r.name);
    if (result) reporterCount = (result.reporterIds || []).length;
  }

  // Append new context from messages not already tracked
  const existingContextCount = (issue.threadContext || []).length;
  const humanMessages = messages.filter(m => !m.author.bot && m.content?.trim());
  const newMessages = humanMessages.slice(existingContextCount);

  for (const msg of newMessages) {
    await firestore.appendThreadContext(issue.id, `${msg.author.username}: ${msg.content.trim()}`);
  }

  const updatedIssue = await firestore.getIssueById(issue.id);
  const totalContext = (updatedIssue.threadContext || []).length;

  // Update triage embed if possible
  await refreshTriageEmbed(interaction.guild, updatedIssue, issue.id, reporterCount);

  const embed = new EmbedBuilder()
    .setColor(PRIORITY_COLORS[issue.priority] ?? 0x5865f2)
    .setTitle('Issue Updated')
    .setDescription(
      `This post is already linked to issue \`${issue.id}\`.\n\n` +
      `I've refreshed the context and reporter list.`
    )
    .addFields(
      { name: 'Summary', value: issue.summary || 'N/A' },
      { name: 'Priority', value: issue.priority || 'unclassified', inline: true },
      { name: 'Status', value: (issue.status || 'open').toUpperCase(), inline: true },
      { name: 'Reporters', value: `**${reporterCount}** unique user${reporterCount !== 1 ? 's' : ''}`, inline: true },
      { name: 'Context Entries', value: `${totalContext}`, inline: true },
    )
    .setFooter({ text: `Issue ID: ${issue.id}` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

/**
 * Found a similar existing issue — merge context and bump reporter count.
 */
async function handleDuplicate(interaction, thread, classification, match, reporters, messages, forumTags) {
  const existing = match.issue;
  const similarity = Math.round(match.score * 100);

  // Add all reporters from this thread to the existing issue
  let reporterCount = (existing.reporterIds || []).length;
  for (const r of reporters) {
    const result = await firestore.addReporter(existing.id, r.id, r.name);
    if (result) reporterCount = (result.reporterIds || []).length;
  }

  // Append this thread's conversation as context
  const humanMessages = messages.filter(m => !m.author.bot && m.content?.trim());
  const contextSummary = humanMessages.map(m => `${m.author.username}: ${m.content.trim()}`).join('\n');
  if (contextSummary) {
    await firestore.appendThreadContext(
      existing.id,
      `[Feedback post "${thread.name}" — ${reporters.length} reporter${reporters.length !== 1 ? 's' : ''}]: ${contextSummary.slice(0, 1500)}`
    );
  }

  // Link this thread to the existing issue so future messages auto-track
  await firestore.updateIssueThreadId(existing.id, thread.id);

  const updatedIssue = await firestore.getIssueById(existing.id);
  const totalContext = (updatedIssue.threadContext || []).length;

  // Update triage embed
  await refreshTriageEmbed(interaction.guild, updatedIssue, existing.id, reporterCount);

  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle('Duplicate Found — Merged')
    .setDescription(
      `This feedback matches an existing issue. I've merged the context and linked this thread.\n\n` +
      `Future messages here will automatically update the issue.`
    )
    .addFields(
      { name: 'This Post', value: classification.summary, inline: false },
      { name: 'Existing Issue', value: existing.summary || 'No summary', inline: false },
      { name: 'Match', value: `${similarity}%`, inline: true },
      { name: 'Priority', value: existing.priority || 'unclassified', inline: true },
      { name: 'Reporters', value: `**${reporterCount}** unique user${reporterCount !== 1 ? 's' : ''}`, inline: true },
      { name: 'Context Entries', value: `${totalContext}`, inline: true },
    )
    .setFooter({ text: `Existing Issue ID: ${existing.id}` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

/**
 * No duplicate — create a brand new issue from this forum post.
 */
async function handleNewIssue(interaction, thread, starterMessage, classification, reporters, messages, forumTags, fullText) {
  // Collect attachments from all messages
  const attachments = [];
  for (const msg of [starterMessage, ...messages]) {
    for (const att of msg.attachments.values()) {
      attachments.push({
        url: att.url,
        name: att.name,
        contentType: att.contentType,
        size: att.size,
        isImage: att.contentType?.startsWith('image/') || false,
      });
    }
  }

  // Build reporter list
  const reporterList = reporters.map(r => ({
    id: r.id,
    name: r.name,
    addedAt: new Date().toISOString(),
  }));

  const issueData = {
    source: 'feedback-triage',
    threadId: thread.id,
    channelId: thread.parentId,
    guildId: interaction.guild.id,
    messageId: starterMessage.id,
    reporterId: thread.ownerId,
    reporterName: reporters[0]?.name || 'unknown',
    reporterIds: reporterList,
    text: fullText,
    forumTags,
    priority: classification.priority,
    category: classification.category,
    summary: classification.summary,
    reasoning: classification.reasoning,
    attachments: attachments.length > 0 ? attachments : null,
  };

  if (classification.raw) issueData.rawAiResponse = classification.raw;

  // Build thread context from follow-up messages
  const humanMessages = messages.filter(m => !m.author.bot && m.content?.trim());
  if (humanMessages.length > 0) {
    issueData.threadContext = humanMessages.map(m => ({
      text: `${m.author.username}: ${m.content.trim()}`,
      addedAt: m.createdAt.toISOString(),
    }));
  }

  const issueId = await firestore.saveIssue(issueData);

  // Post triage embed
  const savedIssue = await firestore.getIssueById(issueId);
  const triageMessageId = await postIssueEmbed(interaction.guild, savedIssue, issueId);
  if (triageMessageId) {
    await firestore.updateIssueTriageMessageId(issueId, triageMessageId);
  }

  const reporterCount = reporterList.length;
  const contextCount = (issueData.threadContext || []).length;

  const embed = new EmbedBuilder()
    .setColor(PRIORITY_COLORS[classification.priority] ?? 0x5865f2)
    .setTitle('Issue Created from Feedback')
    .setDescription(
      `I've triaged this forum post into a new issue.\n\n` +
      `Future messages in this thread will automatically update the issue.`
    )
    .addFields(
      { name: 'Summary', value: classification.summary },
      { name: 'Priority', value: classification.priority, inline: true },
      { name: 'Category', value: (classification.category || 'other').replace(/_/g, ' '), inline: true },
      { name: 'Reporters', value: `**${reporterCount}** unique user${reporterCount !== 1 ? 's' : ''}`, inline: true },
      { name: 'Context Entries', value: `${contextCount}`, inline: true },
    )
    .setFooter({ text: `Issue ID: ${issueId}` })
    .setTimestamp();

  if (classification.follow_up) {
    embed.addFields({ name: 'Follow-up', value: classification.follow_up });
  }

  await interaction.editReply({ embeds: [embed] });

  // Post follow-up question if AI generated one
  if (classification.follow_up) {
    await thread.send(classification.follow_up);
  }
}

// --- Helpers ---

async function scrapeThread(thread) {
  let allMessages = [];
  let lastId;
  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
    if (batch.size === 0) break;
    allMessages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }

  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  let starterMessage = null;
  try {
    starterMessage = await thread.fetchStarterMessage();
  } catch {
    // Fall back to first message
    starterMessage = allMessages[0] || null;
  }

  // Collect unique reporters (non-bot users who posted)
  const reporterMap = new Map();
  for (const msg of allMessages) {
    if (msg.author.bot) continue;
    if (!reporterMap.has(msg.author.id)) {
      reporterMap.set(msg.author.id, { id: msg.author.id, name: msg.author.username });
    }
  }
  if (starterMessage && !starterMessage.author.bot && !reporterMap.has(starterMessage.author.id)) {
    reporterMap.set(starterMessage.author.id, { id: starterMessage.author.id, name: starterMessage.author.username });
  }

  // Exclude the starter from follow-up messages
  const followUpMessages = starterMessage
    ? allMessages.filter(m => m.id !== starterMessage.id)
    : allMessages;

  return {
    messages: followUpMessages,
    starterMessage,
    reporters: [...reporterMap.values()],
  };
}

function buildFullText(threadTitle, starterMessage, followUpMessages) {
  let text = `${threadTitle}\n\n${starterMessage.content || ''}`;

  const humanFollowUps = followUpMessages.filter(m => !m.author.bot && m.content?.trim());
  if (humanFollowUps.length > 0) {
    text += '\n\n--- Additional context from thread ---\n';
    text += humanFollowUps.map(m => `${m.author.username}: ${m.content.trim()}`).join('\n');
  }

  return text.trim();
}

async function refreshTriageEmbed(guild, issue, issueId, reporterCount) {
  const triageChannelName = getConfig('triage_channel') || 'eng-triage';
  if (!issue?.triageMessageId) return;

  const triageChannel = guild.channels.cache.find(
    ch => ch.name === triageChannelName && ch.isTextBased()
  );
  if (!triageChannel) return;

  try {
    const triageMsg = await triageChannel.messages.fetch(issue.triageMessageId);
    const embed = buildIssueEmbed(issue, issueId);
    embed.addFields({
      name: 'Affected Users',
      value: `**${reporterCount}** unique reporter${reporterCount !== 1 ? 's' : ''}`,
      inline: true,
    });
    embed.setTimestamp();
    await triageMsg.edit({ embeds: [embed] });
  } catch {
    // Triage message may have been deleted
  }
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  try {
    const db = admin.firestore();
    const snapshot = await db.collection('issues')
      .where('status', 'in', ['open', 'acknowledged', 'escalated'])
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const filtered = snapshot.docs
      .filter(doc => {
        const d = doc.data();
        return doc.id.toLowerCase().includes(focused) || (d.summary || '').toLowerCase().includes(focused);
      })
      .slice(0, 25)
      .map(doc => {
        const d = doc.data();
        const reporters = (d.reporterIds || []).length;
        return {
          name: `${doc.id.slice(0, 8)}… | ${d.priority || '?'} | ${reporters} reporter${reporters !== 1 ? 's' : ''} | ${(d.summary || 'Untitled').slice(0, 50)}`,
          value: doc.id,
        };
      });
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
}

module.exports = { data: commandData, execute, autocomplete };
