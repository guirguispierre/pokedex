const { ChannelType } = require('discord.js');
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
    added++;

    // Track for subsequent URLs in this same message
    existingUrls.add(normalizeUrl(url));
    if (referCode) existingCodes.add(referCode);

    // Post approval embed if not auto-approving
    if (!autoApprove && approvalChannel) {
      await postApprovalEmbed(approvalChannel, recipe, saved.id);
    }
  }

  if (added > 0) {
    console.log(`Auto-scrape: added ${added} recipe(s) from #${thread.parent.name} post "${thread.name}"`);
  }
}

module.exports = { handleAutoScrape };
