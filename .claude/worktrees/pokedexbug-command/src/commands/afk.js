const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// In-memory AFK store: userId -> { reason, timestamp }
const afkUsers = new Map();

const commandData = new SlashCommandBuilder()
  .setName('afk')
  .setDescription('Set yourself as AFK — others will be notified if they ping you')
  .addStringOption(opt =>
    opt.setName('reason')
      .setDescription('Why you\'re AFK (optional)')
      .setRequired(false));

async function execute(interaction) {
  const userId = interaction.user.id;
  const reason = interaction.options.getString('reason') || 'AFK';

  // If already AFK, remove it (toggle off)
  if (afkUsers.has(userId)) {
    afkUsers.delete(userId);
    return interaction.reply({ content: 'Welcome back! Your AFK status has been removed.', ephemeral: true });
  }

  afkUsers.set(userId, { reason, timestamp: Date.now() });

  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setDescription(`💤 **${interaction.user.username}** is now AFK: ${reason}`)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

/**
 * Called on every message — checks if:
 * 1. The sender is AFK → welcome them back and remove AFK
 * 2. Any mentioned user is AFK → notify the sender
 */
async function handleAfkMentions(message) {
  if (message.author.bot) return;

  // If the sender is AFK, welcome them back
  if (afkUsers.has(message.author.id)) {
    const afkData = afkUsers.get(message.author.id);
    afkUsers.delete(message.author.id);

    const duration = formatDuration(Date.now() - afkData.timestamp);
    try {
      await message.reply({ content: `Welcome back **${message.author.username}**! You were AFK for ${duration}.`, allowedMentions: { repliedUser: false } });
    } catch {
      // Best effort
    }
  }

  // Check if any mentioned users are AFK
  if (message.mentions.users.size === 0) return;

  const afkNotices = [];
  for (const [userId, user] of message.mentions.users) {
    if (afkUsers.has(userId)) {
      const afkData = afkUsers.get(userId);
      const duration = formatDuration(Date.now() - afkData.timestamp);
      afkNotices.push(`💤 **${user.username}** is AFK: ${afkData.reason} (${duration} ago)`);
    }
  }

  if (afkNotices.length > 0) {
    try {
      await message.reply({ content: afkNotices.join('\n'), allowedMentions: { repliedUser: false } });
    } catch {
      // Best effort
    }
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`;
}

module.exports = { data: commandData, execute, handleAfkMentions };
