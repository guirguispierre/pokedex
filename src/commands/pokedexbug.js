const { SlashCommandBuilder } = require('discord.js');
const firestore = require('../services/firestore');
const { postIssueEmbed } = require('../services/triage');
const agentTriage = require('../services/agentTriage');
const { getConfig, getOwnerId } = require('../config/config');
const capabilityGap = require('../services/capabilityGap');

const PRIORITY_CHOICES = [
  { name: 'Critical — data loss or security', value: 'critical' },
  { name: 'High — core feature broken', value: 'high' },
  { name: 'Medium — workaround exists', value: 'medium' },
  { name: 'Low — minor or cosmetic', value: 'low' },
];

const CATEGORY_CHOICES = [
  { name: 'Bug', value: 'bug' },
  { name: 'Performance', value: 'performance' },
  { name: 'Security', value: 'security' },
  { name: 'UX issue', value: 'ux_issue' },
  { name: 'Infrastructure', value: 'infrastructure' },
  { name: 'Other', value: 'other' },
];

const commandData = new SlashCommandBuilder()
  .setName('pokedexbug')
  .setDescription('Report a bug with Pokedex — sent to the engineering triage channel')
  .addStringOption(opt =>
    opt.setName('title')
      .setDescription('Short summary of the bug (1-2 sentences)')
      .setRequired(true)
      .setMaxLength(200))
  .addStringOption(opt =>
    opt.setName('description')
      .setDescription('What happened, what you expected, steps to reproduce')
      .setRequired(true)
      .setMaxLength(2000))
  .addStringOption(opt =>
    opt.setName('priority')
      .setDescription('Severity — defaults to medium')
      .setRequired(false)
      .addChoices(...PRIORITY_CHOICES))
  .addStringOption(opt =>
    opt.setName('category')
      .setDescription('Category — defaults to bug')
      .setRequired(false)
      .addChoices(...CATEGORY_CHOICES))
  .addAttachmentOption(opt =>
    opt.setName('screenshot')
      .setDescription('Optional screenshot of the issue')
      .setRequired(false));

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const title = interaction.options.getString('title').trim();
  const description = interaction.options.getString('description').trim();
  const priority = interaction.options.getString('priority') || 'medium';
  const category = interaction.options.getString('category') || 'bug';
  const screenshot = interaction.options.getAttachment('screenshot');

  const attachments = [];
  if (screenshot) {
    attachments.push({
      url: screenshot.url,
      name: screenshot.name,
      contentType: screenshot.contentType,
      size: screenshot.size,
      isImage: (screenshot.contentType || '').startsWith('image/'),
    });
  }

  const imageUrls = screenshot && (screenshot.contentType || '').startsWith('image/') ? [screenshot.url] : [];

  let classification = null;
  if (getConfig('agent_enabled') !== false) {
    try {
      classification = await agentTriage.triageIssue({
        text: `${title}\n\n${description}`,
        images: imageUrls,
        ctx: {
          firestore,
          guild: interaction.guild,
          channelId: interaction.channelId,
          reporterId: interaction.user.id,
          reporterName: interaction.user.username,
        },
      });
    } catch (err) {
      console.error('pokedexbug: agent triage failed, using user-provided values', err.message);
    }
  }

  // User picked priority/category overrides everything EXCEPT target — force pokedex_bot.
  const effectivePriority = priority; // from user selection
  const effectiveCategory = category; // from user selection
  const effectiveSummary = (classification?.summary && classification.summary.length > 0) ? classification.summary : title;
  const effectiveReasoning = classification?.reasoning || 'Reported via /pokedexbug slash command';
  const evidence = classification?.evidence || null;
  const capabilityGapPayload = classification?.capability_gap || null;
  const agentMeta = classification?.agentMeta || null;

  const issueData = {
    text: description,
    reporterId: interaction.user.id,
    reporterName: interaction.user.username,
    guildId: interaction.guildId,
    channelId: null,
    messageId: null,
    priority: effectivePriority,
    category: effectiveCategory,
    summary: effectiveSummary,
    reasoning: effectiveReasoning,
    source: 'pokedexbug',
    attachments,
    target: 'pokedex_bot',
    evidence,
    agentMeta,
    lastEvaluatedAt: new Date().toISOString(),
  };

  let issueId;
  try {
    issueId = await firestore.saveIssue(issueData);
  } catch (err) {
    console.error('pokedexbug: failed to save issue', err);
    return interaction.editReply('Failed to save your bug report. Please try again in a moment.');
  }

  if (capabilityGapPayload && issueId) {
    try {
      await capabilityGap.record({
        gap: capabilityGapPayload,
        issueId,
        guild: interaction.guild,
        firestore,
        ownerId: getOwnerId(),
        channelName: getConfig('pokedex_self_channel') || 'pokedex-testing',
      });
    } catch (err) {
      console.error('pokedexbug: capability gap record failed', err.message);
    }
  }

  try {
    await postIssueEmbed(interaction.guild, { ...issueData, id: issueId }, issueId);
  } catch (err) {
    console.error('pokedexbug: failed to post triage embed', err);
  }

  await interaction.editReply(
    `Thanks — bug report saved as \`${issueId}\` and sent to engineering triage.`
  );
}

module.exports = { data: commandData, execute };
