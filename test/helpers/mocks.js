// Shared mock factories for unit tests. No network, no secrets.

function fakeFirestore({ issues = [], gaps = [] } = {}) {
  const issuesById = new Map(issues.map(i => [i.id, { ...i }]));
  const gapsByKey = new Map(gaps.map(g => [g.normalizedKey, { ...g }]));

  return {
    async getOpenIssues(limit = 100) {
      return Array.from(issuesById.values())
        .filter(i => (i.status || 'open') === 'open')
        .slice(0, limit);
    },
    async getIssueById(id) {
      const i = issuesById.get(id);
      return i ? { ...i } : null;
    },
    async saveIssue(data) {
      const id = `issue_${issuesById.size + 1}`;
      issuesById.set(id, { id, status: 'open', ...data });
      return id;
    },
    async updateIssueFields(id, fields) {
      const existing = issuesById.get(id);
      if (!existing) throw new Error(`no issue ${id}`);
      issuesById.set(id, { ...existing, ...fields });
    },
    async getGapByKey(key) {
      const g = gapsByKey.get(key);
      return g ? { ...g } : null;
    },
    async createGap(data) {
      const id = `gap_${gapsByKey.size + 1}`;
      gapsByKey.set(data.normalizedKey, { id, ...data });
      return id;
    },
    async updateGap(key, fields) {
      const existing = gapsByKey.get(key);
      if (!existing) throw new Error(`no gap ${key}`);
      gapsByKey.set(key, { ...existing, ...fields });
    },
    _issuesById: issuesById,
    _gapsByKey: gapsByKey,
  };
}

function fakeChannel({ id = 'chan1', name = 'general', messages = [] } = {}) {
  return {
    id,
    name,
    isTextBased: () => true,
    messages: {
      fetch: async ({ limit = 50 } = {}) => {
        const msgs = messages.slice(-limit);
        return {
          size: msgs.length,
          values: () => msgs[Symbol.iterator](),
          [Symbol.iterator]: () => msgs[Symbol.iterator](),
          last: () => msgs[msgs.length - 1],
          first: () => msgs[0],
        };
      },
    },
    send: async (payload) => ({ id: `msg_${Date.now()}`, edit: async () => {}, payload }),
  };
}

function fakeGuild({ channels = [] } = {}) {
  const cache = new Map(channels.map(c => [c.id, c]));
  return {
    channels: {
      cache: {
        find: (predicate) => {
          for (const c of cache.values()) if (predicate(c)) return c;
          return null;
        },
        get: (id) => cache.get(id) || null,
        values: () => cache.values(),
      },
      fetch: async (id) => cache.get(id) || null,
    },
  };
}

function fakeMessage({
  id = 'm1',
  content = '',
  authorId = 'u1',
  authorUsername = 'tester',
  isBot = false,
  attachments = [],
  reference = null,
  channelId = 'chan1',
  createdAt = new Date(),
} = {}) {
  return {
    id,
    content,
    author: { id: authorId, username: authorUsername, bot: isBot },
    attachments: new Map(attachments.map((a, i) => [`att${i}`, a])),
    reference,
    channel: { id: channelId },
    createdAt,
    createdTimestamp: createdAt.getTime(),
    reply: async (payload) => ({ id: `reply_${Date.now()}`, payload }),
    react: async () => {},
  };
}

function fakeOpenRouterResponder(sequence) {
  // sequence: [{ tool_calls: [...] } | { content: '<json string>' } | Error]
  // Returns an object shaped like the real openrouter module: { callWithTools }.
  let i = 0;
  return {
    callWithTools: async () => {
      if (i >= sequence.length) throw new Error('responder exhausted');
      const item = sequence[i++];
      if (item instanceof Error) throw item;
      return item;
    },
  };
}

module.exports = {
  fakeFirestore,
  fakeChannel,
  fakeGuild,
  fakeMessage,
  fakeOpenRouterResponder,
};
