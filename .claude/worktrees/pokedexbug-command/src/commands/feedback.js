const { SlashCommandBuilder, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getConfig } = require('../config/config');
const { findTriageChannel } = require('../services/triage');
const firestore = require('../services/firestore');

function buildFeedbackThemeButtonsWithId(issueId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`triage_ack_${issueId}`).setLabel('Acknowledged').setEmoji('👀').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`triage_fix_${issueId}`).setLabel('Fixed').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`triage_wontfix_${issueId}`).setLabel("Won't Fix").setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`triage_escalate_${issueId}`).setLabel('Escalate').setEmoji('🔺').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`triage_delete_${issueId}`).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );
}

function buildFeedbackThemeButtons(themeIndex) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`fb_ack_${themeIndex}`)
      .setLabel('Acknowledged')
      .setEmoji('👀')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`fb_fix_${themeIndex}`)
      .setLabel('Fixed')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`fb_wontfix_${themeIndex}`)
      .setLabel("Won't Fix")
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`fb_escalate_${themeIndex}`)
      .setLabel('Escalate')
      .setEmoji('🔺')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`fb_delete_${themeIndex}`)
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const commandData = new SlashCommandBuilder()
  .setName('feedback')
  .setDescription('Analyze and manage feedback from the forum')
  .addSubcommand(sub =>
    sub.setName('analyze')
      .setDescription('AI theme analysis of feedback forum posts')
      .addIntegerOption(opt =>
        opt.setName('limit')
          .setDescription('Max issues to analyze (default: 20)')
          .setRequired(false))
      .addStringOption(opt =>
        opt.setName('visibility')
          .setDescription('Who can see the response')
          .setRequired(false)
          .addChoices(
            { name: 'Only me', value: 'ephemeral' },
            { name: 'Everyone', value: 'public' },
          )))
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Dashboard overview of feedback pipeline health')
      .addStringOption(opt =>
        opt.setName('visibility')
          .setDescription('Who can see the response')
          .setRequired(false)
          .addChoices(
            { name: 'Only me', value: 'ephemeral' },
            { name: 'Everyone', value: 'public' },
          )));

async function organizeFeedback(threads) {
  const model = getConfig('model');
  const feedbackTexts = threads.map((t, i) =>
    `[${i + 1}] "${t.name}" by ${t.authorName} (${t.messageCount} replies, ${t.tags.join(', ') || 'no tags'})\n${t.firstMessage || '(no content)'}`
  ).join('\n\n---\n\n');

  const systemPrompt = `You are Pokedex, an expert engineering triage AI for poke.com (a Pokemon-themed platform). Analyze these Discord feedback posts with extreme detail for the engineering team.

Return ONLY valid JSON with this structure:
{
  "themes": [
    {
      "name": "Theme name — be specific (e.g. 'Gmail OAuth Sync Failure' not 'Email Issues')",
      "description": "Detailed 2-4 sentence description of what users are experiencing, including patterns you notice",
      "priority": "critical" | "high" | "medium" | "low",
      "priority_reasoning": "Why this priority level — mention user impact, frequency, severity",
      "category": "bug" | "feature_request" | "ux_issue" | "performance" | "security" | "infrastructure" | "other",
      "posts": [1, 3, 7],
      "user_quotes": ["Direct quote from user 1", "Direct quote from user 3"],
      "affected_area": "Which part of poke.com is affected (e.g. 'Authentication', 'Trading', 'Profile', 'Mobile App', 'API')",
      "estimated_users_affected": "few" | "some" | "many" | "all",
      "reproducibility": "always" | "intermittent" | "rare" | "unknown",
      "suggested_action": "Specific, actionable engineering task — be concrete (e.g. 'Check OAuth token refresh logic in auth-service, likely token expiry not being handled')",
      "suggested_owner": "backend" | "frontend" | "mobile" | "infra" | "design" | "product",
      "dependencies": "Any blockers or related systems that might need attention",
      "workaround": "Any temporary fix users have found, or 'none known'"
    }
  ],
  "summary": "4-6 sentence executive summary covering the overall health of user feedback, key pain points, and what needs immediate attention",
  "top_requests": ["Most requested thing with detail", "Second most with detail", "Third most with detail", "Fourth if applicable", "Fifth if applicable"],
  "sentiment": "positive" | "mixed" | "negative",
  "sentiment_detail": "2-3 sentences explaining the sentiment — what are users happy about, what frustrates them",
  "risk_assessment": "Any feedback that suggests potential churn, security concerns, or reputation risk",
  "quick_wins": ["Easy fixes that would make users happy immediately", "Another quick win"],
  "patterns": "Any interesting patterns across feedback — time-based, user-type-based, feature-area-based"
}

PRIORITY GUIDELINES:
- critical: Data loss, security vulnerability, service down, blocks core functionality for many users
- high: Major feature broken, significant UX degradation, affects many users but has workarounds
- medium: Minor bugs, feature requests with strong demand, moderate UX issues
- low: Nice-to-haves, cosmetic issues, edge cases affecting few users

Be extremely detailed and specific. Engineers reading this should be able to start working immediately without needing more context. Quote users directly when their words illustrate the problem well.`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://poke.com',
        'X-Title': 'Pokedex Feedback Organizer',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: feedbackTexts },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    return JSON.parse(content);
  } catch (err) {
    console.error('Feedback analysis failed:', err.message);
    return null;
  }
}

function findFeedbackChannel(guild, channelName) {
  const normalize = (s) => s.replace(/[^\x20-\x7E]/g, '').toLowerCase().trim();
  const target = normalize(channelName);

  return guild.channels.cache.find(ch => {
    const validTypes = [ChannelType.GuildForum, ChannelType.GuildText, ChannelType.GuildAnnouncement];
    if (!validTypes.includes(ch.type)) return false;
    const name = normalize(ch.name);
    return name === target || name.includes(target);
  });
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'analyze') return handleAnalyze(interaction);
  if (sub === 'status') return handleStatus(interaction);
  return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}

async function handleAnalyze(interaction) {
  const limit = interaction.options.getInteger('limit') || 20;
  const visibility = interaction.options.getString('visibility') || 'ephemeral';
  const ephemeral = visibility === 'ephemeral';

  await interaction.deferReply({ ephemeral });

  const guild = interaction.guild;

  // Read from enriched Firestore data instead of raw forum scraping
  let issues = await firestore.getForumIssues(limit);

  if (issues.length === 0) {
    return interaction.editReply('No forum feedback issues found. Make sure the forum trigger is active.');
  }

  // Build enriched feedback data from issues
  const feedbackData = issues.map((issue, i) => ({
    name: issue.summary || 'Untitled',
    authorName: issue.reporterName || 'unknown',
    messageCount: (issue.threadContext || []).length,
    tags: issue.forumTags || [],
    firstMessage: buildEnrichedText(issue),
  }));

  const analysis = await organizeFeedback(feedbackData);
  if (!analysis) {
    return interaction.editReply('Failed to analyze feedback. Try again later.');
  }

  // Save each theme as an issue
  const savedIssueIds = [];
  for (const theme of (analysis.themes || [])) {
    try {
      const issueData = {
        messageId: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        guildId: guild.id,
        channelId: 'feedback-analysis',
        reporterId: interaction.user.id,
        reporterName: interaction.user.username,
        text: `[Feedback Theme] ${theme.description || ''}\n\nUser quotes: ${(theme.user_quotes || []).join(' | ')}\n\nSuggested action: ${theme.suggested_action || 'None'}`,
        priority: theme.priority || 'medium',
        category: theme.category || 'feature_request',
        summary: theme.name || 'Feedback theme',
        reasoning: theme.priority_reasoning || 'From /feedback analyze',
        source: 'feedback',
      };
      const issueId = await firestore.saveIssue(issueData);
      savedIssueIds.push(issueId);
    } catch (err) {
      console.error('Failed to save feedback theme:', err.message);
      savedIssueIds.push(null);
    }
  }

  const triageChannel = findTriageChannel(guild);
  if (triageChannel) {
    await postToTriage(triageChannel, analysis, { name: 'feedback' }, feedbackData.length, interaction.user.username, savedIssueIds);
  }

  await sendAnalysisReply(interaction, analysis, { name: 'feedback' }, feedbackData.length, !!triageChannel, savedIssueIds.filter(Boolean).length);
}

function buildEnrichedText(issue) {
  let text = issue.text || '';
  const context = (issue.threadContext || []).map(c => c.text).join('\n');
  if (context) {
    text += `\n\nAdditional context from conversation:\n${context}`;
  }
  if (issue.contextComplete) {
    text += '\n\n[Context gathering complete]';
  }
  return text.slice(0, 2000);
}

async function handleStatus(interaction) {
  const visibility = interaction.options.getString('visibility') || 'ephemeral';
  const ephemeral = visibility === 'ephemeral';

  await interaction.deferReply({ ephemeral });

  const issues = await firestore.getForumIssues();

  // Calculate stats
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thisWeek = issues.filter(i => {
    const created = i.createdAt?.toDate?.() || new Date(i.createdAt);
    return created >= weekAgo;
  });

  const complete = issues.filter(i => i.contextComplete === true && i.status === 'open').length;
  const awaiting = issues.filter(i => !i.contextComplete && i.status === 'open').length;
  const newThisWeek = thisWeek.length;

  // By category
  const byCategory = {};
  for (const issue of issues.filter(i => i.status === 'open')) {
    const cat = (issue.category || 'other').replace(/_/g, ' ');
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  // By priority
  const byPriority = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues.filter(i => i.status === 'open')) {
    const p = issue.priority || 'low';
    if (byPriority[p] !== undefined) byPriority[p]++;
  }

  // Oldest awaiting context
  const oldestAwaiting = issues
    .filter(i => !i.contextComplete && i.status === 'open')
    .sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() || new Date(a.createdAt);
      const bTime = b.createdAt?.toDate?.() || new Date(b.createdAt);
      return aTime - bTime;
    })[0];

  const categoryLines = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `${cat}: **${count}**`)
    .join(' | ') || 'none';

  const embed = new EmbedBuilder()
    .setTitle('📊 Feedback Pipeline Status')
    .setColor(0x5865f2)
    .addFields(
      { name: '📝 Total Forum Issues', value: `This week: **${newThisWeek}** | All time: **${issues.length}**`, inline: false },
      { name: '📋 Context Status', value: `✅ Complete: **${complete}** | ⏳ Awaiting reply: **${awaiting}** | 🆕 New this week: **${newThisWeek}**`, inline: false },
      { name: '📂 By Category', value: categoryLines, inline: false },
      { name: '🎯 By Priority', value: `🔴 Critical: **${byPriority.critical}** | 🟠 High: **${byPriority.high}** | 🟡 Medium: **${byPriority.medium}** | 🟢 Low: **${byPriority.low}**`, inline: false },
    )
    .setTimestamp();

  if (oldestAwaiting) {
    const created = oldestAwaiting.createdAt?.toDate?.() || new Date(oldestAwaiting.createdAt);
    const timestamp = Math.floor(created.getTime() / 1000);
    embed.addFields({
      name: '⏰ Oldest Awaiting Context',
      value: `\`${oldestAwaiting.id}\` — ${oldestAwaiting.summary || 'No summary'} (<t:${timestamp}:R>)`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function postToTriage(triageChannel, analysis, sourceChannel, threadCount, requestedBy, savedIssueIds = []) {
  const PRIORITY_COLORS = { critical: 0xff0000, high: 0xff8c00, medium: 0xffd700, low: 0x00cc00 };
  const PRIORITY_EMOJI = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
  const OWNER_EMOJI = { backend: '⚙️', frontend: '🖥️', mobile: '📱', infra: '🏗️', design: '🎨', product: '📋' };

  // === HEADER EMBED ===
  const headerEmbed = new EmbedBuilder()
    .setTitle(`📊 FEEDBACK TRIAGE REPORT — #${sourceChannel.name}`)
    .setColor(0x5865f2)
    .setDescription(analysis.summary || 'No summary available.')
    .addFields(
      { name: '📝 Posts Analyzed', value: `${threadCount}`, inline: true },
      { name: '🏷️ Themes Found', value: `${analysis.themes?.length || 0}`, inline: true },
      { name: '👤 Requested By', value: requestedBy, inline: true },
    )
    .setTimestamp();

  // Sentiment detail
  if (analysis.sentiment_detail) {
    const SENTIMENT_EMOJI = { positive: '😊', mixed: '😐', negative: '😟' };
    headerEmbed.addFields({
      name: `${SENTIMENT_EMOJI[analysis.sentiment] || '😐'} Sentiment: ${(analysis.sentiment || 'mixed').toUpperCase()}`,
      value: analysis.sentiment_detail,
    });
  }

  // Top requests
  if (analysis.top_requests?.length > 0) {
    headerEmbed.addFields({
      name: '🔥 Top User Requests',
      value: analysis.top_requests.map((r, i) => `**${i + 1}.** ${r}`).join('\n'),
    });
  }

  // Risk assessment
  if (analysis.risk_assessment) {
    headerEmbed.addFields({
      name: '⚠️ Risk Assessment',
      value: analysis.risk_assessment,
    });
  }

  // Quick wins
  if (analysis.quick_wins?.length > 0) {
    headerEmbed.addFields({
      name: '⚡ Quick Wins',
      value: analysis.quick_wins.map(w => `• ${w}`).join('\n'),
    });
  }

  // Patterns
  if (analysis.patterns) {
    headerEmbed.addFields({
      name: '🔍 Patterns Observed',
      value: analysis.patterns,
    });
  }

  await triageChannel.send({ embeds: [headerEmbed] });

  // === THEME EMBEDS — one per theme with full detail ===
  for (const [i, theme] of (analysis.themes || []).slice(0, 10).entries()) {
    const color = PRIORITY_COLORS[theme.priority] || 0x808080;
    const priorityEmoji = PRIORITY_EMOJI[theme.priority] || '⚪';
    const ownerEmoji = OWNER_EMOJI[theme.suggested_owner] || '❓';

    const embed = new EmbedBuilder()
      .setTitle(`${priorityEmoji} #${i + 1}: ${theme.name}`)
      .setColor(color)
      .setDescription(theme.description || 'No description');

    // Row 1: Priority, Category, Area
    embed.addFields(
      { name: '🎯 Priority', value: `**${(theme.priority || 'unknown').toUpperCase()}**`, inline: true },
      { name: '📂 Category', value: theme.category || 'other', inline: true },
      { name: '🗂️ Affected Area', value: theme.affected_area || 'Unknown', inline: true },
    );

    // Row 2: Users affected, Reproducibility, Owner
    embed.addFields(
      { name: '👥 Users Affected', value: theme.estimated_users_affected || 'unknown', inline: true },
      { name: '🔄 Reproducibility', value: theme.reproducibility || 'unknown', inline: true },
      { name: `${ownerEmoji} Suggested Owner`, value: theme.suggested_owner || 'unassigned', inline: true },
    );

    // Priority reasoning
    if (theme.priority_reasoning) {
      embed.addFields({
        name: '💭 Why This Priority',
        value: theme.priority_reasoning,
      });
    }

    // User quotes
    if (theme.user_quotes?.length > 0) {
      const quotes = theme.user_quotes.map(q => `> *"${q}"*`).join('\n');
      embed.addFields({
        name: '🗣️ User Quotes',
        value: quotes.slice(0, 1024),
      });
    }

    // Suggested action — the main thing engineers need
    if (theme.suggested_action) {
      embed.addFields({
        name: '🛠️ Suggested Engineering Action',
        value: `\`\`\`${theme.suggested_action}\`\`\``,
      });
    }

    // Dependencies
    if (theme.dependencies && theme.dependencies !== 'none' && theme.dependencies !== 'None') {
      embed.addFields({
        name: '🔗 Dependencies / Related Systems',
        value: theme.dependencies,
      });
    }

    // Workaround
    if (theme.workaround && theme.workaround !== 'none known' && theme.workaround !== 'None known') {
      embed.addFields({
        name: '🩹 Known Workaround',
        value: theme.workaround,
      });
    }

    // Related posts count
    const issueId = savedIssueIds[i];
    embed.setFooter({ text: `${issueId ? `Issue ID: ${issueId} | ` : ''}Related posts: ${theme.posts?.length || 0} | Source: #${sourceChannel.name}` });

    // Use real issue ID for buttons if saved, otherwise use index
    const buttonId = issueId || `fb_${i}`;
    const buttons = issueId ? buildFeedbackThemeButtonsWithId(buttonId) : buildFeedbackThemeButtons(i);
    const msg = await triageChannel.send({ embeds: [embed], components: [buttons] });

    // Update Firestore with triage message ID
    if (issueId && msg) {
      try { await firestore.updateIssueTriageMessageId(issueId, msg.id); } catch {}
    }
  }

  // === SUMMARY FOOTER ===
  const priorities = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const theme of analysis.themes || []) {
    if (priorities[theme.priority] !== undefined) priorities[theme.priority]++;
  }

  const footerEmbed = new EmbedBuilder()
    .setTitle('📈 Priority Breakdown')
    .setColor(0x2f3136)
    .setDescription(
      `🔴 Critical: **${priorities.critical}** | 🟠 High: **${priorities.high}** | 🟡 Medium: **${priorities.medium}** | 🟢 Low: **${priorities.low}**\n\n` +
      `*Report generated by Pokedex from ${threadCount} feedback posts in #${sourceChannel.name}*`
    )
    .setTimestamp();

  await triageChannel.send({ embeds: [footerEmbed] });
}

async function sendAnalysisReply(interaction, analysis, channel, threadCount, postedToTriage, savedCount = 0) {
  const SENTIMENT_EMOJI = { positive: '😊', mixed: '😐', negative: '😟' };

  const embed = new EmbedBuilder()
    .setTitle(`📊 Feedback Analysis — #${channel.name}`)
    .setColor(0x5865f2)
    .setDescription(analysis.summary || 'No summary available.')
    .addFields(
      { name: 'Posts Analyzed', value: `${threadCount}`, inline: true },
      { name: 'Themes Found', value: `${analysis.themes?.length || 0}`, inline: true },
      { name: 'Sentiment', value: `${SENTIMENT_EMOJI[analysis.sentiment] || '😐'} ${analysis.sentiment || 'mixed'}`, inline: true },
    );

  if (analysis.top_requests?.length > 0) {
    embed.addFields({
      name: '🔥 Top Requests',
      value: analysis.top_requests.slice(0, 5).map((r, i) => `${i + 1}. ${r}`).join('\n'),
    });
  }

  if (analysis.quick_wins?.length > 0) {
    embed.addFields({
      name: '⚡ Quick Wins',
      value: analysis.quick_wins.map(w => `• ${w}`).join('\n'),
    });
  }

  if (postedToTriage) {
    embed.setFooter({ text: `Detailed report posted to #eng-triage | ${savedCount} themes saved to dashboard` });
  } else {
    embed.setFooter({ text: 'Warning: eng-triage channel not found — report not posted' });
  }

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data: commandData, execute };
