const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const pingCommand = require('../src/commands/ping');

function makeFn(impl = () => Promise.resolve()) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

function makeInteraction(overrides = {}) {
  return {
    createdTimestamp: 1_000_000,
    client: {
      ws: { ping: 42 },
      guilds: { cache: { size: 3 } },
    },
    deferReply: makeFn(),
    editReply: makeFn(),
    ...overrides,
  };
}

describe('/ping command', () => {
  test('calls deferReply WITHOUT the deprecated `fetchReply` option', async () => {
    const interaction = makeInteraction();

    await pingCommand.execute(interaction);

    assert.equal(interaction.deferReply.calls.length, 1);
    const arg = interaction.deferReply.calls[0][0];
    // Either called with no args, or with an options object that has no
    // `fetchReply` key (deprecated since discord.js v14.17 / removed v15).
    if (arg !== undefined) {
      assert.ok(!('fetchReply' in arg));
    }
  });

  test('computes roundtrip from current time minus interaction.createdTimestamp', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_250 });
    const interaction = makeInteraction({ createdTimestamp: 1_000_000 });

    await pingCommand.execute(interaction);

    const { embeds } = interaction.editReply.calls[0][0];
    const roundtripField = embeds[0].data.fields.find(f => f.name.includes('Roundtrip'));
    assert.equal(roundtripField.value, '250ms');
  });

  test('sends an embed with pong title, ws ping, and guild count', async () => {
    const interaction = makeInteraction();

    await pingCommand.execute(interaction);

    assert.equal(interaction.editReply.calls.length, 1);
    const { embeds, components } = interaction.editReply.calls[0][0];
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0].data.title, '🏓 Pong!');
    const wsField = embeds[0].data.fields.find(f => f.name.includes('WebSocket'));
    assert.equal(wsField.value, '42ms');
    const serversField = embeds[0].data.fields.find(f => f.name.includes('Servers'));
    assert.equal(serversField.value, '3');
    assert.equal(components.length, 1);
  });
});
