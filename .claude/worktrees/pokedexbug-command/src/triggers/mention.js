const { EmbedBuilder } = require('discord.js');
const { enqueue } = require('../services/queue');
const { processIssue } = require('../services/pipeline');

// Per-user rate limiting for issue submissions (5 per 5 minutes)
const mentionRateLimits = new Map();
const MENTION_RATE_WINDOW_MS = 5 * 60_000;
const MENTION_RATE_MAX = 5;

function checkMentionRateLimit(userId) {
  const now = Date.now();
  const bucket = mentionRateLimits.get(userId);
  if (!bucket || now > bucket.resetAt) {
    mentionRateLimits.set(userId, { count: 1, resetAt: now + MENTION_RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= MENTION_RATE_MAX) return false;
  bucket.count++;
  return true;
}

async function handleMention(message) {
  const text = message.content.replace(/<@!?\d+>/g, '').trim();

  if (!text) {
    const embed = new EmbedBuilder()
      .setTitle('Hey! I\'m Pokedex')
      .setColor(0x5865f2)
      .setDescription('I help identify and organize bugs for the engineering team. Here\'s how to use me:')
      .addFields(
        {
          name: 'Report an Issue',
          value: '**@mention me** with a description of the problem\nExample: `@Pokedex my gmail won\'t sync`',
        },
        {
          name: 'Flag a Message',
          value: 'React with 🐛 on any message to report it as an issue\nReact with 💡 to submit it as a suggestion',
        },
        {
          name: 'Commands',
          value: '`/help` — Full list of commands and settings\n`/config list` — View bot settings',
        },
      )
      .setFooter({ text: 'Identifying bugs so engineers don\'t have to hunt for them' });

    await message.reply({ embeds: [embed] });
    return;
  }

  // Rate limit issue submissions per user
  if (!checkMentionRateLimit(message.author.id)) {
    await message.reply('You\'re submitting issues too quickly. Please wait a few minutes before reporting another.');
    return;
  }

  // Include replied-to message context if present
  let fullText = text;
  if (message.reference) {
    try {
      const referenced = await message.channel.messages.fetch(message.reference.messageId);
      fullText = `[Context from replied message]: ${referenced.content}\n\n[User's report]: ${text}`;
    } catch {
      // Could not fetch referenced message, proceed with just the text
    }
  }

  enqueue(() => processIssue(message, fullText));
}

module.exports = { handleMention };