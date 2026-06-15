const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { safeInteractionReply } = require('../src/utils/safeInteractionReply');

function makeFn(behavior) {
  const fn = (...args) => {
    fn.calls.push(args);
    return behavior();
  };
  fn.calls = [];
  return fn;
}

function makeInteraction({ deferred = false, replied = false, methodBehavior = 'resolve' } = {}) {
  const behavior = methodBehavior === 'reject'
    ? () => Promise.reject(new Error('Unknown interaction'))
    : () => Promise.resolve();

  return {
    deferred,
    replied,
    reply: makeFn(behavior),
    editReply: makeFn(behavior),
    followUp: makeFn(behavior),
  };
}

describe('safeInteractionReply', () => {
  test('uses reply() with ephemeral flag when interaction is fresh', async () => {
    const interaction = makeInteraction();

    await safeInteractionReply(interaction, 'An error occurred.');

    assert.equal(interaction.reply.calls.length, 1);
    assert.deepEqual(interaction.reply.calls[0][0], {
      content: 'An error occurred.',
      flags: MessageFlags.Ephemeral,
    });
    assert.equal(interaction.editReply.calls.length, 0);
    assert.equal(interaction.followUp.calls.length, 0);
  });

  test('uses editReply() when interaction was deferred but not yet replied', async () => {
    const interaction = makeInteraction({ deferred: true });

    await safeInteractionReply(interaction, 'An error occurred.');

    assert.equal(interaction.editReply.calls.length, 1);
    assert.deepEqual(interaction.editReply.calls[0][0], { content: 'An error occurred.' });
    assert.equal(interaction.reply.calls.length, 0);
    assert.equal(interaction.followUp.calls.length, 0);
  });

  test('uses followUp() with ephemeral flag when interaction was already replied', async () => {
    const interaction = makeInteraction({ replied: true });

    await safeInteractionReply(interaction, 'An error occurred.');

    assert.equal(interaction.followUp.calls.length, 1);
    assert.deepEqual(interaction.followUp.calls[0][0], {
      content: 'An error occurred.',
      flags: MessageFlags.Ephemeral,
    });
    assert.equal(interaction.reply.calls.length, 0);
    assert.equal(interaction.editReply.calls.length, 0);
  });

  test('does NOT use deprecated `ephemeral: true` option', async () => {
    const interaction = makeInteraction();

    await safeInteractionReply(interaction, 'hi');

    const args = interaction.reply.calls[0][0];
    assert.ok(!('ephemeral' in args));
    assert.equal(args.flags, MessageFlags.Ephemeral);
  });

  test('does not throw when reply() rejects (e.g. Unknown interaction)', async () => {
    const interaction = makeInteraction({ methodBehavior: 'reject' });

    const result = await safeInteractionReply(interaction, 'err');
    assert.equal(result, undefined);
  });

  test('does not throw when editReply() rejects (e.g. Interaction expired)', async () => {
    const interaction = makeInteraction({ deferred: true, methodBehavior: 'reject' });

    const result = await safeInteractionReply(interaction, 'err');
    assert.equal(result, undefined);
  });

  test('does not throw when followUp() rejects (e.g. Interaction already acknowledged)', async () => {
    const interaction = makeInteraction({ replied: true, methodBehavior: 'reject' });

    const result = await safeInteractionReply(interaction, 'err');
    assert.equal(result, undefined);
  });
});
