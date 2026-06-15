const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

const commandData = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Manage user warnings')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Warn a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to warn').setRequired(true))
      .addStringOption(opt => opt.setName('reason').setDescription('Reason for warning').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('View warnings for a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove a specific warning by ID')
      .addStringOption(opt => opt.setName('id').setDescription('Warning ID to remove').setRequired(true).setAutocomplete(true)))
  .addSubcommand(sub =>
    sub.setName('clear')
      .setDescription('Clear all warnings for a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to clear warnings for').setRequired(true)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return handleAdd(interaction);
  if (sub === 'list') return handleList(interaction);
  if (sub === 'remove') return handleRemove(interaction);
  if (sub === 'clear') return handleClear(interaction);
}

async function handleAdd(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const guildId = interaction.guild.id;

  if (target.bot) {
    return interaction.editReply('You cannot warn a bot.');
  }

  const db = getDb();
  const docRef = await db.collection('infractions').add({
    type: 'warn',
    userId: target.id,
    username: target.username,
    guildId,
    reason,
    moderatorId: interaction.user.id,
    moderatorName: interaction.user.username,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Count total warnings for this user
  const snapshot = await db.collection('infractions')
    .where('guildId', '==', guildId)
    .where('userId', '==', target.id)
    .where('type', '==', 'warn')
    .get();

  const count = snapshot.size;

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Warning Issued')
    .setColor(0xffd700)
    .addFields(
      { name: 'User', value: `${target} (${target.username})`, inline: true },
      { name: 'Moderator', value: `${interaction.user}`, inline: true },
      { name: 'Reason', value: reason },
      { name: 'Total Warnings', value: `**${count}**`, inline: true },
      { name: 'Warning ID', value: `\`${docRef.id}\``, inline: true },
    )
    .setTimestamp();

  // Try to DM the user
  try {
    const dmEmbed = new EmbedBuilder()
      .setTitle(`⚠️ You have been warned in ${interaction.guild.name}`)
      .setColor(0xffd700)
      .addFields(
        { name: 'Reason', value: reason },
        { name: 'Total Warnings', value: `${count}` },
      )
      .setTimestamp();
    await target.send({ embeds: [dmEmbed] });
  } catch {
    // Can't DM user
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user');
  const guildId = interaction.guild.id;

  const db = getDb();
  const snapshot = await db.collection('infractions')
    .where('guildId', '==', guildId)
    .where('userId', '==', target.id)
    .orderBy('createdAt', 'desc')
    .limit(25)
    .get();

  if (snapshot.empty) {
    return interaction.editReply(`${target.username} has no infractions on record.`);
  }

  const lines = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const ts = data.createdAt ? `<t:${Math.floor(data.createdAt.toDate().getTime() / 1000)}:R>` : 'unknown';
    lines.push(`**${data.type.toUpperCase()}** — ${data.reason}\n> By ${data.moderatorName} ${ts} · ID: \`${doc.id}\``);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📋 Infractions for ${target.username}`)
    .setColor(0x5865f2)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `${snapshot.size} infraction(s) found` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction) {
  await interaction.deferReply();
  const id = interaction.options.getString('id');

  const db = getDb();
  const doc = await db.collection('infractions').doc(id).get();

  if (!doc.exists) {
    return interaction.editReply(`No infraction found with ID \`${id}\`.`);
  }

  const data = doc.data();
  if (data.guildId !== interaction.guild.id) {
    return interaction.editReply('That infraction does not belong to this server.');
  }

  await db.collection('infractions').doc(id).delete();

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Infraction Removed')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'Type', value: data.type.toUpperCase(), inline: true },
      { name: 'User', value: data.username, inline: true },
      { name: 'Reason', value: data.reason },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleClear(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser('user');
  const guildId = interaction.guild.id;

  const db = getDb();
  const snapshot = await db.collection('infractions')
    .where('guildId', '==', guildId)
    .where('userId', '==', target.id)
    .get();

  if (snapshot.empty) {
    return interaction.editReply(`${target.username} has no infractions to clear.`);
  }

  const batch = db.batch();
  snapshot.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  const embed = new EmbedBuilder()
    .setTitle('🧹 Infractions Cleared')
    .setColor(0x2ecc71)
    .setDescription(`Cleared **${snapshot.size}** infraction(s) for ${target}.`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guild.id;
  try {
    const db = getDb();
    const snapshot = await db.collection('infractions')
      .where('guildId', '==', guildId)
      .orderBy('createdAt', 'desc')
      .limit(25)
      .get();
    const filtered = snapshot.docs
      .filter(doc => {
        const d = doc.data();
        return doc.id.toLowerCase().includes(focused) ||
          (d.username || '').toLowerCase().includes(focused) ||
          (d.reason || '').toLowerCase().includes(focused);
      })
      .slice(0, 25)
      .map(doc => {
        const d = doc.data();
        return {
          name: `${d.type.toUpperCase()} | ${d.username} | ${(d.reason || '').slice(0, 50)}`,
          value: doc.id,
        };
      });
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
}

module.exports = { data: commandData, execute, autocomplete };
