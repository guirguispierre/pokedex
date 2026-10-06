const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  dayKeyUTC,
  buildXPChartPoints,
  renderXPChartSVG,
} = require('../src/utils/xpChart');

// ---------- pure helpers ----------

describe('xpChart helpers', () => {
  test('dayKeyUTC returns YYYY-MM-DD in UTC', () => {
    assert.equal(dayKeyUTC(Date.UTC(2026, 9, 6, 23, 59)), '2026-10-06');
    assert.equal(dayKeyUTC(Date.UTC(2026, 0, 1)), '2026-01-01');
  });

  test('buildXPChartPoints: empty doc yields only today\'s point', () => {
    const now = Date.UTC(2026, 9, 6, 12);
    const points = buildXPChartPoints({ xp: 0, messages: 0 }, 0, now);
    assert.deepEqual(points, [{ day: '2026-10-06', xp: 0 }]);
  });

  test('buildXPChartPoints: sorts days and upserts today with live totalXP', () => {
    const now = Date.UTC(2026, 9, 6, 12);
    const data = {
      xpByDay: {
        '2026-10-05': 300,
        '2026-10-04': 150,
        '2026-10-06': 280, // stale morning snapshot — should be overwritten
      },
    };
    const points = buildXPChartPoints(data, 320, now);
    assert.deepEqual(points, [
      { day: '2026-10-04', xp: 150 },
      { day: '2026-10-05', xp: 300 },
      { day: '2026-10-06', xp: 320 },
    ]);
  });

  test('buildXPChartPoints: ignores malformed keys and non-finite values', () => {
    const now = Date.UTC(2026, 9, 6, 12);
    const data = {
      xpByDay: {
        'not-a-date': 50,
        '2026-10-05': 'oops',
        '2026-10-04': -5,
        '2026-10-03': 100,
      },
    };
    const points = buildXPChartPoints(data, 120, now);
    assert.deepEqual(points, [
      { day: '2026-10-03', xp: 100 },
      { day: '2026-10-06', xp: 120 },
    ]);
  });

  test('buildXPChartPoints: caps history at 30 days', () => {
    const now = Date.UTC(2026, 9, 6, 12);
    const xpByDay = {};
    for (let i = 1; i <= 40; i++) {
      const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      xpByDay[d] = 1000 - i;
    }
    const points = buildXPChartPoints({ xpByDay }, 1000, now);
    assert.equal(points.length, 30);
    assert.equal(points[points.length - 1].day, '2026-10-06');
  });

  test('renderXPChartSVG: emits a well-formed text-free svg', () => {
    const points = [
      { day: '2026-10-04', xp: 100 },
      { day: '2026-10-05', xp: 180 },
      { day: '2026-10-06', xp: 320 },
    ];
    const svg = renderXPChartSVG(points);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<polyline/);
    assert.match(svg, /<\/svg>$/);
    assert.equal(svg.includes('<text'), false);
    assert.equal(svg.includes('NaN'), false);
  });

  test('renderXPChartSVG: flat xp does not produce NaN coordinates', () => {
    const svg = renderXPChartSVG([{ day: '2026-10-06', xp: 42 }]);
    assert.equal(svg.includes('NaN'), false);
  });
});

// ---------- command behaviour with mocked firebase-admin ----------

function makeFakeAdmin(store = new Map()) {
  const docRef = (collName, id) => ({
    _key: `${collName}/${id}`,
    async get() {
      const data = store.get(`${collName}/${id}`);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data, options = {}) {
      const prev = options.merge ? store.get(`${collName}/${id}`) || {} : {};
      store.set(`${collName}/${id}`, {
        ...prev,
        ...data,
        xpByDay: { ...(prev.xpByDay || {}), ...(data.xpByDay || {}) },
      });
    },
  });
  const firestore = () => ({ collection: (name) => ({ doc: (id) => docRef(name, id) }) });
  firestore.FieldValue = { serverTimestamp: () => 'SERVER_TS' };
  return { firestore, _store: store };
}

// Same require.cache injection pattern as test/hard-lockdown.test.js.
function loadLevelWith(adminMock) {
  const adminPath = require.resolve('firebase-admin');
  const levelPath = require.resolve('../src/commands/level');
  const prevAdmin = require.cache[adminPath];
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: adminMock,
  };
  delete require.cache[levelPath];
  const level = require('../src/commands/level');
  if (prevAdmin) require.cache[adminPath] = prevAdmin;
  else delete require.cache[adminPath];
  delete require.cache[levelPath];
  return level;
}

function fakeInteraction() {
  const replies = [];
  return {
    replies,
    user: { id: 'u1', username: 'tester', displayAvatarURL: () => 'https://x/ava.png' },
    guild: { id: 'g1' },
    options: {
      getSubcommand: () => 'check',
      getUser: () => null,
    },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  };
}

describe('/level check XP chart', () => {
  test('attaches xp-chart.png when doc has >= 2 days of history', async () => {
    const store = new Map();
    const level = loadLevelWith(makeFakeAdmin(store));
    const docId = 'g1_u1';
    const data = {
      userId: 'u1', guildId: 'g1', xp: 320, messages: 40, username: 'tester',
      xpByDay: { '2026-10-04': 100, '2026-10-05': 180 },
    };
    store.set(`levels/${docId}`, data);
    const interaction = fakeInteraction();
    await level.execute(interaction);
    assert.equal(interaction.replies.length, 1);
    const reply = interaction.replies[0];
    assert.equal(reply.files.length, 1);
    assert.equal(reply.files[0].name, 'xp-chart.png');
    assert.equal(reply.embeds[0].data.image.url, 'attachment://xp-chart.png');
    assert.match(reply.embeds[0].data.footer.text, /XP over the last \d+ days/);
  });

  test('omits chart and adds collecting footer when < 2 days of history', async () => {
    const store = new Map();
    const level = loadLevelWith(makeFakeAdmin(store));
    store.set('levels/g1_u1', { userId: 'u1', guildId: 'g1', xp: 60, messages: 3 });
    const interaction = fakeInteraction();
    await level.execute(interaction);
    const reply = interaction.replies[0];
    assert.equal(reply.files.length, 0);
    assert.equal(reply.embeds[0].data.image, undefined);
    assert.match(reply.embeds[0].data.footer.text, /check back tomorrow/);
  });

  test('awardXP writes cumulative xpByDay for today', async () => {
    const store = new Map();
    const level = loadLevelWith(makeFakeAdmin(store));
    const today = dayKeyUTC(Date.now());
    const message = {
      author: { id: 'u9', username: 'grinder', bot: false },
      guild: { id: 'g9' },
      channel: { send: async () => {} },
    };
    await level.awardXP(message);
    const doc = store.get('levels/g9_u9');
    assert.ok(doc, 'level doc written');
    assert.equal(doc.userId, 'u9');
    assert.equal(doc.messages, 1);
    assert.equal(doc.xpByDay[today], doc.xp);
    assert.ok(doc.xp >= 15 && doc.xp <= 25);

    // second call within the cooldown writes nothing new
    await level.awardXP(message);
    assert.equal(store.get('levels/g9_u9').messages, 1);
  });

  test('awardXP accumulates xpByDay across an existing doc', async () => {
    const store = new Map();
    store.set('levels/g8_u8', {
      userId: 'u8', guildId: 'g8', xp: 500, messages: 30,
      xpByDay: { '2026-01-01': 480 },
    });
    const level = loadLevelWith(makeFakeAdmin(store));
    const today = dayKeyUTC(Date.now());
    await level.awardXP({
      author: { id: 'u8', username: 'vet', bot: false },
      guild: { id: 'g8' },
      channel: { send: async () => {} },
    });
    const doc = store.get('levels/g8_u8');
    assert.equal(doc.xpByDay['2026-01-01'], 480); // history preserved
    assert.equal(doc.xpByDay[today], doc.xp);     // today = cumulative total
    assert.ok(doc.xp > 500);
  });
});
