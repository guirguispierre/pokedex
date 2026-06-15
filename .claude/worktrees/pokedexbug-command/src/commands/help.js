const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const commandData = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show all Pokedex commands')
  .addStringOption(opt =>
    opt.setName('category')
      .setDescription('Show commands from a specific category')
      .setRequired(false)
      .addChoices(
        { name: 'Issues & Triage', value: 'issues' },
        { name: 'Moderation', value: 'mod' },
        { name: 'Community', value: 'community' },
        { name: 'Fun & Utility', value: 'fun' },
        { name: 'Settings', value: 'settings' },
      ));

const CATEGORIES = {
  issues: {
    title: '🐛 Issues & Triage',
    commands: [
      '`/issue view <id>` — View full issue details',
      '`/issue list [filter]` — List open issues',
      '`/issue mine` — See your recent reports',
      '`/issue search <query>` — Search saved issues',
      '`/issue close <id>` — Close/resolve an issue',
      '`/issue reopen <id>` — Reopen a closed issue',
      '`/issue assign <id> [user]` — Assign ownership',
      '`/issue note <id> <note>` — Add an internal note',
      '`/issue status` — Show issue dashboard & counts',
      '`/merge <target> <sources>` — Merge multiple issues into one',
      '`/feedback` — Organize and summarize feedback posts',
      '',
      '**How to report:**',
      '**@Pokedex** — mention with a description',
      '**React 🐛** — flag a message as a bug',
      '**React 💡** — submit a suggestion',
    ],
  },
  mod: {
    title: '🛡️ Moderation',
    commands: [
      '`/warn add <user> <reason>` — Warn a user',
      '`/warn list <user>` — View infraction history',
      '`/warn remove <id>` — Remove a warning by ID',
      '`/warn clear <user>` — Clear all warnings',
      '`/timeout <user> <duration>` — Temporarily mute a user',
      '`/kick <user> [reason]` — Kick a user from the server',
      '`/ban <user> [reason] [delete_days]` — Ban a user',
      '`/purge <amount> [user]` — Bulk delete messages (1-100)',
      '`/slowmode <seconds> [channel]` — Set channel slowmode',
      '`/lock [channel] [reason]` — Lock a channel',
      '`/unlock [channel]` — Unlock a channel',
      '`/deletethread [thread] [reason]` — Delete a thread',
    ],
  },
  community: {
    title: '🎉 Community',
    commands: [
      '`/starboard setup <channel>` — Set the starboard channel',
      '`/starboard threshold <count>` — Stars needed to post (default 3)',
      '`/starboard status` — View starboard settings',
      '`/poll <question> <options>` — Create a reaction poll',
      '`/welcome channel <channel>` — Set welcome/goodbye channel',
      '`/welcome message <text>` — Custom welcome message',
      '`/welcome goodbye <text>` — Custom goodbye message',
      '`/welcome toggle <type> <on/off>` — Enable/disable',
      '`/welcome status` — View settings',
      '`/reactionrole setup` — Create a reaction role menu',
      '`/giveaway start <prize> <duration>` — Start a giveaway',
      '`/giveaway reroll <message_id>` — Re-pick a winner',
      '`/suggest idea <text>` — Submit a suggestion',
      '`/suggest status <id> <status>` — Update suggestion status',
      '`/suggest channel <channel>` — Set suggestions channel',
    ],
  },
  fun: {
    title: '🎮 Fun & Utility',
    commands: [
      '`/level check [user]` — View XP, level, and rank',
      '`/level top [limit]` — Server XP leaderboard',
      '`/afk [reason]` — Toggle AFK status',
      '`/serverinfo` — Server stats and member counts',
      '`/leaderboard [type]` — Top bug reporters & stats',
      '`/pokedex <pokemon>` — Look up a Pokemon',
      '`/typechart <type>` — Type strengths and weaknesses',
      '`/ping` — Bot latency, uptime, and version',
      '`/changelog` — View recent bot updates',
    ],
  },
  settings: {
    title: '⚙️ Settings',
    commands: [
      '`/config list` — View all current settings',
      '`/config get <key>` — View a specific setting',
      '`/config set <key> <value>` — Change a setting',
      '`/config reset <key>` — Reset to default',
      '',
      '**Available settings:**',
      '`model` — AI model for classification',
      '`triage_channel` — Channel for issue embeds',
      '`emoji_trigger` — Emoji that triggers issue reporting',
      '`suggestion_emoji` — Emoji for suggestions',
      '`output_mode` — embed, summary, or both',
      '`acknowledge` — Reply to reporter (true/false)',
      '`summary_interval` — Digest frequency (daily/weekly)',
      '`level_announce` — Show level-ups in chat (true/false)',
    ],
  },
};

async function execute(interaction) {
  const category = interaction.options.getString('category');

  if (category) {
    const cat = CATEGORIES[category];
    const embed = new EmbedBuilder()
      .setTitle(cat.title)
      .setColor(0x5865f2)
      .setDescription(cat.commands.join('\n'))
      .setFooter({ text: 'Pokedex v2.1.0 • /help to see all categories' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // Show overview with all categories
  const embed = new EmbedBuilder()
    .setTitle('Pokedex — All Commands')
    .setColor(0x5865f2)
    .setDescription('Use `/help <category>` for detailed command info, or just start typing `/` to see all commands.')
    .setTimestamp();

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    // Show first few commands as preview
    const preview = cat.commands
      .filter(line => line.startsWith('`'))
      .slice(0, 4)
      .map(line => line.split('—')[0].trim())
      .join(', ');

    const count = cat.commands.filter(line => line.startsWith('`')).length;
    embed.addFields({
      name: cat.title,
      value: `${preview}${count > 4 ? ` + ${count - 4} more` : ''}\n> \`/help ${key}\` for details`,
    });
  }

  embed.setFooter({ text: 'Pokedex v2.1.0 • Type / to see all commands with autocomplete' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { data: commandData, execute };
