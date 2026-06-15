const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

const commandData = new SlashCommandBuilder()
  .setName('merge')
  .setDescription('Merge multiple issues into one')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addStringOption(opt =>
    opt.setName('target')
      .setDescription('Issue ID to keep (the primary issue)')
      .setRequired(true)
      .setAutocomplete(true))
  .addStringOption(opt =>
    opt.setName('sources')
      .setDescription('Issue IDs to merge in (comma-separated)')
      .setRequired(true)
      .setAutocomplete(true))
  .addStringOption(opt =>
    opt.setName('reason')
      .setDescription('Why these issues are being merged')
      .setRequired(false));

async function execute(interaction) {
  await interaction.deferReply();

  const targetId = interaction.options.getString('target').trim();
  const sourceIds = interaction.options.getString('sources')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const reason = interaction.options.getString('reason') || 'Duplicate/related issues';

  if (sourceIds.length === 0) {
    return interaction.editReply('Please provide at least one source issue ID to merge.');
  }

  if (sourceIds.includes(targetId)) {
    return interaction.editReply('The target issue cannot also be a source issue.');
  }

  const db = getDb();

  // Fetch target issue
  const targetDoc = await db.collection('issues').doc(targetId).get();
  if (!targetDoc.exists) {
    return interaction.editReply(`Target issue \`${targetId}\` not found.`);
  }
  const targetData = targetDoc.data();

  // Fetch all source issues
  const sourceIssues = [];
  const notFound = [];
  for (const id of sourceIds) {
    const doc = await db.collection('issues').doc(id).get();
    if (doc.exists) {
      sourceIssues.push({ id: doc.id, ...doc.data() });
    } else {
      notFound.push(id);
    }
  }

  if (sourceIssues.length === 0) {
    return interaction.editReply('None of the source issue IDs were found.');
  }

  // Build merged context from source issues
  const mergedContext = [];
  const mergedAttachments = [...(targetData.attachments || [])];
  const mergedReporters = new Set();
  mergedReporters.add(targetData.reporterName || 'unknown');

  for (const source of sourceIssues) {
    // Collect text context
    const sourceText = source.text || source.summary || '';
    mergedContext.push(`[Merged from ${source.id} by ${source.reporterName || 'unknown'}]: ${sourceText}`);

    // Collect thread context
    if (source.threadContext && Array.isArray(source.threadContext)) {
      for (const ctx of source.threadContext) {
        mergedContext.push(ctx.text);
      }
    }

    // Collect attachments
    if (source.attachments && Array.isArray(source.attachments)) {
      mergedAttachments.push(...source.attachments);
    }

    mergedReporters.add(source.reporterName || 'unknown');
  }

  // Update target issue with merged data
  const existingContext = targetData.threadContext || [];
  for (const text of mergedContext) {
    existingContext.push({ text, addedAt: new Date().toISOString() });
  }

  // Build merge record
  const mergeRecord = {
    mergedAt: new Date().toISOString(),
    mergedBy: interaction.user.username,
    mergedByUserId: interaction.user.id,
    sourceIssueIds: sourceIssues.map(s => s.id),
    reason,
  };

  const updateData = {
    threadContext: existingContext,
    mergeHistory: admin.firestore.FieldValue.arrayUnion(mergeRecord),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Merge unique attachments
  if (mergedAttachments.length > 0) {
    updateData.attachments = mergedAttachments;
  }

  await db.collection('issues').doc(targetId).update(updateData);

  // Close source issues with a merge note
  for (const source of sourceIssues) {
    await db.collection('issues').doc(source.id).update({
      status: 'merged',
      mergedInto: targetId,
      closedBy: interaction.user.id,
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Build response embed
  const mergedSummaries = sourceIssues
    .map(s => `\`${s.id}\` — ${(s.summary || s.text || 'No summary').slice(0, 100)}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🔀 Issues Merged')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Target Issue', value: `\`${targetId}\`\n${(targetData.summary || targetData.text || 'No summary').slice(0, 100)}` },
      { name: `Merged In (${sourceIssues.length})`, value: mergedSummaries.slice(0, 1024) },
      { name: 'Reason', value: reason },
      { name: 'Reporters Combined', value: [...mergedReporters].join(', '), inline: true },
      { name: 'Merged By', value: interaction.user.username, inline: true },
    )
    .setTimestamp();

  if (notFound.length > 0) {
    embed.addFields({ name: '⚠️ Not Found', value: notFound.map(id => `\`${id}\``).join(', ') });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  try {
    const db = getDb();
    const snapshot = await db.collection('issues').orderBy('createdAt', 'desc').limit(50).get();
    const filtered = snapshot.docs
      .filter(doc => {
        const d = doc.data();
        return doc.id.toLowerCase().includes(focused) || (d.summary || '').toLowerCase().includes(focused);
      })
      .slice(0, 25)
      .map(doc => {
        const d = doc.data();
        return {
          name: `${doc.id.slice(0, 8)}… | ${(d.status || 'open').toUpperCase()} | ${(d.summary || 'Untitled').slice(0, 60)}`,
          value: doc.id,
        };
      });
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
}

module.exports = { data: commandData, execute, autocomplete };
