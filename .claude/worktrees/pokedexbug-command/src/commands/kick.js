const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

const commandData = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a user from the server')
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
  .addUserOption(opt => opt.setName('user').setDescription('User to kick').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for kick').setRequired(false));

async function execute(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!member) {
    return interaction.editReply('Could not find that member in the server.');
  }

  if (!member.kickable) {
    return interaction.editReply('I cannot kick this user. They may have higher permissions than me.');
  }

  // Try to DM the user BEFORE kicking
  try {
    const dmEmbed = new EmbedBuilder()
      .setTitle(`👢 You have been kicked from ${interaction.guild.name}`)
      .setColor(0xe74c3c)
      .addFields({ name: 'Reason', value: reason })
      .setTimestamp();
    await target.send({ embeds: [dmEmbed] });
  } catch {
    // Can't DM user
  }

  try {
    await member.kick(reason);
  } catch (err) {
    console.error('Failed to kick:', err);
    return interaction.editReply('Failed to kick this user. Please check bot permissions and try again.');
  }

  // Log infraction
  const db = getDb();
  await db.collection('infractions').add({
    type: 'kick',
    userId: target.id,
    username: target.username,
    guildId: interaction.guild.id,
    reason,
    moderatorId: interaction.user.id,
    moderatorName: interaction.user.username,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const embed = new EmbedBuilder()
    .setTitle('👢 User Kicked')
    .setColor(0xe74c3c)
    .addFields(
      { name: 'User', value: `${target.username} (${target.id})`, inline: true },
      { name: 'Moderator', value: `${interaction.user}`, inline: true },
      { name: 'Reason', value: reason },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data: commandData, execute };
