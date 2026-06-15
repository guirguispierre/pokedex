const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

const commandData = new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Configure welcome and goodbye messages')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName('channel')
      .setDescription('Set the welcome/goodbye channel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel for welcome/goodbye messages').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('message')
      .setDescription('Set a custom welcome message (use {user} {server} {count} as placeholders)')
      .addStringOption(opt => opt.setName('text').setDescription('Custom welcome message').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('goodbye')
      .setDescription('Set a custom goodbye message (use {user} {server} {count} as placeholders)')
      .addStringOption(opt => opt.setName('text').setDescription('Custom goodbye message').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('toggle')
      .setDescription('Enable or disable welcome/goodbye messages')
      .addStringOption(opt =>
        opt.setName('type')
          .setDescription('Which to toggle')
          .setRequired(true)
          .addChoices(
            { name: 'Welcome', value: 'welcome' },
            { name: 'Goodbye', value: 'goodbye' },
            { name: 'Both', value: 'both' },
          ))
      .addBooleanOption(opt => opt.setName('enabled').setDescription('Enable or disable').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('View current welcome/goodbye settings'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'channel') return handleChannel(interaction);
  if (sub === 'message') return handleMessage(interaction);
  if (sub === 'goodbye') return handleGoodbye(interaction);
  if (sub === 'toggle') return handleToggle(interaction);
  if (sub === 'status') return handleStatus(interaction);
}

async function handleChannel(interaction) {
  await interaction.deferReply();
  const channel = interaction.options.getChannel('channel');
  const db = getDb();
  await db.collection('welcome_config').doc(interaction.guild.id).set({
    channelId: channel.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await interaction.editReply(`Welcome/goodbye messages will be sent to ${channel}.`);
}

async function handleMessage(interaction) {
  await interaction.deferReply();
  const text = interaction.options.getString('text');
  const db = getDb();
  await db.collection('welcome_config').doc(interaction.guild.id).set({
    welcomeMessage: text,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await interaction.editReply(`Welcome message set to: ${text}`);
}

async function handleGoodbye(interaction) {
  await interaction.deferReply();
  const text = interaction.options.getString('text');
  const db = getDb();
  await db.collection('welcome_config').doc(interaction.guild.id).set({
    goodbyeMessage: text,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await interaction.editReply(`Goodbye message set to: ${text}`);
}

async function handleToggle(interaction) {
  await interaction.deferReply();
  const type = interaction.options.getString('type');
  const enabled = interaction.options.getBoolean('enabled');
  const db = getDb();
  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  if (type === 'welcome' || type === 'both') update.welcomeEnabled = enabled;
  if (type === 'goodbye' || type === 'both') update.goodbyeEnabled = enabled;

  await db.collection('welcome_config').doc(interaction.guild.id).set(update, { merge: true });
  await interaction.editReply(`${type === 'both' ? 'Welcome and goodbye' : type.charAt(0).toUpperCase() + type.slice(1)} messages ${enabled ? 'enabled' : 'disabled'}.`);
}

async function handleStatus(interaction) {
  await interaction.deferReply();
  const db = getDb();
  const doc = await db.collection('welcome_config').doc(interaction.guild.id).get();

  if (!doc.exists) {
    return interaction.editReply('Welcome/goodbye is not configured. Use `/welcome channel` to get started.');
  }

  const d = doc.data();
  const embed = new EmbedBuilder()
    .setTitle('👋 Welcome/Goodbye Settings')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Channel', value: d.channelId ? `<#${d.channelId}>` : 'Not set', inline: true },
      { name: 'Welcome', value: d.welcomeEnabled !== false ? '✅ On' : '❌ Off', inline: true },
      { name: 'Goodbye', value: d.goodbyeEnabled !== false ? '✅ On' : '❌ Off', inline: true },
      { name: 'Welcome Message', value: d.welcomeMessage || 'Welcome to {server}, {user}! You are member #{count}.' },
      { name: 'Goodbye Message', value: d.goodbyeMessage || '{user} has left {server}. We now have {count} members.' },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Called when a member joins the guild.
 */
async function handleMemberJoin(member) {
  const db = getDb();
  const doc = await db.collection('welcome_config').doc(member.guild.id).get();
  if (!doc.exists) return;

  const config = doc.data();
  if (config.welcomeEnabled === false || !config.channelId) return;

  const channel = member.guild.channels.cache.get(config.channelId);
  if (!channel) return;

  const template = config.welcomeMessage || 'Welcome to {server}, {user}! You are member #{count}.';
  const text = template
    .replace(/{user}/g, `${member}`)
    .replace(/{server}/g, member.guild.name)
    .replace(/{count}/g, member.guild.memberCount);

  const embed = new EmbedBuilder()
    .setTitle('👋 Welcome!')
    .setColor(0x2ecc71)
    .setDescription(text)
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .setFooter({ text: `Member #${member.guild.memberCount}` })
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch {
    // Best effort
  }
}

/**
 * Called when a member leaves the guild.
 */
async function handleMemberLeave(member) {
  const db = getDb();
  const doc = await db.collection('welcome_config').doc(member.guild.id).get();
  if (!doc.exists) return;

  const config = doc.data();
  if (config.goodbyeEnabled === false || !config.channelId) return;

  const channel = member.guild.channels.cache.get(config.channelId);
  if (!channel) return;

  const template = config.goodbyeMessage || '{user} has left {server}. We now have {count} members.';
  const text = template
    .replace(/{user}/g, member.user.username)
    .replace(/{server}/g, member.guild.name)
    .replace(/{count}/g, member.guild.memberCount);

  const embed = new EmbedBuilder()
    .setTitle('👋 Goodbye')
    .setColor(0xe74c3c)
    .setDescription(text)
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch {
    // Best effort
  }
}

module.exports = { data: commandData, execute, handleMemberJoin, handleMemberLeave };
