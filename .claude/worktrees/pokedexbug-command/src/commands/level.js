const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');
const { getConfig } = require('../config/config');

// XP cooldown — 1 minute between XP gains per user
const XP_COOLDOWN = 60_000;
const XP_PER_MESSAGE = { min: 15, max: 25 };
const cooldowns = new Map();

function getDb() {
  return admin.firestore();
}

function xpForLevel(level) {
  // XP required to reach a given level: 5 * level^2 + 50 * level + 100
  return 5 * (level * level) + 50 * level + 100;
}

function getLevelFromXP(totalXP) {
  let level = 0;
  let remaining = totalXP;
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return { level, currentXP: remaining, neededXP: xpForLevel(level) };
}

function buildProgressBar(current, total, length = 12) {
  const filled = Math.round((current / total) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

const RANK_TITLES = [
  { min: 0, title: 'Newbie' },
  { min: 5, title: 'Regular' },
  { min: 10, title: 'Active' },
  { min: 20, title: 'Veteran' },
  { min: 30, title: 'Elite' },
  { min: 50, title: 'Legend' },
  { min: 75, title: 'Mythic' },
  { min: 100, title: 'Transcendent' },
];

function getRankTitle(level) {
  let title = 'Newbie';
  for (const rank of RANK_TITLES) {
    if (level >= rank.min) title = rank.title;
  }
  return title;
}

const commandData = new SlashCommandBuilder()
  .setName('level')
  .setDescription('Check your level or someone else\'s')
  .addSubcommand(sub =>
    sub.setName('check')
      .setDescription('View level and XP')
      .addUserOption(opt => opt.setName('user').setDescription('User to check (default: you)').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('top')
      .setDescription('View the server leaderboard')
      .addIntegerOption(opt => opt.setName('limit').setDescription('How many to show (default: 10)').setRequired(false)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'check') return handleCheck(interaction);
  if (sub === 'top') return handleTop(interaction);
}

async function handleCheck(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user') || interaction.user;
  const guildId = interaction.guild.id;

  const db = getDb();
  const doc = await db.collection('levels').doc(`${guildId}_${target.id}`).get();
  const data = doc.exists ? doc.data() : { xp: 0, messages: 0 };
  const totalXP = data.xp || 0;
  const messages = data.messages || 0;

  const { level, currentXP, neededXP } = getLevelFromXP(totalXP);
  const rank = getRankTitle(level);
  const bar = buildProgressBar(currentXP, neededXP);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: target.username, iconURL: target.displayAvatarURL({ size: 64 }) })
    .setTitle(`${rank}`)
    .addFields(
      { name: 'Level', value: `**${level}**`, inline: true },
      { name: 'XP', value: `**${totalXP.toLocaleString()}** total`, inline: true },
      { name: 'Messages', value: `**${messages.toLocaleString()}**`, inline: true },
      { name: 'Progress', value: `${bar}\n${currentXP} / ${neededXP} XP to level ${level + 1}` },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleTop(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guild.id;
  const limit = Math.min(interaction.options.getInteger('limit') || 10, 25);

  const db = getDb();
  // Query all level docs for this guild, sorted by XP descending
  const snapshot = await db.collection('levels')
    .where('guildId', '==', guildId)
    .orderBy('xp', 'desc')
    .limit(limit)
    .get();

  if (snapshot.empty) {
    return interaction.editReply('No one has earned XP yet. Start chatting!');
  }

  const lines = [];
  let position = 1;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const { level } = getLevelFromXP(data.xp || 0);
    const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `**${position}.**`;
    lines.push(`${medal} <@${data.userId}> — Level **${level}** · ${(data.xp || 0).toLocaleString()} XP`);
    position++;
  }

  const embed = new EmbedBuilder()
    .setTitle('🏆 XP Leaderboard')
    .setColor(0xffd700)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Top ${snapshot.size} members • /level check to see your stats` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Called on every message to award XP.
 * - Ignores bots
 * - 1-minute cooldown per user
 * - Random 15-25 XP per qualifying message
 * - Announces level-ups in the channel
 */
async function awardXP(message) {
  if (message.author.bot) return;
  if (!message.guild) return;

  const userId = message.author.id;
  const guildId = message.guild.id;
  const now = Date.now();

  // Cooldown check
  const key = `${guildId}_${userId}`;
  const lastXP = cooldowns.get(key) || 0;
  if (now - lastXP < XP_COOLDOWN) return;
  cooldowns.set(key, now);

  const xpGain = Math.floor(Math.random() * (XP_PER_MESSAGE.max - XP_PER_MESSAGE.min + 1)) + XP_PER_MESSAGE.min;

  const db = getDb();
  const docRef = db.collection('levels').doc(key);
  const doc = await docRef.get();

  let oldXP = 0;
  let messages = 0;
  if (doc.exists) {
    const data = doc.data();
    oldXP = data.xp || 0;
    messages = data.messages || 0;
  }

  const newXP = oldXP + xpGain;
  const oldLevel = getLevelFromXP(oldXP).level;
  const newLevel = getLevelFromXP(newXP).level;

  await docRef.set({
    userId,
    guildId,
    xp: newXP,
    messages: messages + 1,
    username: message.author.username,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // Announce level up (respects level_announce config)
  const announce = getConfig('level_announce');
  if (newLevel > oldLevel && (announce === true || announce === 'true')) {
    const rank = getRankTitle(newLevel);
    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setDescription(`🎉 **${message.author.username}** leveled up to **Level ${newLevel}**! (${rank})`)
      .setTimestamp();

    try {
      await message.channel.send({ embeds: [embed] });
    } catch {
      // Best effort
    }
  }
}

module.exports = { data: commandData, execute, awardXP };
