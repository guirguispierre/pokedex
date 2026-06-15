const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const commandData = new SlashCommandBuilder()
  .setName('deletethread')
  .setDescription('Delete a thread from the server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
  .addChannelOption(opt =>
    opt.setName('thread')
      .setDescription('The thread to delete (default: current thread)')
      .setRequired(false))
  .addStringOption(opt =>
    opt.setName('reason')
      .setDescription('Reason for deleting the thread')
      .setRequired(false));

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getChannel('thread') || interaction.channel;
  const reason = interaction.options.getString('reason') || 'No reason provided';

  if (!target.isThread()) {
    return interaction.editReply('That channel is not a thread. Please select a thread to delete.');
  }

  const threadName = target.name;

  try {
    // If we're inside the thread being deleted, reply first then delete
    if (target.id === interaction.channel.id) {
      await interaction.editReply(`Deleting thread **${threadName}**...`);
      await target.delete(reason);
    } else {
      await target.delete(reason);

      const embed = new EmbedBuilder()
        .setTitle('🗑️ Thread Deleted')
        .setColor(0xe74c3c)
        .addFields(
          { name: 'Thread', value: threadName, inline: true },
          { name: 'Deleted By', value: interaction.user.username, inline: true },
          { name: 'Reason', value: reason },
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Failed to delete thread:', err);
    await interaction.editReply(`Failed to delete thread: ${err.message}`);
  }
}

module.exports = { data: commandData, execute };
