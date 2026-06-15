const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const firestore = require('../services/firestore');

const commandData = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('See top bug reporters and most active contributors')
  .addStringOption(opt =>
    opt.setName('type')
      .setDescription('Leaderboard type')
      .setRequired(false)
      .addChoices(
        { name: 'Top Reporters', value: 'reporters' },
        { name: 'Most Critical Finds', value: 'critical' },
        { name: 'All Stats', value: 'all' },
      ))
  .addStringOption(opt =>
    opt.setName('visibility')
      .setDescription('Who can see the response')
      .setRequired(false)
      .addChoices(
        { name: 'Only me', value: 'ephemeral' },
        { name: 'Everyone', value: 'public' },
      ));

async function execute(interaction) {
  const type = interaction.options.getString('type') || 'all';
  const visibility = interaction.options.getString('visibility') || 'public';
  const ephemeral = visibility === 'ephemeral';

  await interaction.deferReply({ ephemeral });

  try {
    const issues = await firestore.getAllIssues();

    if (issues.length === 0) {
      return interaction.editReply('No issues reported yet. Be the first!');
    }

    const embeds = [];

    if (type === 'reporters' || type === 'all') {
      embeds.push(buildReporterLeaderboard(issues));
    }

    if (type === 'critical' || type === 'all') {
      embeds.push(buildCriticalLeaderboard(issues));
    }

    if (type === 'all') {
      embeds.push(buildStatsEmbed(issues));
    }

    await interaction.editReply({ embeds });
  } catch (err) {
    console.error('Leaderboard error:', err);
    await interaction.editReply('Failed to load leaderboard.');
  }
}

function buildReporterLeaderboard(issues) {
  const counts = {};
  for (const issue of issues) {
    const name = issue.reporterName || 'unknown';
    counts[name] = (counts[name] || 0) + 1;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const medals = ['🥇', '🥈', '🥉'];

  const lines = sorted.map(([name, count], i) => {
    const medal = medals[i] || `**${i + 1}.**`;
    return `${medal} **${name}** — ${count} issue${count > 1 ? 's' : ''}`;
  });

  return new EmbedBuilder()
    .setTitle('🏆 Top Bug Reporters')
    .setColor(0xffd700)
    .setDescription(lines.join('\n') || 'No reporters yet.')
    .setFooter({ text: `Total issues: ${issues.length}` })
    .setTimestamp();
}

function buildCriticalLeaderboard(issues) {
  const criticalIssues = issues.filter(i => i.priority === 'critical' || i.priority === 'high');
  const counts = {};
  for (const issue of criticalIssues) {
    const name = issue.reporterName || 'unknown';
    counts[name] = (counts[name] || 0) + 1;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const lines = sorted.map(([name, count], i) => {
    return `**${i + 1}.** 🔥 **${name}** — ${count} critical/high find${count > 1 ? 's' : ''}`;
  });

  return new EmbedBuilder()
    .setTitle('🔥 Most Critical Finds')
    .setColor(0xff0000)
    .setDescription(lines.join('\n') || 'No critical/high issues found yet.')
    .setFooter({ text: `Total critical/high: ${criticalIssues.length}` })
    .setTimestamp();
}

function buildStatsEmbed(issues) {
  const open = issues.filter(i => i.status === 'open').length;
  const closed = issues.filter(i => i.status !== 'open').length;
  const priorities = { critical: 0, high: 0, medium: 0, low: 0 };
  const categories = {};

  for (const issue of issues) {
    if (priorities[issue.priority] !== undefined) priorities[issue.priority]++;
    const cat = issue.category || 'other';
    categories[cat] = (categories[cat] || 0) + 1;
  }

  const catLines = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(' | ');

  return new EmbedBuilder()
    .setTitle('📊 Issue Stats')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Open', value: `${open}`, inline: true },
      { name: 'Closed', value: `${closed}`, inline: true },
      { name: 'Total', value: `${issues.length}`, inline: true },
      { name: 'By Priority', value: `🔴 ${priorities.critical} critical | 🟠 ${priorities.high} high | 🟡 ${priorities.medium} medium | 🟢 ${priorities.low} low` },
      { name: 'By Category', value: catLines || 'None' },
    )
    .setTimestamp();
}

module.exports = { data: commandData, execute };
