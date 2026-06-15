const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const firestore = require('../services/firestore');
const { getConfig } = require('../config/config');

// URL regex — matches http/https links (no g flag to avoid stateful .test() failures)
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/i;

const commandData = new SlashCommandBuilder()
  .setName('recipes')
  .setDescription('Community recipe collection from #show-and-tell')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(sub =>
    sub.setName('scrape')
      .setDescription('Scrape #show-and-tell for recipe links — sends each for approval before publishing')
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('Channel to scrape (defaults to #show-and-tell)')
          .addChannelTypes(ChannelType.GuildForum, ChannelType.GuildText)
          .setRequired(false))
      .addIntegerOption(opt =>
        opt.setName('limit')
          .setDescription('Max messages/threads to scan (default: 100)')
          .setMinValue(1)
          .setMaxValue(500)
          .setRequired(false))
      .addBooleanOption(opt =>
        opt.setName('auto-approve')
          .setDescription('Skip approval — publish all scraped recipes directly to the website')
          .setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('Show the top community recipes'))
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Submit a recipe link for approval')
      .addStringOption(opt =>
        opt.setName('url')
          .setDescription('The recipe URL')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('title')
          .setDescription('Name for this recipe')
          .setRequired(false))
      .addStringOption(opt =>
        opt.setName('tags')
          .setDescription('Comma-separated tags (e.g. "competitive, rain team, ou")')
          .setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('pending')
      .setDescription('Show recipes waiting for approval'))
  .addSubcommand(sub =>
    sub.setName('approve-all')
      .setDescription('Bulk-approve all pending recipes'))
  .addSubcommand(sub =>
    sub.setName('grab')
      .setDescription('Scrape this thread for recipe links and send to the website')
      .addBooleanOption(opt =>
        opt.setName('auto-approve')
          .setDescription('Publish directly without approval (default: false)')
          .setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('approve')
      .setDescription('Approve a specific pending recipe by ID')
      .addStringOption(opt =>
        opt.setName('id')
          .setDescription('Recipe ID to approve')
          .setRequired(true)
          .setAutocomplete(true)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'scrape') return executeScrape(interaction);
  if (sub === 'list') return executeList(interaction);
  if (sub === 'add') return executeAdd(interaction);
  if (sub === 'pending') return executePending(interaction);
  if (sub === 'approve-all') return executeApproveAll(interaction);
  if (sub === 'grab') return executeGrab(interaction);
  if (sub === 'approve') return executeApprove(interaction);
  return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}

// --- SCRAPE ---

async function executeScrape(interaction) {
  const channel = interaction.options.getChannel('channel')
    || interaction.guild.channels.cache.find(ch =>
      (ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildText) &&
      ch.name.toLowerCase().includes('show-and-tell'));

  if (!channel) {
    return interaction.reply({
      content: 'Could not find a #show-and-tell channel. Use the `channel` option to specify one.',
      ephemeral: true,
    });
  }

  const autoApprove = interaction.options.getBoolean('auto-approve') ?? false;

  // Find the approval channel (only needed if not auto-approving)
  let approvalChannel = null;
  if (!autoApprove) {
    approvalChannel = findApprovalChannel(interaction.guild);
    if (!approvalChannel) {
      return interaction.reply({
        content: 'Could not find a recipe approval channel. Set one with `/config set recipe_approval_channel <channel-name>` or create a #recipe-approval channel.\n\nOr use `auto-approve: true` to skip approval.',
        ephemeral: true,
      });
    }
  }

  await interaction.deferReply();

  // Pre-fetch all existing recipe data for fast duplicate & skip detection
  const allExisting = await firestore.getAllRecipes(1000);
  const existingUrls = new Set(allExisting.map(r => normalizeUrl(r.url)));
  const existingCodes = new Set(allExisting.map(r => r.referCode).filter(Boolean));
  // Track which threads and messages have already been scraped
  const scrapedThreadIds = new Set(allExisting.map(r => r.threadId).filter(Boolean));
  const scrapedMessageIds = new Set(allExisting.map(r => r.messageId).filter(Boolean));

  const maxMessages = interaction.options.getInteger('limit') || 100;
  const stats = { found: 0, new: 0, duplicate: 0, skipped: 0, noLinks: 0, errored: 0 };

  if (channel.type === ChannelType.GuildForum) {
    // Forum channel — scrape each thread
    const threads = [];

    try {
      const active = await channel.threads.fetchActive();
      threads.push(...active.threads.values());
    } catch (err) {
      console.error('Failed to fetch active threads:', err.message);
    }

    try {
      const archived = await channel.threads.fetchArchived({ limit: 100 });
      threads.push(...archived.threads.values());
    } catch (err) {
      console.error('Failed to fetch archived threads:', err.message);
    }

    threads.sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    // Filter out already-scraped threads
    const newThreads = threads.filter(t => !scrapedThreadIds.has(t.id));
    const skippedCount = threads.length - newThreads.length;
    stats.skipped += skippedCount;

    const toScan = newThreads.slice(0, maxMessages);

    const progressEmbed = (processed) => new EmbedBuilder()
      .setTitle('Scraping Recipes...')
      .setColor(0xf0c840)
      .setDescription(
        `Processing **${channel.name}** — ${processed}/${toScan.length} new posts\n` +
        `${buildProgressBar(Math.round((processed / Math.max(toScan.length, 1)) * 100))}` +
        (skippedCount > 0 ? `\n_${skippedCount} already-scraped post${skippedCount !== 1 ? 's' : ''} skipped_` : '')
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [progressEmbed(0)] });

    for (let i = 0; i < toScan.length; i++) {
      const thread = toScan[i];
      try {
        const result = await scrapeThreadForRecipes(thread, channel);
        stats.found += result.links.length;

        for (const recipe of result.links) {
          // Duplicate detection: check URL and refer code
          if (isDuplicateRecipe(recipe.url, recipe.referCode, existingUrls, existingCodes)) {
            stats.duplicate++;
            continue;
          }

          // Mark as approved or pending
          recipe.status = autoApprove ? 'approved' : 'pending';
          if (autoApprove) {
            recipe.reviewedBy = interaction.user.username;
            recipe.reviewedById = interaction.user.id;
          }
          const saved = await firestore.saveRecipe(recipe);
          stats.new++;

          // Track for future duplicate checks within this scrape
          existingUrls.add(normalizeUrl(recipe.url));
          if (recipe.referCode) existingCodes.add(recipe.referCode);

          // Post approval embed if not auto-approving
          if (!autoApprove && approvalChannel) {
            await postApprovalEmbed(approvalChannel, recipe, saved.id);
          }
        }

        if (result.links.length === 0) stats.noLinks++;
      } catch (err) {
        console.error(`Recipe scrape error (${thread.name}):`, err.message);
        stats.errored++;
      }

      if ((i + 1) % 5 === 0 || i === toScan.length - 1) {
        try { await interaction.editReply({ embeds: [progressEmbed(i + 1)] }); } catch {}
      }
    }

  } else {
    // Text channel — scrape messages directly
    const allMessages = await fetchChannelMessages(channel, maxMessages);

    // Filter out already-scraped messages
    const newMessages = allMessages.filter(m => !scrapedMessageIds.has(m.id));
    const msgSkipped = allMessages.length - newMessages.length;
    stats.skipped += msgSkipped;

    const progressEmbed = (processed) => new EmbedBuilder()
      .setTitle('Scraping Recipes...')
      .setColor(0xf0c840)
      .setDescription(
        `Processing **#${channel.name}** — ${processed}/${newMessages.length} new messages\n` +
        `${buildProgressBar(Math.round((processed / Math.max(newMessages.length, 1)) * 100))}` +
        (msgSkipped > 0 ? `\n_${msgSkipped} already-scraped message${msgSkipped !== 1 ? 's' : ''} skipped_` : '')
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [progressEmbed(0)] });

    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i];
      try {
        const links = extractLinks(msg.content);
        stats.found += links.length;

        for (const url of links) {
          const referCode = getPokeCode(url);

          // Duplicate detection
          if (isDuplicateRecipe(url, referCode, existingUrls, existingCodes)) {
            stats.duplicate++;
            continue;
          }

          const recipe = {
            url,
            title: extractTitleFromMessage(msg.content, url),
            description: cleanDescription(msg.content, url),
            referCode,
            sharedBy: [{ id: msg.author.id, name: msg.author.username, sharedAt: msg.createdAt.toISOString() }],
            channelId: channel.id,
            channelName: channel.name,
            guildId: interaction.guild.id,
            messageId: msg.id,
            source: inferSource(url),
            tags: extractTags(msg.content),
            status: autoApprove ? 'approved' : 'pending',
          };

          if (autoApprove) {
            recipe.reviewedBy = interaction.user.username;
            recipe.reviewedById = interaction.user.id;
          }

          const saved = await firestore.saveRecipe(recipe);
          stats.new++;

          existingUrls.add(normalizeUrl(url));
          if (referCode) existingCodes.add(referCode);

          if (!autoApprove && approvalChannel) {
            await postApprovalEmbed(approvalChannel, recipe, saved.id);
          }
        }

        if (links.length === 0) stats.noLinks++;
      } catch (err) {
        stats.errored++;
      }

      if ((i + 1) % 10 === 0 || i === newMessages.length - 1) {
        try { await interaction.editReply({ embeds: [progressEmbed(i + 1)] }); } catch {}
      }
    }
  }

  // Final summary
  const statusLabel = autoApprove ? 'Auto-Approved' : 'Sent for Approval';
  const statusDesc = autoApprove
    ? `All new recipes are **live on the website** now.`
    : `All new recipes have been sent to ${approvalChannel} for review.`;

  const embed = new EmbedBuilder()
    .setTitle('Recipe Scrape Complete')
    .setColor(stats.errored > 0 ? 0xffa500 : 0x2ecc71)
    .setDescription(`Scraped **#${channel.name}** for recipe links.\n\n${statusDesc}`)
    .addFields(
      { name: 'Links Found', value: `${stats.found}`, inline: true },
      { name: statusLabel, value: `${stats.new}`, inline: true },
      { name: 'Duplicates', value: `${stats.duplicate}`, inline: true },
      { name: 'Already Scraped', value: `${stats.skipped}`, inline: true },
      { name: 'No Links', value: `${stats.noLinks}`, inline: true },
      { name: 'Errors', value: `${stats.errored}`, inline: true },
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// --- LIST ---

async function executeList(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const recipes = await firestore.getApprovedRecipes(25);
  if (recipes.length === 0) {
    return interaction.editReply('No approved recipes yet! Use `/recipes scrape` to import from #show-and-tell, then approve them.');
  }

  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
  const lines = recipes.slice(0, 20).map((r, i) => {
    const shares = r.shareCount > 1 ? ` (${r.shareCount} shares)` : '';
    const src = r.source ? ` \`${r.source}\`` : '';
    return `**${i + 1}.** [${(r.title || 'Untitled').slice(0, 50)}](${r.url})${src}${shares}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Community Recipes')
    .setColor(0xf0c840)
    .setDescription(lines.join('\n'))
    .addFields({ name: 'Full Collection', value: `[View all recipes on the web](${dashboardUrl}/recipes)` })
    .setFooter({ text: `${recipes.length} approved recipes` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// --- ADD ---

async function executeAdd(interaction) {
  const url = interaction.options.getString('url').trim();
  const title = interaction.options.getString('title') || null;
  const tagsRaw = interaction.options.getString('tags') || '';

  if (!URL_REGEX.test(url)) {
    return interaction.reply({ content: 'That doesn\'t look like a valid URL.', ephemeral: true });
  }

  // Check if already exists
  const existing = await firestore.getRecipeByUrl(url);
  if (existing) {
    const status = existing.status || 'approved';
    return interaction.reply({
      content: `This recipe already exists (status: **${status}**).`,
      ephemeral: true,
    });
  }

  const approvalChannel = findApprovalChannel(interaction.guild);
  if (!approvalChannel) {
    return interaction.reply({
      content: 'Could not find a recipe approval channel. Set one with `/config set recipe_approval_channel <channel-name>`.',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const recipe = {
    url,
    title: title || await fetchPageTitle(url) || extractTitleFromUrl(url),
    description: null,
    referCode: getPokeCode(url),
    sharedBy: [{ id: interaction.user.id, name: interaction.user.username, sharedAt: new Date().toISOString() }],
    channelId: interaction.channel?.id || null,
    channelName: interaction.channel?.name || null,
    guildId: interaction.guild.id,
    messageId: null,
    source: inferSource(url),
    tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [],
    status: 'pending',
  };

  const saved = await firestore.saveRecipe(recipe);
  await postApprovalEmbed(approvalChannel, recipe, saved.id);

  const embed = new EmbedBuilder()
    .setTitle('Recipe Submitted for Approval')
    .setColor(0xf0c840)
    .setDescription(
      `[${recipe.title || url}](${url})\n\n` +
      `Your recipe has been sent to ${approvalChannel} for review. It will appear on the recipe page once approved.`
    )
    .addFields(
      { name: 'Source', value: recipe.source || 'Unknown', inline: true },
      { name: 'Submitted By', value: interaction.user.username, inline: true },
    )
    .setTimestamp();

  if (recipe.tags.length > 0) {
    embed.addFields({ name: 'Tags', value: recipe.tags.map(t => `\`${t}\``).join(' '), inline: true });
  }

  return interaction.editReply({ embeds: [embed] });
}

// --- PENDING ---

async function executePending(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const recipes = await firestore.getPendingRecipes(25);
  if (recipes.length === 0) {
    return interaction.editReply('No recipes pending approval.');
  }

  const lines = recipes.map((r, i) => {
    const src = r.source ? ` \`${r.source}\`` : '';
    const by = r.sharedBy?.[0]?.name || 'unknown';
    return `**${i + 1}.** [${(r.title || 'Untitled').slice(0, 50)}](${r.url})${src} — by ${by}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Pending Recipe Approvals')
    .setColor(0xffa500)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${recipes.length} pending` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// --- APPROVE ALL ---

async function executeApproveAll(interaction) {
  await interaction.deferReply();

  const pending = await firestore.getPendingRecipes(500);
  if (pending.length === 0) {
    return interaction.editReply('No pending recipes to approve.');
  }

  let approved = 0;
  for (const recipe of pending) {
    try {
      await firestore.updateRecipeStatus(recipe.id, 'approved', interaction.user.id, interaction.user.username);
      approved++;
    } catch (err) {
      console.error(`Failed to approve recipe ${recipe.id}:`, err.message);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('All Recipes Approved')
    .setColor(0x2ecc71)
    .setDescription(`**${approved}** recipe${approved !== 1 ? 's' : ''} approved and now live on the website.`)
    .addFields(
      { name: 'Approved By', value: interaction.user.username, inline: true },
      { name: 'Total Approved', value: `${approved}`, inline: true },
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// --- GRAB (single thread) ---

async function executeGrab(interaction) {
  const channel = interaction.channel;

  // Must be inside a thread
  if (!channel.isThread()) {
    return interaction.reply({
      content: 'This command must be used inside a **thread** or **forum post**.',
      ephemeral: true,
    });
  }

  const autoApprove = interaction.options.getBoolean('auto-approve') ?? false;

  await interaction.deferReply();

  // Pre-fetch existing for duplicate detection
  const allExisting = await firestore.getAllRecipes(1000);
  const existingUrls = new Set(allExisting.map(r => normalizeUrl(r.url)));
  const existingCodes = new Set(allExisting.map(r => r.referCode).filter(Boolean));

  // Scrape messages from this thread
  let allMessages = [];
  let lastId;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
    if (batch.size === 0) break;
    allMessages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // Also get starter message
  let starterMessage = null;
  try { starterMessage = await channel.fetchStarterMessage(); } catch {}
  if (starterMessage) allMessages.unshift(starterMessage);

  // Deduplicate by message ID
  const seen = new Set();
  allMessages = allMessages.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Extract all links from non-bot messages
  const recipes = [];
  const stats = { found: 0, new: 0, duplicate: 0 };

  for (const msg of allMessages) {
    if (msg.author.bot) continue;
    const urls = extractLinks(msg.content);
    stats.found += urls.length;

    for (const url of urls) {
      const referCode = getPokeCode(url);

      if (isDuplicateRecipe(url, referCode, existingUrls, existingCodes)) {
        stats.duplicate++;
        continue;
      }

      // Try to get a good title
      let title = channel.name || extractTitleFromMessage(msg.content, url);
      if (isPokeLink(url) && title === extractTitleFromUrl(url)) {
        const fetched = await fetchPageTitle(url);
        if (fetched) title = fetched;
      }

      const recipe = {
        url,
        title,
        description: cleanDescription(msg.content, url),
        referCode,
        sharedBy: [{ id: msg.author.id, name: msg.author.username, sharedAt: msg.createdAt.toISOString() }],
        channelId: channel.parentId || channel.id,
        channelName: channel.parent?.name || channel.name,
        guildId: interaction.guild.id,
        threadId: channel.id,
        messageId: msg.id,
        source: inferSource(url),
        tags: extractTags(msg.content),
        status: autoApprove ? 'approved' : 'pending',
      };

      if (autoApprove) {
        recipe.reviewedBy = interaction.user.username;
        recipe.reviewedById = interaction.user.id;
      }

      const saved = await firestore.saveRecipe(recipe);
      stats.new++;
      recipes.push({ ...recipe, id: saved.id });

      existingUrls.add(normalizeUrl(url));
      if (referCode) existingCodes.add(referCode);

      // Post approval embed if not auto-approving
      if (!autoApprove) {
        const approvalChannel = findApprovalChannel(interaction.guild);
        if (approvalChannel) {
          await postApprovalEmbed(approvalChannel, recipe, saved.id);
        }
      }
    }
  }

  if (stats.found === 0) {
    return interaction.editReply('No links found in this thread.');
  }

  const statusText = autoApprove ? 'live on the website' : 'sent for approval';
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://pokedex-recipes.vercel.app';

  const embed = new EmbedBuilder()
    .setTitle(autoApprove ? 'Recipes Published' : 'Recipes Submitted')
    .setColor(autoApprove ? 0x2ecc71 : 0xf0c840)
    .setDescription(`Found **${stats.found}** link${stats.found !== 1 ? 's' : ''} in this thread.`)
    .addFields(
      { name: autoApprove ? 'Published' : 'Pending Approval', value: `${stats.new}`, inline: true },
      { name: 'Duplicates', value: `${stats.duplicate}`, inline: true },
    )
    .setTimestamp();

  // Show what was found
  if (recipes.length > 0) {
    const lines = recipes.slice(0, 8).map(r => {
      const src = r.source ? ` \`${r.source}\`` : '';
      return `• [${(r.title || 'Untitled').slice(0, 50)}](${r.url})${src}`;
    });
    if (recipes.length > 8) lines.push(`_...and ${recipes.length - 8} more_`);
    embed.addFields({ name: `Recipes (${statusText})`, value: lines.join('\n').slice(0, 1024) });
  }

  if (autoApprove) {
    embed.addFields({ name: 'Recipe Page', value: `[View on website](${dashboardUrl})` });
  }

  return interaction.editReply({ embeds: [embed] });
}

// --- APPROVE (single recipe) ---

async function executeApprove(interaction) {
  const recipeId = interaction.options.getString('id').trim();

  await interaction.deferReply();

  const recipe = await firestore.getRecipeById(recipeId);
  if (!recipe) {
    return interaction.editReply(`Recipe \`${recipeId}\` not found.`);
  }

  if (recipe.status === 'approved') {
    return interaction.editReply(`Recipe \`${recipeId}\` is already approved.`);
  }

  await firestore.updateRecipeStatus(recipeId, 'approved', interaction.user.id, interaction.user.username);

  const embed = new EmbedBuilder()
    .setTitle('Recipe Approved')
    .setColor(0x2ecc71)
    .setDescription(`[${(recipe.title || 'Untitled').slice(0, 80)}](${recipe.url})`)
    .addFields(
      { name: 'Source', value: recipe.source || 'Unknown', inline: true },
      { name: 'Approved By', value: interaction.user.username, inline: true },
    )
    .setTimestamp();

  if (recipe.referCode) {
    embed.addFields({ name: 'Code', value: `\`${recipe.referCode}\``, inline: true });
  }

  return interaction.editReply({ embeds: [embed] });
}

// --- Autocomplete for recipe approve ---

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  try {
    const pending = await firestore.getPendingRecipes(50);
    const filtered = pending
      .filter(r =>
        r.id.toLowerCase().includes(focused) ||
        (r.title || '').toLowerCase().includes(focused) ||
        (r.url || '').toLowerCase().includes(focused) ||
        (r.referCode || '').toLowerCase().includes(focused)
      )
      .slice(0, 25)
      .map(r => ({
        name: `${(r.title || 'Untitled').slice(0, 60)} | ${r.source || '?'} | ${r.id.slice(0, 8)}…`,
        value: r.id,
      }));
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
}

// --- Approval embed with buttons ---

async function postApprovalEmbed(channel, recipe, recipeId) {
  const code = recipe.referCode ? `\nCode: \`${recipe.referCode}\`` : '';
  const tags = (recipe.tags || []).length > 0
    ? `\nTags: ${recipe.tags.map(t => `\`${t}\``).join(' ')}`
    : '';
  const sharer = recipe.sharedBy?.[0]?.name || 'unknown';

  const embed = new EmbedBuilder()
    .setTitle('New Recipe — Awaiting Approval')
    .setColor(0xf0c840)
    .setDescription(
      `**[${(recipe.title || 'Untitled Recipe').slice(0, 100)}](${recipe.url})**\n` +
      `Source: **${recipe.source || 'Unknown'}**${code}${tags}\n` +
      `Shared by: **${sharer}**`
    )
    .addFields(
      { name: 'URL', value: recipe.url.slice(0, 200) },
    )
    .setFooter({ text: `Recipe ID: ${recipeId}` })
    .setTimestamp();

  if (recipe.description) {
    embed.addFields({ name: 'Description', value: recipe.description.slice(0, 200) });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`recipe_approve_${recipeId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`recipe_decline_${recipeId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );

  try {
    await channel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Failed to post recipe approval embed:', err.message);
  }
}

/**
 * Handle recipe approval/decline button clicks.
 * Called from index.js button handler.
 */
async function handleRecipeButton(interaction) {
  const { customId } = interaction;
  const isApprove = customId.startsWith('recipe_approve_');
  const recipeId = customId.replace('recipe_approve_', '').replace('recipe_decline_', '');

  const recipe = await firestore.getRecipeById(recipeId);
  if (!recipe) {
    return interaction.reply({ content: 'Recipe not found.', ephemeral: true });
  }

  if (recipe.status !== 'pending') {
    return interaction.reply({ content: `This recipe has already been **${recipe.status}**.`, ephemeral: true });
  }

  const newStatus = isApprove ? 'approved' : 'declined';
  await firestore.updateRecipeStatus(recipeId, newStatus, interaction.user.id, interaction.user.username);

  // Update the embed
  const embed = EmbedBuilder.from(interaction.message.embeds[0]);

  if (isApprove) {
    embed.setTitle('✅ Recipe Approved');
    embed.setColor(0x2ecc71);
    embed.addFields({
      name: 'Approved By',
      value: `${interaction.user.username} — <t:${Math.floor(Date.now() / 1000)}:R>`,
    });
  } else {
    embed.setTitle('❌ Recipe Declined');
    embed.setColor(0xf43f5e);
    embed.addFields({
      name: 'Declined By',
      value: `${interaction.user.username} — <t:${Math.floor(Date.now() / 1000)}:R>`,
    });
  }

  // Disable buttons
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`recipe_approve_${recipeId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅')
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`recipe_decline_${recipeId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌')
      .setDisabled(true),
  );

  await interaction.update({ embeds: [embed], components: [disabledRow] });
}

// --- Helpers ---

function findApprovalChannel(guild) {
  const configName = getConfig('recipe_approval_channel') || 'recipe-approval';
  return guild.channels.cache.find(ch =>
    ch.isTextBased() && !ch.isThread() &&
    (ch.name === configName || ch.name.toLowerCase().includes(configName.toLowerCase()))
  );
}

async function scrapeThreadForRecipes(thread, forumChannel) {
  const links = [];
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
  try { starterMessage = await thread.fetchStarterMessage(); } catch {}
  if (starterMessage) allMessages.unshift(starterMessage);

  // Deduplicate messages by ID
  const seen = new Set();
  allMessages = allMessages.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Resolve forum tags
  const availableTags = forumChannel.availableTags || [];
  const forumTags = (thread.appliedTags || []).map(tagId => {
    const tag = availableTags.find(t => t.id === tagId);
    return tag?.name?.toLowerCase() || null;
  }).filter(Boolean);

  for (const msg of allMessages) {
    if (msg.author.bot) continue;
    const urls = extractLinks(msg.content);
    for (const url of urls) {
      // Try to scrape page title for poke.com links
      let title = thread.name || extractTitleFromMessage(msg.content, url);
      if (isPokeLink(url) && title === extractTitleFromUrl(url)) {
        const fetched = await fetchPageTitle(url);
        if (fetched) title = fetched;
      }

      links.push({
        url,
        title,
        description: cleanDescription(msg.content, url),
        referCode: getPokeCode(url),
        sharedBy: [{ id: msg.author.id, name: msg.author.username, sharedAt: msg.createdAt.toISOString() }],
        channelId: forumChannel.id,
        channelName: forumChannel.name,
        guildId: thread.guild.id,
        threadId: thread.id,
        messageId: msg.id,
        source: inferSource(url),
        tags: [...new Set([...forumTags, ...extractTags(msg.content)])],
      });
    }
  }

  return { links };
}

function extractLinks(text) {
  if (!text) return [];
  // Use a new regex with g flag for matchAll (URL_REGEX is g-free for .test() usage)
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return [...new Set(matches.map(u => u.replace(/[.,;:!?)]+$/, '')))];
}

function extractTitleFromMessage(text, url) {
  if (!text) return extractTitleFromUrl(url);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const firstLine = lines[0] || '';
  const cleaned = firstLine.replace(/https?:\/\/[^\s<>"')\]]+/gi, '').replace(/[<>[\]()]/g, '').trim();
  return cleaned.length > 5 ? cleaned.slice(0, 120) : extractTitleFromUrl(url);
}

function extractTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    const pathname = u.pathname;

    // Poke.com links — extract the code from the path
    if (hostname.includes('poke.com')) {
      const parts = pathname.split('/').filter(Boolean);
      const code = parts[parts.length - 1];
      if (code) return `Poke Recipe ${code}`;
      return 'Poke Recipe';
    }

    const parts = pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      const last = parts[parts.length - 1];
      return decodeURIComponent(last)
        .replace(/[-_]/g, ' ')
        .replace(/\.\w+$/, '')
        .slice(0, 80) || u.hostname;
    }
    return u.hostname;
  } catch {
    return 'Untitled Recipe';
  }
}

/**
 * Fetch the <title> tag from a URL for better recipe names.
 */
async function fetchPageTitle(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Pokedex-Bot/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match && match[1]) {
      const title = match[1].trim()
        .replace(/\s+/g, ' ')
        .replace(/\|.*$/, '')  // Remove "| Site Name" suffixes
        .replace(/-\s*$/, '')
        .trim();
      return title.length > 3 ? title.slice(0, 150) : null;
    }
    return null;
  } catch {
    return null;
  }
}

function cleanDescription(text, url) {
  if (!text) return null;
  const cleaned = text.replace(/https?:\/\/[^\s<>"')\]]+/gi, '').replace(/[<>[\]()]/g, '').trim();
  return cleaned.length > 10 ? cleaned.slice(0, 300) : null;
}

function isPokeLink(url) {
  try {
    return new URL(url).hostname.toLowerCase().includes('poke.com');
  } catch {
    return false;
  }
}

function getPokeCode(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().includes('poke.com')) return null;
    // Extract the last path segment as the code (works for /r/, /refer/, /recipe/, etc.)
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  } catch {
    return null;
  }
}

function inferSource(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('poke.com')) return 'Poke';
    if (hostname.includes('pokepast')) return 'Pokepaste';
    if (hostname.includes('pokemonshowdown')) return 'Showdown';
    if (hostname.includes('pastebin')) return 'Pastebin';
    if (hostname.includes('paste.pokemon-online')) return 'PO Paste';
    if (hostname.includes('github')) return 'GitHub';
    if (hostname.includes('docs.google')) return 'Google Docs';
    if (hostname.includes('youtube') || hostname.includes('youtu.be')) return 'YouTube';
    if (hostname.includes('reddit')) return 'Reddit';
    if (hostname.includes('smogon')) return 'Smogon';
    if (hostname.includes('marriland')) return 'Marriland';
    if (hostname.includes('serebii')) return 'Serebii';
    if (hostname.includes('bulbapedia')) return 'Bulbapedia';
    if (hostname.includes('pikalytics')) return 'Pikalytics';
    if (hostname.includes('limitlessv')) return 'Limitless';
    if (hostname.includes('victoryroad')) return 'Victory Road';
    return hostname.replace('www.', '').split('.')[0];
  } catch {
    return 'Unknown';
  }
}

function extractTags(text) {
  if (!text) return [];
  const tags = [];
  const lower = text.toLowerCase();

  const tagKeywords = {
    'ou': 'ou', 'uu': 'uu', 'uber': 'ubers', 'ubers': 'ubers', 'ru': 'ru', 'nu': 'nu', 'pu': 'pu',
    'vgc': 'vgc', 'doubles': 'doubles', 'singles': 'singles', 'monotype': 'monotype',
    'rain': 'rain team', 'sun': 'sun team', 'sand': 'sand team', 'hail': 'hail team', 'snow': 'snow team',
    'trick room': 'trick room', 'hyper offense': 'hyper offense', 'stall': 'stall', 'balance': 'balance',
    'competitive': 'competitive', 'casual': 'casual', 'showdown': 'showdown',
    'gen 9': 'gen 9', 'gen 8': 'gen 8', 'gen 7': 'gen 7', 'scarlet': 'gen 9', 'violet': 'gen 9',
    'regulation': 'regulation', 'reg g': 'reg g', 'reg h': 'reg h', 'reg f': 'reg f',
  };

  for (const [keyword, tag] of Object.entries(tagKeywords)) {
    if (lower.includes(keyword)) tags.push(tag);
  }

  return [...new Set(tags)];
}

async function fetchChannelMessages(channel, limit) {
  const allMessages = [];
  let lastId;
  let remaining = limit;

  while (remaining > 0) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, remaining), ...(lastId && { before: lastId }) });
    if (batch.size === 0) break;
    allMessages.push(...batch.values());
    lastId = batch.last().id;
    remaining -= batch.size;
    if (batch.size < 100) break;
  }

  return allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function buildProgressBar(pct) {
  const filled = Math.round(pct / 5);
  const empty = 20 - filled;
  return '`' + '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + '`';
}

/**
 * Normalize a URL for duplicate comparison.
 * Strips trailing slashes, tracking params, fragments, and lowercases.
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove common tracking params
    const stripParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref', 'fbclid', 'gclid'];
    for (const p of stripParams) u.searchParams.delete(p);
    // Normalize
    let normalized = `${u.protocol}//${u.hostname}${u.pathname}`.toLowerCase();
    // Strip trailing slash
    normalized = normalized.replace(/\/+$/, '');
    // Keep meaningful query params
    const qs = u.searchParams.toString();
    if (qs) normalized += `?${qs}`;
    return normalized;
  } catch {
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Check if a recipe is a duplicate by normalized URL or refer code.
 */
function isDuplicateRecipe(url, referCode, existingUrls, existingCodes) {
  // Check normalized URL
  if (existingUrls.has(normalizeUrl(url))) return true;
  // Check refer code (catches /r/X vs /refer/X for same recipe)
  if (referCode && existingCodes.has(referCode)) return true;
  return false;
}

module.exports = { data: commandData, execute, handleRecipeButton, autocomplete };
