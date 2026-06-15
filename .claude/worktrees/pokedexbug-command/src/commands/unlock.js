const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const commandData = new SlashCommandBuilder()
  .setName('unlock')
  .setDescription('Unlock a channel — allows members to send messages again')
  .addChannelOption(opt =>
    opt.setName('channel')
      .setDescription('Channel to unlock (default: current channel)')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

async function execute(interaction) {
  const channel = interaction.options.getChannel('channel') || interaction.channel;

  try {
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      SendMessages: null, // Reset to default (inherit from category)
    });

    const embed = new EmbedBuilder()
      .setTitle('🔓 Channel Unlocked')
      .setColor(0x00cc00)
      .setDescription(`**${channel}** has been unlocked.`)
      .addFields(
        { name: 'Unlocked By', value: interaction.user.username, inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    if (channel.id !== interaction.channel.id) {
      const notice = new EmbedBuilder()
        .setTitle('🔓 This channel has been unlocked')
        .setColor(0x00cc00)
        .setDescription(`Unlocked by ${interaction.user.username}`)
        .setTimestamp();
      await channel.send({ embeds: [notice] });
    }
  } catch (err) {
    console.error('Failed to unlock channel:', err);
    await interaction.reply({ content: 'Failed to unlock the channel. Make sure I have Manage Channels permission.', ephemeral: true });
  }
}

module.exports = { data: commandData, execute };
