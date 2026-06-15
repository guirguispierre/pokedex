const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const firestore = require('./firestore');
const { findTriageChannel } = require('./triage');

const PRIORITY_COLORS = {
  critical: 0xff0000,
  high: 0xff8c00,
  medium: 0xffd700,
  low: 0x00cc00,
  unclassified: 0x808080,
};

/**
 * Poll Firestore for pending MCP issues and post them to eng-triage with Approve/Delete buttons.
 */
async function checkPendingIssues(guild) {
  const triageChannel = findTriageChannel(guild);
  if (!triageChannel) return;

  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const snapshot = await db.collection('issues')
      .where('status', '==', 'pending')
      .where('source', '==', 'mcp')
      .orderBy('createdAt', 'asc')
      .limit(10)
      .get();

    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
      const issue = doc.data();
      const issueId = doc.id;

      // Check if we already posted this (avoid duplicate embeds)
      if (issue.pendingMessageId) continue;

      const color = PRIORITY_COLORS[issue.priority] ?? 0x9b59b6;

      const embed = new EmbedBuilder()
        .setTitle(`⏳ MCP Report — ${issue.summary || 'No summary'}`)
        .setColor(0x9b59b6)
        .setDescription('Submitted via MCP agent. **Approve** to add to triage or **Delete** to discard.')
        .addFields(
          { name: 'Priority', value: issue.priority || 'unknown', inline: true },
          { name: 'Category', value: issue.category || 'other', inline: true },
          { name: 'Reporter', value: issue.reporterName || 'unknown', inline: true },
          { name: 'Source', value: 'MCP Agent', inline: true },
          { name: 'Description', value: (issue.text || '(no description)').slice(0, 1024) },
        )
        .setFooter({ text: `Issue ID: ${issueId} | Pending approval` })
        .setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mcp_approve_${issueId}`)
          .setLabel('Approve')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`mcp_delete_${issueId}`)
          .setLabel('Delete')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
      );

      const msg = await triageChannel.send({ embeds: [embed], components: [buttons] });

      // Mark as posted so we don't re-post
      await db.collection('issues').doc(issueId).update({ pendingMessageId: msg.id });
    }
  } catch (err) {
    console.error('Pending issue check failed:', err.message);
  }
}

/**
 * Start polling for pending issues every 30 seconds.
 */
function startPendingPoller(guild) {
  // Check immediately on startup
  checkPendingIssues(guild);
  // Then every 30 seconds
  setInterval(() => checkPendingIssues(guild), 30000);
  console.log('Pending MCP issue poller started (30s interval)');
}

module.exports = { startPendingPoller };
