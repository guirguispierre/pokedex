const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

const commandData = new SlashCommandBuilder()
  .setName('poll')
  .setDescription('Create a poll')
  .addStringOption(opt => opt.setName('question').setDescription('The poll question').setRequired(true))
  .addStringOption(opt => opt.setName('options').setDescription('Comma-separated options (2-10)').setRequired(true))
  .addIntegerOption(opt =>
    opt.setName('duration')
      .setDescription('Duration in minutes before auto-closing (optional)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(1440));

async function execute(interaction) {
  const question = interaction.options.getString('question');
  const optionsRaw = interaction.options.getString('options');
  const duration = interaction.options.getInteger('duration');

  const options = optionsRaw.split(',').map(o => o.trim()).filter(Boolean);

  if (options.length < 2) {
    return interaction.reply({ content: 'You need at least 2 options. Separate them with commas.', ephemeral: true });
  }
  if (options.length > 10) {
    return interaction.reply({ content: 'Maximum 10 options allowed.', ephemeral: true });
  }

  const description = options.map((opt, i) => `${NUMBER_EMOJIS[i]} ${opt}`).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${question}`)
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({ text: `Poll by ${interaction.user.username}${duration ? ` • Closes in ${duration} minute(s)` : ''}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  const msg = await interaction.fetchReply();

  // Add reaction options
  for (let i = 0; i < options.length; i++) {
    try {
      await msg.react(NUMBER_EMOJIS[i]);
    } catch {
      // Best effort
    }
  }

  // Auto-close after duration
  if (duration) {
    setTimeout(async () => {
      try {
        const fetchedMsg = await msg.channel.messages.fetch(msg.id);
        const results = [];

        for (let i = 0; i < options.length; i++) {
          const reaction = fetchedMsg.reactions.cache.get(NUMBER_EMOJIS[i]);
          // Subtract 1 for the bot's own reaction
          const votes = reaction ? reaction.count - 1 : 0;
          results.push({ option: options[i], votes, emoji: NUMBER_EMOJIS[i] });
        }

        results.sort((a, b) => b.votes - a.votes);
        const totalVotes = results.reduce((sum, r) => sum + r.votes, 0);

        const resultsDesc = results.map(r => {
          const pct = totalVotes > 0 ? Math.round((r.votes / totalVotes) * 100) : 0;
          const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
          return `${r.emoji} **${r.option}** — ${r.votes} vote(s) (${pct}%)\n${bar}`;
        }).join('\n\n');

        const resultsEmbed = new EmbedBuilder()
          .setTitle(`📊 Poll Results: ${question}`)
          .setColor(0x2ecc71)
          .setDescription(resultsDesc)
          .setFooter({ text: `${totalVotes} total vote(s) • Poll closed` })
          .setTimestamp();

        await fetchedMsg.edit({ embeds: [resultsEmbed] });
        // Remove all reactions to indicate poll is closed
        await fetchedMsg.reactions.removeAll().catch(() => {});
      } catch (err) {
        console.error('Failed to close poll:', err);
      }
    }, duration * 60_000);
  }
}

module.exports = { data: commandData, execute };
