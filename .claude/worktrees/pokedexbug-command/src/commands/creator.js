const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const commandData = new SlashCommandBuilder()
  .setName('creator')
  .setDescription('Learn about the creator of Pokedex and the project');

async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('🧑‍💻 About Pokedex')
    .setColor(0x5865f2)
    .setDescription('Pokedex is an open-source Discord bot built for issue tracking, moderation, and community management.')
    .addFields(
      { name: '👤 Creator', value: '**pierre** (@somevyn)', inline: true },
      { name: '📦 Open Source', value: 'Contributions welcome!', inline: true },
      { name: '🛠️ Built With', value: 'Discord.js v14 • Firebase • Node.js', inline: false },
    )
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('GitHub Repository')
      .setStyle(ButtonStyle.Link)
      .setURL('https://github.com/guirguispierre/pokedex')
      .setEmoji('🐙'),
    new ButtonBuilder()
      .setLabel('@somevyn on X')
      .setStyle(ButtonStyle.Link)
      .setURL('https://x.com/somevyn')
      .setEmoji('🐦'),
  );

  await interaction.reply({ embeds: [embed], components: [buttons] });
}

module.exports = { data: commandData, execute };
