const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const commandData = new SlashCommandBuilder()
  .setName('slowmode')
  .setDescription('Set or remove slowmode on a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addIntegerOption(opt =>
    opt.setName('seconds')
      .setDescription('Slowmode delay in seconds (0 to disable)')
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(21600))
  .addChannelOption(opt =>
    opt.setName('channel')
      .setDescription('Channel to set slowmode on (default: current)')
      .setRequired(false));

async function execute(interaction) {
  await interaction.deferReply();
  const seconds = interaction.options.getInteger('seconds');
  const channel = interaction.options.getChannel('channel') || interaction.channel;

  if (!channel.isTextBased() || !('setRateLimitPerUser' in channel)) {
    return interaction.editReply('Slowmode can only be set on text channels.');
  }

  try {
    await channel.setRateLimitPerUser(seconds, `Set by ${interaction.user.username}`);
  } catch (err) {
    return interaction.editReply(`Failed to set slowmode: ${err.message}`);
  }

  let description;
  if (seconds === 0) {
    description = `Slowmode disabled in ${channel}.`;
  } else if (seconds < 60) {
    description = `Slowmode set to **${seconds}s** in ${channel}.`;
  } else if (seconds < 3600) {
    description = `Slowmode set to **${Math.floor(seconds / 60)}m ${seconds % 60}s** in ${channel}.`;
  } else {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    description = `Slowmode set to **${h}h ${m}m** in ${channel}.`;
  }

  const embed = new EmbedBuilder()
    .setTitle(seconds === 0 ? '🟢 Slowmode Disabled' : '🐌 Slowmode Set')
    .setColor(seconds === 0 ? 0x2ecc71 : 0xe67e22)
    .setDescription(description)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data: commandData, execute };
