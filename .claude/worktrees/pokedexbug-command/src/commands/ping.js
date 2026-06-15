const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { version: BOT_VERSION } = require('../../package.json');

const commandData = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check bot latency and uptime');

const startTime = Date.now();

async function execute(interaction) {
  const sent = await interaction.deferReply({ fetchReply: true });
  const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
  const ws = interaction.client.ws.ping;
  const uptime = formatUptime(Date.now() - startTime);
  const guilds = interaction.client.guilds.cache.size;

  const embed = new EmbedBuilder()
    .setTitle('🏓 Pong!')
    .setColor(roundtrip < 200 ? 0x00cc00 : roundtrip < 500 ? 0xffd700 : 0xff0000)
    .addFields(
      { name: '📡 Roundtrip', value: `${roundtrip}ms`, inline: true },
      { name: '💓 WebSocket', value: `${ws}ms`, inline: true },
      { name: '⏱️ Uptime', value: uptime, inline: true },
      { name: '🏠 Servers', value: `${guilds}`, inline: true },
      { name: '🔖 Version', value: `v${BOT_VERSION}`, inline: true },
    )
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('GitHub')
      .setStyle(ButtonStyle.Link)
      .setURL('https://github.com/guirguispierre/pokedex')
      .setEmoji('🐙'),
    new ButtonBuilder()
      .setLabel('@somevyn')
      .setStyle(ButtonStyle.Link)
      .setURL('https://x.com/somevyn')
      .setEmoji('🐦'),
  );

  await interaction.editReply({ embeds: [embed], components: [buttons] });
}

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

module.exports = { data: commandData, execute };
