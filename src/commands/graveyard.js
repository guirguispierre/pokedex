const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const admin = require('firebase-admin');

// Deleted-message tallies live in the `deletedMessages` collection, keyed by
// `${guildId}_${userId}`. The board query filters by guildId only (a single-field
// index Firestore provides automatically) and sorts in memory — this avoids
// requiring a deployed composite index, which otherwise makes the query throw.
function getDb() {
  return admin.firestore();
}

const commandData = new SlashCommandBuilder()
  .setName('graveyard')
  .setDescription('See whose messages have met their end the most')
  .addSubcommand(sub =>
    sub.setName('board')
      .setDescription('View the deleted-messages leaderboard (visible to everyone)')
      .addIntegerOption(opt =>
        opt.setName('limit')
          .setDescription('How many to show (default: 10)')
          .setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('check')
      .setDescription('See how many messages a user has had deleted')
      .addUserOption(opt =>
        opt.setName('user')
          .setDescription('User to check (default: you)')
          .setRequired(false)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'board') return handleBoard(interaction);
  if (sub === 'check') return handleCheck(interaction);
}

// Both viewing subcommands reply publicly so the whole server sees the results.
async function handleBoard(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guild.id;
  const limit = Math.min(interaction.options.getInteger('limit') || 10, 25);

  const db = getDb();
  const snapshot = await db.collection('deletedMessages')
    .where('guildId', '==', guildId)
    .get();

  const rows = snapshot.docs
    .map(doc => doc.data())
    .filter(d => (d.count || 0) > 0)
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, limit);

  if (rows.length === 0) {
    return interaction.editReply('No deleted messages tracked yet.');
  }

  const lines = rows.map((data, i) => {
    const position = i + 1;
    const count = data.count || 0;
    const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `**${position}.**`;
    return `${medal} <@${data.userId}> — **${count.toLocaleString()}** deleted message${count === 1 ? '' : 's'}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('⚰️ Message Graveyard')
    .setColor(0xe74c3c)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Top ${rows.length} members • /graveyard check to see your count` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleCheck(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user') || interaction.user;
  const guildId = interaction.guild.id;

  const db = getDb();
  const doc = await db.collection('deletedMessages').doc(`${guildId}_${target.id}`).get();
  const count = doc.exists ? (doc.data().count || 0) : 0;

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setAuthor({ name: target.username, iconURL: target.displayAvatarURL({ size: 64 }) })
    .setTitle('⚰️ Message Graveyard')
    .setDescription(`<@${target.id}> has had **${count.toLocaleString()}** message${count === 1 ? '' : 's'} deleted.`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// Atomically bump a user's deleted-message tally. Uses FieldValue.increment so
// concurrent deletes never clobber each other.
async function increment(guildId, userId, username, amount) {
  const db = getDb();
  const key = `${guildId}_${userId}`;
  await db.collection('deletedMessages').doc(key).set({
    userId,
    guildId,
    username,
    count: admin.firestore.FieldValue.increment(amount),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Called on the messageDelete gateway event. Uncached deletes arrive as partials
// with no author — we can't attribute those, so they're skipped.
async function trackDeletedMessage(message) {
  if (!message.guild) return;
  const author = message.author;
  if (!author || author.bot) return;
  await increment(message.guild.id, author.id, author.username, 1);
}

// Called on the messageDeleteBulk event (e.g. /purge). Aggregates per author so
// each affected user gets a single incrementing write.
async function trackBulkDeletedMessages(messages) {
  const perUser = new Map();
  for (const message of messages.values()) {
    if (!message.guild) continue;
    const author = message.author;
    if (!author || author.bot) continue;
    const existing = perUser.get(author.id) || { count: 0, username: author.username, guildId: message.guild.id };
    existing.count += 1;
    perUser.set(author.id, existing);
  }
  for (const [userId, info] of perUser) {
    await increment(info.guildId, userId, info.username, info.count);
  }
}

module.exports = { data: commandData, execute, trackDeletedMessage, trackBulkDeletedMessages };
