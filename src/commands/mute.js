const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

const DURATIONS = {
  '60s': 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '14d': 14 * 24 * 60 * 60_000,
  '28d': 28 * 24 * 60 * 60_000,
};

const commandData = new SlashCommandBuilder()
  .setName('mute')
  .setDescription('Mute a user for a set time (Discord timeout)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(opt => opt.setName('user').setDescription('User to mute').setRequired(true))
  .addStringOption(opt =>
    opt.setName('duration').setDescription('How long').setRequired(true)
      .addChoices(
        { name: '60 seconds', value: '60s' },
        { name: '5 minutes', value: '5m' },
        { name: '10 minutes', value: '10m' },
        { name: '30 minutes', value: '30m' },
        { name: '1 hour', value: '1h' },
        { name: '6 hours', value: '6h' },
        { name: '12 hours', value: '12h' },
        { name: '1 day', value: '1d' },
        { name: '3 days', value: '3d' },
        { name: '7 days', value: '7d' },
        { name: '14 days', value: '14d' },
        { name: '28 days', value: '28d' },
      ))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for mute').setRequired(false));

// Reusable Discord-timeout path (also used by the scam scanner). Returns false
// without calling timeout when the member is missing or not moderatable.
async function applyTimeout(member, durationMs, reason) {
  if (!member || !member.moderatable) return false;
  await member.timeout(durationMs, reason);
  return true;
}

async function execute(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user');
  const durationKey = interaction.options.getString('duration');
  const reason = interaction.options.getString('reason') || 'No reason provided';
  const durationMs = DURATIONS[durationKey];

  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!member) return interaction.editReply('Could not find that member in the server.');
  if (!member.moderatable) return interaction.editReply('I cannot mute this user. They may have higher permissions than me.');

  try {
    await applyTimeout(member, durationMs, reason);
  } catch (err) {
    console.error('Failed to mute:', err);
    return interaction.editReply('Failed to mute this user. Please check bot permissions and try again.');
  }

  // The mute already applied; a failed log shouldn't be reported as a failed mute.
  try {
    await getDb().collection('infractions').add({
      type: 'mute',
      userId: target.id,
      username: target.username,
      guildId: interaction.guild.id,
      reason,
      duration: durationKey,
      moderatorId: interaction.user.id,
      moderatorName: interaction.user.username,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('Failed to log mute infraction:', err);
  }

  const embed = new EmbedBuilder()
    .setTitle('🔇 User Muted')
    .setColor(0xe67e22)
    .addFields(
      { name: 'User', value: `${target} (${target.username})`, inline: true },
      { name: 'Duration', value: durationKey, inline: true },
      { name: 'Moderator', value: `${interaction.user}`, inline: true },
      { name: 'Reason', value: reason },
    )
    .setTimestamp();

  try {
    await target.send({ embeds: [new EmbedBuilder()
      .setTitle(`🔇 You have been muted in ${interaction.guild.name}`)
      .setColor(0xe67e22)
      .addFields({ name: 'Duration', value: durationKey }, { name: 'Reason', value: reason })
      .setTimestamp()] });
  } catch {
    // Can't DM user
  }

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data: commandData, execute, applyTimeout };
