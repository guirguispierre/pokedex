const { SlashCommandBuilder } = require('discord.js');
const firestore = require('../services/firestore');
const { postIssueEmbed } = require('../services/triage');

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

  const issueData = {
    text: description,
    reporterId: interaction.user.id,
    reporterName: interaction.user.username,
    guildId: interaction.guildId,
    channelId: null,
    messageId: null,
    priority,
    category,
    summary: title,
    reasoning: 'Reported via /pokedexbug slash command',
    source: 'pokedexbug',
    attachments,
  };

  let issueId;
  try {
    issueId = await firestore.saveIssue(issueData);
  } catch (err) {
    console.error('pokedexbug: failed to save issue', err);
    return interaction.editReply('Failed to save your bug report. Please try again in a moment.');
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
