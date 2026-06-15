const admin = require('firebase-admin');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const firestore = require('./firestore');
const {
  findTriageChannel,
  buildIssueEmbed,
  buildTriageButtons,
} = require('./triage');

const APPROVE_EMOJI = '✅';
const DECLINE_EMOJI = '❌';
const ISSUE_ID_PATTERN = /Issue ID:\s*([A-Za-z0-9_-]+)/i;

function getDb() {
  return admin.firestore();
}

function extractIssueId(text) {
  if (!text) return null;
  return text.match(ISSUE_ID_PATTERN)?.[1] || null;
}

function extractIssueIdFromMessage(message) {
  for (const embed of message.embeds || []) {
    const embedIssueId = extractIssueId(embed.footer?.text)
      || extractIssueId(embed.description)
      || extractIssueId(embed.title);
    if (embedIssueId) return embedIssueId;
  }

  return extractIssueId(message.content);
}

function canModerate(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageMessages));
}

async function fetchIssueById(issueId) {
  if (!issueId) return null;

  const doc = await getDb().collection('issues').doc(issueId).get();
  if (!doc.exists) return null;
  return { issueId: doc.id, issue: doc.data() };
}

async function fetchIssueByField(field, value) {
  const snapshot = await getDb().collection('issues')
    .where(field, '==', value)
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  return { issueId: doc.id, issue: doc.data() };
}

async function resolvePendingIssueFromMessage(message) {
  const issueId = extractIssueIdFromMessage(message);
  const directMatch = await fetchIssueById(issueId);
  if (directMatch) return directMatch;

  const byReplyId = await fetchIssueByField('pendingReplyMessageId', message.id);
  if (byReplyId) return byReplyId;

  const byWebhookId = await fetchIssueByField('pendingMessageId', message.id);
  if (byWebhookId) return byWebhookId;

  return null;
}

function buildPendingApprovalButtons(issueId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mcp_approve_${issueId}`)
      .setLabel('Approve')
      .setEmoji(APPROVE_EMOJI)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mcp_decline_${issueId}`)
      .setLabel('Decline')
      .setEmoji(DECLINE_EMOJI)
      .setStyle(ButtonStyle.Danger),
  );
}

function buildPendingApprovalEmbed(issue, issueId) {
  return new EmbedBuilder()
    .setTitle(`Pending MCP Issue: ${issue.summary || 'Untitled report'}`)
    .setColor(0x9b59b6)
    .setDescription('Approve to move this into triage, or decline to reject it.')
    .addFields(
      { name: 'Priority', value: issue.priority || 'unknown', inline: true },
      { name: 'Category', value: issue.category || 'other', inline: true },
      { name: 'Reporter', value: issue.reporterName || 'unknown', inline: true },
      { name: 'Source', value: 'MCP Agent', inline: true },
      { name: 'Description', value: (issue.text || '(no description)').slice(0, 1024) },
    )
    .setFooter({ text: `Issue ID: ${issueId} | Pending approval` })
    .setTimestamp();
}

async function syncPendingWebhookMessage(message) {
  const resolved = await resolvePendingIssueFromMessage(message);
  if (!resolved) return false;

  const { issueId, issue } = resolved;
  if (issue.source !== 'mcp' || issue.status !== 'pending') return false;
  if (issue.pendingReplyMessageId) return true;

  const reply = await message.reply({
    embeds: [buildPendingApprovalEmbed(issue, issueId)],
    components: [buildPendingApprovalButtons(issueId)],
  });

  await getDb().collection('issues').doc(issueId).update({
    pendingMessageId: message.id,
    pendingReplyMessageId: reply.id,
    pendingChannelId: message.channel.id,
  });

  return true;
}

async function decidePendingIssue(issueId, decision, user) {
  const docRef = getDb().collection('issues').doc(issueId);
  const existing = await docRef.get();
  if (!existing.exists) {
    return { ok: false, error: 'Issue not found.' };
  }

  const issue = existing.data();
  if (issue.source !== 'mcp') {
    return { ok: false, error: 'This approval flow only supports MCP issues.' };
  }

  if (issue.status !== 'pending') {
    return { ok: false, error: `Issue is already ${issue.status || 'processed'}.` };
  }

  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const update = decision === 'approve'
    ? {
        status: 'open',
        approvedBy: user.id,
        approvedAt: timestamp,
        pendingDecision: 'approved',
        pendingResolvedAt: timestamp,
      }
    : {
        status: 'declined',
        declinedBy: user.id,
        declinedAt: timestamp,
        pendingDecision: 'declined',
        pendingResolvedAt: timestamp,
      };

  await docRef.update(update);

  const updated = await docRef.get();
  return { ok: true, issue: updated.data() };
}

async function fetchMessageById(channel, messageId) {
  if (!channel?.messages?.fetch || !messageId) return null;
  try {
    return await channel.messages.fetch(messageId);
  } catch {
    return null;
  }
}

async function deletePendingMessages(channel, issue) {
  const ids = [issue.pendingReplyMessageId, issue.pendingMessageId]
    .filter(Boolean)
    .filter((id, index, arr) => arr.indexOf(id) === index);

  for (const messageId of ids) {
    const message = await fetchMessageById(channel, messageId);
    if (!message?.deletable) continue;
    await message.delete().catch(() => {});
  }
}

async function postApprovedIssueToTriage(guild, issue, issueId, username) {
  const triageChannel = findTriageChannel(guild);
  if (!triageChannel) {
    return { ok: false, error: 'Triage channel not found. Approval was not completed.' };
  }

  const embed = buildIssueEmbed(issue, issueId);
  embed.addFields({ name: '✅ Approved', value: `by ${username} — <t:${Math.floor(Date.now() / 1000)}:R>` });

  const message = await triageChannel.send({
    embeds: [embed],
    components: [buildTriageButtons(issueId)],
  });

  await firestore.updateIssueTriageMessageId(issueId, message.id);
  await firestore.updateIssueTriageChannelId(issueId, triageChannel.id);
  return { ok: true, triageChannel };
}

async function processPendingDecision({ guild, channel, issueId, decision, user }) {
  const pending = await fetchIssueById(issueId);
  if (!pending) {
    return { ok: false, error: 'Issue not found.' };
  }

  if (decision === 'approve' && !guild) {
    return { ok: false, error: 'Guild context is required to approve this issue.' };
  }

  if (decision === 'approve') {
    const triageChannel = findTriageChannel(guild);
    if (!triageChannel) {
      return { ok: false, error: 'Triage channel not found. Approval was not completed.' };
    }
  }

  const result = await decidePendingIssue(issueId, decision, user);
  if (!result.ok) return result;

  if (decision === 'approve') {
    const triageResult = await postApprovedIssueToTriage(guild, result.issue, issueId, user.username);
    if (!triageResult.ok) {
      return triageResult;
    }
  }

  await deletePendingMessages(channel, result.issue);

  return {
    ok: true,
    issue: result.issue,
    message: decision === 'approve'
      ? 'Approved and moved to triage.'
      : 'Declined and removed from the channel.',
  };
}

module.exports = {
  APPROVE_EMOJI,
  DECLINE_EMOJI,
  canModerate,
  decidePendingIssue,
  processPendingDecision,
  syncPendingWebhookMessage,
};
