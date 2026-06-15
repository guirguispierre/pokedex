const { evaluateIssueContext } = require('./openrouter');
const { classifyIssue } = require('./openrouter');
const firestore = require('./firestore');
const { buildIssueEmbed, findTriageChannel } = require('./triage');

async function evaluateContext(issue, conversationHistory, extraHint) {
  return evaluateIssueContext(issue, conversationHistory, extraHint);
}

async function processEvaluation(guild, issue, issueId, evaluation) {
  // Update triage embed if there's new context to show
  if (evaluation.triageUpdate && issue.triageMessageId) {
    const triageChannel = findTriageChannel(guild);
    if (triageChannel) {
      try {
        const triageMsg = await triageChannel.messages.fetch(issue.triageMessageId);
        const embed = buildIssueEmbed(issue, issueId);
        embed.addFields({ name: '💬 Context Update', value: evaluation.triageUpdate.slice(0, 1024) });
        embed.setTimestamp();
        await triageMsg.edit({ embeds: [embed] });
      } catch {
        // Triage message may have been deleted
      }
    }
  }

  // Reclassify if needed
  if (evaluation.reclassify) {
    const threadContext = issue.threadContext || [];
    const additionalInfo = threadContext.map(c => c.text).join('\n');
    const fullContext = `Original report: ${issue.text}\n\nAdditional information:\n${additionalInfo}`;
    const newClassification = await classifyIssue(fullContext);
    await firestore.updateIssueClassification(issueId, newClassification);
  }

  // Mark context complete
  if (evaluation.complete && !issue.contextComplete) {
    await firestore.updateIssueFields(issueId, {
      contextComplete: true,
      contextCompletedAt: new Date().toISOString(),
    });
    await updateContextBadge(guild, { ...issue, contextComplete: true }, issueId);
  }
}

async function updateContextBadge(guild, issue, issueId) {
  if (!issue.triageMessageId) return;
  const triageChannel = findTriageChannel(guild);
  if (!triageChannel) return;

  try {
    const triageMsg = await triageChannel.messages.fetch(issue.triageMessageId);
    const embed = buildIssueEmbed(issue, issueId);
    embed.setTimestamp();
    await triageMsg.edit({ embeds: [embed] });
  } catch {
    // Triage message may have been deleted
  }
}

function buildConversationHistory(messages) {
  return messages.map(m => ({
    author: m.author?.username || 'unknown',
    isBot: m.author?.bot || false,
    content: m.content || '',
    attachments: [...(m.attachments?.values() || [])].map(a => ({ url: a.url, name: a.name })),
    createdAt: m.createdAt?.toISOString() || new Date().toISOString(),
  }));
}

module.exports = { evaluateContext, processEvaluation, updateContextBadge, buildConversationHistory };
