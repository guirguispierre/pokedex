const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const commandData = new SlashCommandBuilder()
  .setName('lock')
  .setDescription('Lock a channel — prevents members from sending messages')
  .addChannelOption(opt =>
    opt.setName('channel')
      .setDescription('Channel to lock (default: current channel)')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false))
  .addStringOption(opt =>
    opt.setName('reason')
      .setDescription('Reason for locking')
      .setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

async function execute(interaction) {
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const reason = interaction.options.getString('reason') || 'No reason provided';

  try {
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      SendMessages: false,
    });

    const embed = new EmbedBuilder()
      .setTitle('🔒 Channel Locked')
      .setColor(0xff0000)
      .setDescription(`**${channel}** has been locked.`)
      .addFields(
        { name: 'Locked By', value: interaction.user.username, inline: true },
        { name: 'Reason', value: reason, inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // Also post a notice in the locked channel if it's different
    if (channel.id !== interaction.channel.id) {
      const notice = new EmbedBuilder()
        .setTitle('🔒 This channel has been locked')
        .setColor(0xff0000)
        .setDescription(`Locked by ${interaction.user.username}\n**Reason:** ${reason}`)
        .setTimestamp();
      await channel.send({ embeds: [notice] });
    }
  } catch (err) {
    console.error('Failed to lock channel:', err);
    await interaction.reply({ content: 'Failed to lock the channel. Make sure I have Manage Channels permission.', ephemeral: true });
  }
}

module.exports = { data: commandData, execute };
