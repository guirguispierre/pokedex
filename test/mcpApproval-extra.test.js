const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { canModerate } = require('../src/services/mcpApproval');

function memberWith(flags) {
  return {
    permissions: {
      has: (flag) => (BigInt(flags) & BigInt(flag)) !== 0n,
    },
  };
}

describe('canModerate', () => {
  test('returns true when member has ManageMessages', () => {
    assert.equal(canModerate(memberWith(PermissionFlagsBits.ManageMessages)), true);
  });

  test('returns false when member lacks ManageMessages', () => {
    assert.equal(canModerate(memberWith(0n)), false);
  });

  test('returns false for null/undefined member', () => {
    assert.equal(canModerate(null), false);
    assert.equal(canModerate(undefined), false);
  });

  test('returns false when member has no permissions object', () => {
    assert.equal(canModerate({}), false);
  });
});
