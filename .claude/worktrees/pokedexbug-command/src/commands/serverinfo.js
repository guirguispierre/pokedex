const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');

const commandData = new SlashCommandBuilder()
  .setName('serverinfo')
  .setDescription('Show server stats and info');

async function execute(interaction) {
  const guild = interaction.guild;
  await guild.members.fetch().catch(() => {});

  const totalMembers = guild.memberCount;
  const humans = guild.members.cache.filter(m => !m.user.bot).size;
  const bots = guild.members.cache.filter(m => m.user.bot).size;
  const online = guild.members.cache.filter(m => m.presence?.status === 'online').size;

  const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size;
  const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
  const categories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;
  const threads = guild.channels.cache.filter(c => c.isThread()).size;

  const roles = guild.roles.cache.size - 1; // exclude @everyone
  const emojis = guild.emojis.cache.size;
  const stickers = guild.stickers.cache.size;

  const boostLevel = guild.premiumTier;
  const boosts = guild.premiumSubscriptionCount || 0;

  const created = Math.floor(guild.createdTimestamp / 1000);

  const embed = new EmbedBuilder()
    .setTitle(guild.name)
    .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
    .setColor(0x5865f2)
    .addFields(
      { name: '👥 Members', value: `**${totalMembers}** total\n${humans} humans · ${bots} bots`, inline: true },
      { name: '💬 Channels', value: `${textChannels} text · ${voiceChannels} voice\n${categories} categories · ${threads} threads`, inline: true },
      { name: '🎭 Roles', value: `${roles}`, inline: true },
      { name: '😀 Emojis & Stickers', value: `${emojis} emojis · ${stickers} stickers`, inline: true },
      { name: '🚀 Boosts', value: `Level ${boostLevel} (${boosts} boosts)`, inline: true },
      { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
      { name: '📅 Created', value: `<t:${created}:D> (<t:${created}:R>)`, inline: false },
    )
    .setFooter({ text: `Server ID: ${guild.id}` })
    .setTimestamp();

  if (guild.description) {
    embed.setDescription(guild.description);
  }

  if (guild.bannerURL()) {
    embed.setImage(guild.bannerURL({ size: 512 }));
  }

  await interaction.reply({ embeds: [embed] });
}

module.exports = { data: commandData, execute };
