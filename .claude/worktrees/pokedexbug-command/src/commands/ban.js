const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

const commandData = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a user from the server')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption(opt => opt.setName('user').setDescription('User to ban').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for ban').setRequired(false))
  .addIntegerOption(opt =>
    opt.setName('delete_days')
      .setDescription('Days of messages to delete (0-7)')
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(7));

async function execute(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason provided';
  const deleteDays = interaction.options.getInteger('delete_days') || 0;

  const member = await interaction.guild.members.fetch(target.id).catch(() => null);

  if (member && !member.bannable) {
    return interaction.editReply('I cannot ban this user. They may have higher permissions than me.');
  }

  // Try to DM the user BEFORE banning
  try {
    const dmEmbed = new EmbedBuilder()
      .setTitle(`🔨 You have been banned from ${interaction.guild.name}`)
      .setColor(0xff0000)
      .addFields({ name: 'Reason', value: reason })
      .setTimestamp();
    await target.send({ embeds: [dmEmbed] });
  } catch {
    // Can't DM user
  }

  try {
    await interaction.guild.members.ban(target.id, {
      reason,
      deleteMessageSeconds: deleteDays * 86400,
    });
  } catch (err) {
    console.error('Failed to ban:', err);
    return interaction.editReply('Failed to ban this user. Please check bot permissions and try again.');
  }

  // Log infraction
  const db = getDb();
  await db.collection('infractions').add({
    type: 'ban',
    userId: target.id,
    username: target.username,
    guildId: interaction.guild.id,
    reason,
    deleteDays,
    moderatorId: interaction.user.id,
    moderatorName: interaction.user.username,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const embed = new EmbedBuilder()
    .setTitle('🔨 User Banned')
    .setColor(0xff0000)
    .addFields(
      { name: 'User', value: `${target.username} (${target.id})`, inline: true },
      { name: 'Moderator', value: `${interaction.user}`, inline: true },
      { name: 'Reason', value: reason },
      { name: 'Messages Deleted', value: `${deleteDays} day(s)`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data: commandData, execute };
