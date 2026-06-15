const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');
const { getConfig } = require('../config/config');

function getDb() {
  return admin.firestore();
}

const commandData = new SlashCommandBuilder()
  .setName('starboard')
  .setDescription('Configure the starboard')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName('setup')
      .setDescription('Set the starboard channel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel for starred messages').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('threshold')
      .setDescription('Set how many stars are needed')
      .addIntegerOption(opt => opt.setName('count').setDescription('Number of star reactions needed (default: 3)').setRequired(true).setMinValue(1).setMaxValue(25)))
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('View current starboard settings'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'setup') return handleSetup(interaction);
  if (sub === 'threshold') return handleThreshold(interaction);
  if (sub === 'status') return handleStatus(interaction);
}

async function handleSetup(interaction) {
  await interaction.deferReply();
  const channel = interaction.options.getChannel('channel');
  const db = getDb();
  await db.collection('starboard_config').doc(interaction.guild.id).set({
    channelId: channel.id,
    guildId: interaction.guild.id,
    updatedBy: interaction.user.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  const embed = new EmbedBuilder()
    .setTitle('⭐ Starboard Configured')
    .setColor(0xffd700)
    .setDescription(`Starred messages will be posted to ${channel}.`)
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function handleThreshold(interaction) {
  await interaction.deferReply();
  const count = interaction.options.getInteger('count');
  const db = getDb();
  await db.collection('starboard_config').doc(interaction.guild.id).set({
    threshold: count,
    updatedBy: interaction.user.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  const embed = new EmbedBuilder()
    .setTitle('⭐ Starboard Threshold Updated')
    .setColor(0xffd700)
    .setDescription(`Messages now need **${count}** ⭐ reactions to be posted to the starboard.`)
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

async function handleStatus(interaction) {
  await interaction.deferReply();
  const db = getDb();
  const doc = await db.collection('starboard_config').doc(interaction.guild.id).get();

  if (!doc.exists || !doc.data().channelId) {
    return interaction.editReply('Starboard is not configured yet. Use `/starboard setup` to set it up.');
  }

  const data = doc.data();
  const embed = new EmbedBuilder()
    .setTitle('⭐ Starboard Settings')
    .setColor(0xffd700)
    .addFields(
      { name: 'Channel', value: `<#${data.channelId}>`, inline: true },
      { name: 'Threshold', value: `${data.threshold || 3} stars`, inline: true },
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

/**
 * Called from the reaction handler when a ⭐ reaction is added.
 */
async function handleStarReaction(reaction, user) {
  if (user.bot) return;
  if (reaction.emoji.name !== '⭐') return;

  const message = reaction.message;
  if (message.partial) {
    try { await message.fetch(); } catch { return; }
  }

  // Don't star bot messages or messages in the starboard channel itself
  if (message.author.bot) return;

  const guildId = message.guild.id;
  const db = getDb();
  const configDoc = await db.collection('starboard_config').doc(guildId).get();
  if (!configDoc.exists || !configDoc.data().channelId) return;

  const config = configDoc.data();
  const threshold = config.threshold || 3;
  const starboardChannelId = config.channelId;

  // Don't star messages already in the starboard channel
  if (message.channel.id === starboardChannelId) return;

  // Check if we've hit the threshold
  const starReaction = message.reactions.cache.get('⭐');
  const count = starReaction ? starReaction.count : 0;
  if (count < threshold) return;

  // Check if this message was already starred
  const starDoc = await db.collection('starboard_posts').doc(message.id).get();

  const starboardChannel = message.guild.channels.cache.get(starboardChannelId);
  if (!starboardChannel) return;

  // Build the starboard embed
  const embed = new EmbedBuilder()
    .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL({ size: 64 }) })
    .setDescription(message.content || '*No text content*')
    .setColor(0xffd700)
    .addFields(
      { name: 'Source', value: `[Jump to message](${message.url})`, inline: true },
      { name: 'Stars', value: `⭐ ${count}`, inline: true },
    )
    .setTimestamp(message.createdAt);

  // Add first image attachment if any
  const imageAtt = message.attachments.find(a => a.contentType?.startsWith('image/'));
  if (imageAtt) {
    embed.setImage(imageAtt.url);
  }

  try {
    if (starDoc.exists) {
      // Update existing starboard post
      const starData = starDoc.data();
      const starMsg = await starboardChannel.messages.fetch(starData.starboardMessageId).catch(() => null);
      if (starMsg) {
        await starMsg.edit({ content: `⭐ **${count}** | <#${message.channel.id}>`, embeds: [embed] });
      }
      await db.collection('starboard_posts').doc(message.id).update({ starCount: count });
    } else {
      // New starboard post
      const starMsg = await starboardChannel.send({ content: `⭐ **${count}** | <#${message.channel.id}>`, embeds: [embed] });
      await db.collection('starboard_posts').doc(message.id).set({
        guildId,
        channelId: message.channel.id,
        authorId: message.author.id,
        starboardMessageId: starMsg.id,
        starCount: count,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error('Starboard error:', err);
  }
}

module.exports = { data: commandData, execute, handleStarReaction };
