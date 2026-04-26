const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'of', 'to', 'for', 'in', 'on', 'at',
  'with', 'by', 'from', 'i', 'me', 'my', 'you', 'your', 'it', 'is', 'be',
  'that', 'this', 'these', 'those', 'would', 'could', 'should',
  'tool', 'tools', 'capability', 'ability',
]);

function normalizeKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w))
    .map(w => w.replace(/(ing|ed|s)$/, ''))
    .sort()
    .join(' ');
}

function shouldRepingAtCount(n) {
  return n === 1 || n === 3 || n === 10 || n === 50;
}

function findChannelByName(guild, name) {
  return guild?.channels?.cache?.find?.(c => c.name === name && c.isTextBased?.()) || null;
}

function buildEmbedContent({ gap, occurrenceCount, firstSeenAt, lastSeenAt, status, exampleIssueIds, ownerPing }) {
  const when = (iso) => {
    if (!iso) return 'just now';
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return d.toISOString();
  };
  const lines = [
    `🔧 **Capability gap: ${gap.title}**`,
    `Seen **${occurrenceCount}** time${occurrenceCount === 1 ? '' : 's'} (first: ${when(firstSeenAt)}, last: ${when(lastSeenAt)})`,
    `Status: ${status}`,
    '',
    `**Detail:**`,
    gap.detail,
    '',
    `**Example issues:** ${(exampleIssueIds || []).slice(-5).map(id => '`' + id + '`').join(', ') || '—'}`,
  ];
  if (ownerPing) lines.push(`<@${ownerPing}>`);
  return lines.join('\n');
}

async function record({ gap, issueId, guild, firestore, ownerId, channelName }) {
  if (!gap?.title || !gap?.detail) return;
  const channel = findChannelByName(guild, channelName);
  const normalizedKey = normalizeKey(gap.title);
  const nowIso = new Date().toISOString();

  const existing = await firestore.getGapByKey(normalizedKey);

  if (existing) {
    // NOTE: 'shipped' and 'wont_do' statuses are intentionally never set by
    // this service — they are reserved for future admin lifecycle commands
    // (Spec B). Until then this branch is unreachable.
    if (existing.status === 'shipped' || existing.status === 'wont_do') {
      await firestore.updateGap(normalizedKey, {
        occurrenceCount: (existing.occurrenceCount || 0) + 1,
        lastSeenAt: nowIso,
      });
      return;
    }
    const newCount = (existing.occurrenceCount || 0) + 1;
    const newExamples = [...(existing.exampleIssueIds || []), issueId].slice(-5);
    await firestore.updateGap(normalizedKey, {
      occurrenceCount: newCount,
      lastSeenAt: nowIso,
      exampleIssueIds: newExamples,
      title: gap.title,
    });
    if (channel && existing.postMessageId) {
      try {
        const msg = await channel.messages.fetch(existing.postMessageId);
        const ownerPing = shouldRepingAtCount(newCount) ? ownerId : null;
        const content = buildEmbedContent({
          gap,
          occurrenceCount: newCount,
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: nowIso,
          status: existing.status || 'open',
          exampleIssueIds: newExamples,
          ownerPing,
        });
        await msg.edit({ content });
      } catch (err) {
        console.error('capabilityGap: edit failed', err.message);
      }
    }
    return;
  }

  let postMessageId = null;
  if (channel) {
    try {
      const content = buildEmbedContent({
        gap,
        occurrenceCount: 1,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        status: 'open',
        exampleIssueIds: [issueId],
        ownerPing: ownerId || null,
      });
      const posted = await channel.send({ content, allowedMentions: { users: ownerId ? [ownerId] : [] } });
      postMessageId = posted?.id || null;
    } catch (err) {
      console.error('capabilityGap: post failed', err.message);
    }
  }

  await firestore.createGap({
    title: gap.title,
    normalizedKey,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    occurrenceCount: 1,
    exampleIssueIds: [issueId],
    postMessageId,
    status: 'open',
  });
}

module.exports = { normalizeKey, shouldRepingAtCount, record };
