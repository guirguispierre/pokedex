async function readChannel(args, ctx) {
  const channelId = ctx?.channelId;
  if (!channelId || !ctx?.guild) return [];

  const requested = Number(args?.limit) || 20;
  const limit = Math.max(1, Math.min(50, requested));

  let channel;
  try {
    channel = ctx.guild.channels.cache.get(channelId)
      || (await ctx.guild.channels.fetch(channelId).catch(() => null));
  } catch {
    return [];
  }
  if (!channel || typeof channel.messages?.fetch !== 'function') return [];

  let batch;
  try {
    batch = await channel.messages.fetch({ limit });
  } catch {
    return [];
  }

  const out = [];
  for (const m of batch.values ? batch.values() : batch) {
    if (m.author?.bot) continue; // Skip bot's own messages — they aren't useful as channel context
    const attachmentsList = m.attachments
      ? (typeof m.attachments.values === 'function' ? Array.from(m.attachments.values()) : [])
      : [];
    out.push({
      author: m.author?.username || 'unknown',
      content: String(m.content || '').slice(0, 500),
      createdAt: m.createdAt?.toISOString?.() || null,
      hasImage: attachmentsList.some(a => (a.contentType || '').startsWith('image/')),
    });
  }
  return out;
}

const schema = {
  type: 'function',
  function: {
    name: 'read_channel_context',
    description: 'Read the last N messages from the channel this report came from. Useful for seeing whether other users are complaining about the same thing right now.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max messages (1-50).', default: 20 },
      },
    },
  },
};

module.exports = { readChannel, schema };
