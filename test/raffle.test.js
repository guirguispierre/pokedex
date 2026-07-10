const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createRaffle,
  joinRaffle,
  leaveRaffle,
  pickWinner,
  cancelRaffle,
  buildRaffleComponents,
  buildRaffleEligibilityLine,
  buildRaffleMessagePayload,
  buildRaffleReplyPayload,
  buildRaffleStatus,
  formatEntrantList,
  hydrateRaffle,
  isRaffleInGuild,
  makeRaffleId,
  parseRaffleId,
  serializeRaffle,
} = require('../src/commands/raffle');

describe('raffle', () => {
  test('gives each user at most one ticket', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });

    assert.deepEqual(joinRaffle(raffle, { id: 'u1', username: 'Mia' }), { ok: true });
    assert.deepEqual(joinRaffle(raffle, { id: 'u1', username: 'Mia' }), { ok: false, reason: 'already_joined' });
    assert.equal(raffle.entrants.size, 1);
  });

  test('allows entrants to leave before the raffle ends', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });

    assert.deepEqual(leaveRaffle(raffle, 'u1'), { ok: false, reason: 'not_joined' });
    joinRaffle(raffle, { id: 'u1', username: 'Mia' });
    assert.deepEqual(leaveRaffle(raffle, 'u1'), { ok: true });
    assert.equal(raffle.entrants.size, 0);
  });

  test('picks one winner and ends the raffle', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });
    joinRaffle(raffle, { id: 'u1', username: 'Mia' });
    joinRaffle(raffle, { id: 'u2', username: 'Pierre' });

    const result = pickWinner(raffle, () => 0.75);

    assert.deepEqual(result, { ok: true, winnerId: 'u2' });
    assert.equal(raffle.winnerId, 'u2');
    assert.deepEqual(joinRaffle(raffle, { id: 'u3', username: 'Later' }), { ok: false, reason: 'ended' });
  });

  test('marks ended raffle with no entrants', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });

    assert.deepEqual(pickWinner(raffle), { ok: false, reason: 'no_entrants' });
    assert.ok(raffle.endedAt);
  });

  test('uses guild:message as the public raffle id while accepting message id fallback', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });
    raffle.guildId = 'guild123';

    assert.equal(makeRaffleId('message456', raffle), 'guild123:message456');
    assert.deepEqual(parseRaffleId('guild123:message456'), { guildId: 'guild123', messageId: 'message456' });
    assert.deepEqual(parseRaffleId('message456'), { guildId: null, messageId: 'message456' });
  });

  test('serializes and hydrates persistent raffle state', () => {
    const raffle = createRaffle({
      title: 'Prize',
      description: 'Desc',
      hostId: 'host',
      durationMinutes: 10,
      requiredRoleId: 'eligible',
      blockedRoleId: 'blocked',
      maxEntrants: 20,
      now: 1000,
    });
    raffle.guildId = 'guild';
    raffle.channelId = 'channel';
    joinRaffle(raffle, { id: 'u1', username: 'Mia' }, 2000, { roles: ['eligible'] });

    const saved = serializeRaffle('message', raffle);
    const hydrated = hydrateRaffle(saved);

    assert.equal(hydrated.messageId, 'message');
    assert.equal(hydrated.endsAt, 601000);
    assert.equal(hydrated.requiredRoleId, 'eligible');
    assert.equal(hydrated.blockedRoleId, 'blocked');
    assert.equal(hydrated.maxEntrants, 20);
    assert.deepEqual([...hydrated.entrants.keys()], ['u1']);
    assert.equal(hydrated.entrants.get('u1').joinedAt, 2000);
  });

  test('enforces eligibility controls before joining', () => {
    const raffle = createRaffle({
      title: 'Prize',
      description: 'Desc',
      hostId: 'host',
      requiredRoleId: 'eligible',
      blockedRoleId: 'blocked',
      maxEntrants: 1,
    });

    assert.deepEqual(joinRaffle(raffle, { id: 'u1' }, 1000, { roles: [] }), { ok: false, reason: 'missing_required_role' });
    assert.deepEqual(joinRaffle(raffle, { id: 'u1' }, 1000, { roles: ['eligible', 'blocked'] }), { ok: false, reason: 'blocked_role' });
    assert.deepEqual(joinRaffle(raffle, { id: 'u1' }, 1000, { roles: { cache: new Map([['eligible', {}]]) } }), { ok: true });
    assert.deepEqual(joinRaffle(raffle, { id: 'u2' }, 1000, { roles: ['eligible'] }), { ok: false, reason: 'full' });
  });

  test('guild-bound raffle ids cannot be used from another guild', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });
    raffle.guildId = 'guild-a';

    assert.equal(isRaffleInGuild(raffle, 'guild-a', 'guild-a'), true);
    assert.equal(isRaffleInGuild(raffle, 'guild-b', 'guild-a'), false);
    assert.equal(isRaffleInGuild(raffle, 'guild-b'), false);
  });

  test('renders ticket count and active buttons', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });
    joinRaffle(raffle, { id: 'u1', username: 'Mia' });

    assert.equal(buildRaffleStatus(raffle), '-# 🎟️ 1 entered');

    const components = buildRaffleComponents('message-id', raffle).map((component) => component.toJSON());
    assert.equal(components[0].type, 10);
    assert.equal(components[0].content, 'A new raffle has been opened!');
    assert.equal(components[1].type, 17);
    assert.equal(components[1].accent_color, 0x5865f2);
    assert.deepEqual(components[1].components.slice(0, 4).map((component) => component.type), [10, 10, 14, 10]);
    assert.equal(components[1].components[0].content, '# Prize');
    assert.equal(components[1].components[1].content, 'Desc');
    assert.equal(components[1].components[3].content, '-# 🎟️ 1 entered');

    const row = components[1].components[4];
    assert.deepEqual(row.components.map((button) => button.custom_id), [
      'raffle_join_message-id',
      'raffle_leave_message-id',
    ]);
  });

  test('renders eligibility controls without enabling mention parsing', () => {
    const raffle = createRaffle({
      title: '@everyone prize',
      description: 'Desc <@123>',
      hostId: 'host',
      requiredRoleId: 'eligible',
      blockedRoleId: 'blocked',
      maxEntrants: 2,
    });
    joinRaffle(raffle, { id: 'u1' }, 1000, { roles: ['eligible'] });

    assert.equal(buildRaffleStatus(raffle), '-# 🎟️ 1/2 entered');
    assert.equal(buildRaffleEligibilityLine(raffle), '-# Eligibility: requires <@&eligible> • excludes <@&blocked> • max 2 entrants');

    const payload = buildRaffleMessagePayload('message-id', raffle);
    assert.deepEqual(payload.allowedMentions, { parse: [] });

    const components = payload.components.map((component) => component.toJSON());
    assert.equal(components[1].components[2].content, '-# Eligibility: requires <@&eligible> • excludes <@&blocked> • max 2 entrants');
  });

  test('formats entrant lists for moderator inspection', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });
    joinRaffle(raffle, { id: 'u2' }, 2000);
    joinRaffle(raffle, { id: 'u1' }, 1000);

    assert.equal(
      formatEntrantList(raffle),
      '**Prize** has 2 entrants:\n1. <@u1> — joined <t:1:R>\n2. <@u2> — joined <t:2:R>',
    );
  });

  test('suppresses mention parsing for raffle reply payloads', () => {
    const payload = buildRaffleReplyPayload('Picked winner for **@everyone prize**: <@winner>');

    assert.deepEqual(payload, {
      content: 'Picked winner for **@everyone prize**: <@winner>',
      allowedMentions: { parse: [] },
    });
  });

  test('after a winner is picked, join and leave buttons are removed', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });
    joinRaffle(raffle, { id: 'u1', username: 'Mia' });
    pickWinner(raffle);

    const components = buildRaffleComponents('message-id', raffle).map((component) => component.toJSON());
    assert.equal(components[1].accent_color, 0x2ecc71);
    assert.equal(components[1].components.some((component) => component.type === 1), false);
    assert.equal(components[1].components[3].content, '-# 🎟️ 1 entered • winner <@u1>');
  });

  test('renders one full-width media gallery image when provided', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host', imageUrl: 'https://example.com/prize.png' });

    const components = buildRaffleComponents('message-id', raffle).map((component) => component.toJSON());
    const gallery = components[1].components.find((component) => component.type === 12);
    assert.equal(gallery.items.length, 1);
    assert.equal(gallery.items[0].media.url, 'https://example.com/prize.png');
  });

  test('reroll picks a different winner when another entrant exists', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });
    joinRaffle(raffle, { id: 'u1', username: 'Mia' });
    joinRaffle(raffle, { id: 'u2', username: 'Pierre' });
    pickWinner(raffle, () => 0);

    assert.deepEqual(pickWinner(raffle, () => 0, Date.now(), { reroll: true }), { ok: true, winnerId: 'u2' });
  });

  test('cancel ends raffle without reroll controls', () => {
    const raffle = createRaffle({ title: 'Prize', description: 'Desc', hostId: 'host' });

    assert.deepEqual(cancelRaffle(raffle), { ok: true });
    const components = buildRaffleComponents('message-id', raffle).map((component) => component.toJSON());
    assert.equal(components[1].accent_color, 0xe74c3c);
    assert.equal(components[1].components.some((component) => component.type === 1), false);
    assert.equal(components[1].components[3].content, '-# 🎟️ 0 entered • canceled');
  });
});
