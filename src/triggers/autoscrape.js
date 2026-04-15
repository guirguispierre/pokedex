const { ChannelType, EmbedBuilder } = require('discord.js');
const { getConfig } = require('../config/config');
const firestore = require('../services/firestore');
const {
  extractLinks, normalizeUrl, inferSource, extractTags,
  extractTitleFromMessage, fetchPageTitle, isPokeLink, extractTitleFromUrl,
  cleanDescription, getPokeCode, isDuplicateRecipe, findApprovalChannel,
  postApprovalEmbed,
} = require('../commands/recipes');

const STARTER_MSG_RETRIES = 3;
const STARTER_MSG_DELAY_MS = 2000;

async function handleAutoScrape(thread) {
  // Check if autoscrape is enabled
  const enabled = getConfig('autoscrape_recipes_enabled');
  if (!enabled) return;

  // Only handle forum channel threads
  if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) return;

  // Check if this is a show-and-tell forum
  const parentName = thread.parent.name.toLowerCase();
  if (!parentName.includes('show-and-tell')) return;

  // Join the thread so the bot can send messages
  try {
    await thread.join();
  } catch (err) {
    console.error('Auto-scrape: failed to join thread:', err.message);
    return;
  }

  // Fetch starter message with retries (same pattern as forum.js)
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
    return;
  }

  const text = starterMessage.content.trim();
  const urls = extractLinks(text);
  if (urls.length === 0) return;

  const autoApprove = getConfig('autoscrape_recipes_auto_approve') || false;

  // Pre-fetch existing recipes for duplicate detection
  const allExisting = await firestore.getAllRecipes(1000);
  const existingUrls = new Set(allExisting.map(r => normalizeUrl(r.url)));
  const existingCodes = new Set(allExisting.map(r => r.referCode).filter(Boolean));

  // Find approval channel (only needed if not auto-approving)
  let approvalChannel = null;
  if (!autoApprove) {
    approvalChannel = findApprovalChannel(thread.guild);
    if (!approvalChannel) {
      console.warn('Auto-scrape: no approval channel found, recipes will be saved as pending without approval embed');
    }
  }

  // Resolve the poster's name
  let posterName = 'unknown';
  try {
    const member = await thread.guild.members.fetch(thread.ownerId);
    posterName = member.user.username;
  } catch {
    posterName = starterMessage.author?.username || 'unknown';
  }

  // Resolve forum tags
  const availableTags = thread.parent.availableTags || [];
  const forumTags = (thread.appliedTags || []).map(tagId => {
    const tag = availableTags.find(t => t.id === tagId);
    return tag?.name?.toLowerCase() || null;
  }).filter(Boolean);

  let added = 0;
  const addedRecipes = [];

  for (const url of urls) {
    const referCode = getPokeCode(url);

    // Skip duplicates
    if (isDuplicateRecipe(url, referCode, existingUrls, existingCodes)) {
      continue;
    }

    // Build title
    let title = thread.name || extractTitleFromMessage(text, url);
    if (isPokeLink(url) && title === extractTitleFromUrl(url)) {
      const fetched = await fetchPageTitle(url);
      if (fetched) title = fetched;
    }

    const recipe = {
      url,
      title,
      description: cleanDescription(text, url),
      referCode,
      sharedBy: [{ id: thread.ownerId, name: posterName, sharedAt: new Date().toISOString() }],
      channelId: thread.parentId,
      channelName: thread.parent.name,
      guildId: thread.guild.id,
      threadId: thread.id,
      messageId: starterMessage.id,
      source: inferSource(url),
      tags: [...new Set([...forumTags, ...extractTags(text)])],
      status: autoApprove ? 'approved' : 'pending',
    };

    if (autoApprove) {
      recipe.reviewedBy = 'Auto-Scrape';
      recipe.reviewedById = null;
    }

    const saved = await firestore.saveRecipe(recipe);

    // Only count genuinely new recipes (not duplicates caught by Firestore)
    if (!saved.updated) {
      added++;
      addedRecipes.push(recipe);
    }

    // Track for subsequent URLs in this same message
    existingUrls.add(normalizeUrl(url));
    if (referCode) existingCodes.add(referCode);

    // Post approval embed if not auto-approving (only for new recipes)
    if (!autoApprove && approvalChannel && !saved.updated) {
      await postApprovalEmbed(approvalChannel, recipe, saved.id);
    }
  }

  const skipped = urls.length - added;
  if (added > 0) {
    console.log(`Auto-scrape: added ${added} recipe(s), skipped ${skipped} duplicate(s) from #${thread.parent.name} post "${thread.name}"`);

    // Notify the user in the thread
    const statusText = autoApprove
      ? 'automatically added to the recipe collection'
      : 'submitted for approval';

    const recipeLines = addedRecipes.slice(0, 5).map(r => {
      const src = r.source ? ` \`${r.source}\`` : '';
      return `- [${(r.title || 'Untitled').slice(0, 60)}](${r.url})${src}`;
    });
    if (addedRecipes.length > 5) {
      recipeLines.push(`_...and ${addedRecipes.length - 5} more_`);
    }

    const description = (
      `Found **${added}** recipe link${added !== 1 ? 's' : ''} in your post — ${statusText}.\n\n` +
      recipeLines.join('\n')
    ).slice(0, 4096);

    const embed = new EmbedBuilder()
      .setColor(autoApprove ? 0x2ecc71 : 0xf0c840)
      .setTitle(autoApprove ? 'Recipes Added' : 'Recipes Submitted for Approval')
      .setDescription(description)
      .setFooter({ text: autoApprove ? 'Live on the recipe page now' : 'A moderator will review shortly' })
      .setTimestamp();

    try {
      await thread.send({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('Auto-scrape: failed to send notification in thread:', err.message);
    }
  } else if (skipped > 0) {
    console.log(`Auto-scrape: all ${skipped} link(s) were duplicates from #${thread.parent.name} post "${thread.name}"`);
  }
}

module.exports = { handleAutoScrape };
