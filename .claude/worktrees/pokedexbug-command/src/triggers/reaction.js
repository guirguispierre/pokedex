const { enqueue } = require('../services/queue');
const { processIssue } = require('../services/pipeline');
const { getConfig } = require('../config/config');

async function handleReaction(reaction, user) {
  // Ignore bot reactions
  if (user.bot) return;

  // Check if the emoji matches a configured trigger
  const bugEmoji = getConfig('emoji_trigger');
  const suggestionEmoji = getConfig('suggestion_emoji');
  const isBug = reaction.emoji.name === bugEmoji;
  const isSuggestion = reaction.emoji.name === suggestionEmoji;
  if (!isBug && !isSuggestion) return;

  // Fetch partial message if needed (reactions on uncached messages arrive as partials)
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      console.error('Failed to fetch partial reaction');
      return;
    }
  }

  const message = reaction.message;
  if (message.partial) {
    try {
      await message.fetch();
    } catch {
      console.error('Failed to fetch partial message');
      return;
    }
  }

  if (message.webhookId) return;

  // Don't create new issues from messages inside an existing issue thread
  if (message.channel.isThread()) {
    const linkedIssue = await require('../services/firestore').getIssueByThreadId(message.channel.id);
    if (linkedIssue) return;
  }

  // Only process the FIRST reaction — ignore if someone already reacted with this emoji
  if (reaction.count > 1) return;

  // Also check Firestore in case the bot restarted and lost cache
  const alreadyFiled = await require('../services/firestore').isDuplicate(message.id);
  if (alreadyFiled) return;

  const text = message.content?.trim();
  if (!text) {
    // Per spec: reply when message has no understandable content
    try {
      await message.reply("I couldn't understand an issue from that message.");
    } catch {
      // Best effort — may not have permission to reply
    }
    return;
  }

  const context = isSuggestion ? `[This is a SUGGESTION/FEATURE REQUEST, not a bug report]: ${text}` : text;
  enqueue(() => processIssue(message, context));
}

module.exports = { handleReaction };
