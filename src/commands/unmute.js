const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function getDb() {
  return getFirestore();
}

const commandData = new SlashCommandBuilder()
  .setName('unmute')
  .setDescription('Remove a user\'s mute (clear their timeout)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(opt => opt.setName('user').setDescription('User to unmute').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for unmuting').setRequired(false));

async function execute(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!member) return interaction.editReply('Could not find that member in the server.');
  if (!member.moderatable) return interaction.editReply('I cannot unmute this user. They may have higher permissions than me.');

  const wasMuted = member.isCommunicationDisabled();

  try {
    await member.timeout(null, reason);
  } catch (err) {
    console.error('Failed to unmute:', err);
    return interaction.editReply('Failed to unmute this user. Please check bot permissions and try again.');
  }

  // The unmute already applied; a failed log shouldn't be reported as a failed unmute.
  try {
    await getDb().collection('infractions').add({
      type: 'unmute',
      userId: target.id,
      username: target.username,
      guildId: interaction.guild.id,
      reason,
      moderatorId: interaction.user.id,
      moderatorName: interaction.user.username,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('Failed to log unmute infraction:', err);
  }

  const embed = new EmbedBuilder()
    .setTitle('🔊 User Unmuted')
    .setColor(0x00cc00)
    .addFields(
      { name: 'User', value: `${target} (${target.username})`, inline: true },
      { name: 'Moderator', value: `${interaction.user}`, inline: true },
      { name: 'Reason', value: reason },
    )
    .setTimestamp();

  if (!wasMuted) {
    embed.setDescription('_Note: this user was not currently muted._');
  }

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data: commandData, execute };
