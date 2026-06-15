const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const commandData = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Bulk delete messages from a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption(opt =>
    opt.setName('amount')
      .setDescription('Number of messages to delete (1-100)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100))
  .addUserOption(opt =>
    opt.setName('user')
      .setDescription('Only delete messages from this user')
      .setRequired(false));

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const amount = interaction.options.getInteger('amount');
  const targetUser = interaction.options.getUser('user');

  const channel = interaction.channel;

  try {
    let messages;
    if (targetUser) {
      // Fetch more messages to filter, then bulk-delete the filtered set
      const fetched = await channel.messages.fetch({ limit: 100 });
      const filtered = fetched
        .filter(m => m.author.id === targetUser.id)
        .first(amount);

      if (filtered.length === 0) {
        return interaction.editReply(`No recent messages found from ${targetUser.username}.`);
      }

      messages = await channel.bulkDelete(filtered, true);
    } else {
      messages = await channel.bulkDelete(amount, true);
    }

    const embed = new EmbedBuilder()
      .setTitle('🧹 Messages Purged')
      .setColor(0x2ecc71)
      .setDescription(`Deleted **${messages.size}** message(s)${targetUser ? ` from ${targetUser.username}` : ''}.`)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    if (err.code === 50034) {
      return interaction.editReply('Cannot delete messages older than 14 days.');
    }
    console.error('Failed to purge:', err);
    return interaction.editReply('Failed to purge messages. Please check bot permissions and try again.');
  }
}

module.exports = { data: commandData, execute };
