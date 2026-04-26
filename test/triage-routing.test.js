const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config/config');
const { fakeChannel, fakeGuild } = require('./helpers/mocks');

describe('triage-routing', () => {
  before(async () => {
    // Load config.json defaults without Firestore.
    config.setFirestoreService({ getAllConfigOverrides: async () => ({}) });
    await config.init();
  });

  test('poke_product target → eng-triage channel', () => {
    const { findTriageChannel } = require('../src/services/triage');
    const eng = fakeChannel({ id: 'e1', name: 'eng-triage' });
    const pok = fakeChannel({ id: 'p1', name: 'pokedex-testing' });
    const guild = fakeGuild({ channels: [eng, pok] });
    const out = findTriageChannel(guild, 'poke_product');
    assert.equal(out?.name, 'eng-triage');
  });

  test('pokedex_bot target → pokedex-testing channel', () => {
    const { findTriageChannel } = require('../src/services/triage');
    const eng = fakeChannel({ id: 'e1', name: 'eng-triage' });
    const pok = fakeChannel({ id: 'p1', name: 'pokedex-testing' });
    const guild = fakeGuild({ channels: [eng, pok] });
    const out = findTriageChannel(guild, 'pokedex_bot');
    assert.equal(out?.name, 'pokedex-testing');
  });

  test('falls back to eng-triage when pokedex-testing missing', () => {
    const { findTriageChannel } = require('../src/services/triage');
    const eng = fakeChannel({ id: 'e1', name: 'eng-triage' });
    const guild = fakeGuild({ channels: [eng] });
    const out = findTriageChannel(guild, 'pokedex_bot');
    assert.equal(out?.name, 'eng-triage');
  });

  test('no target defaults to poke_product behavior', () => {
    const { findTriageChannel } = require('../src/services/triage');
    const eng = fakeChannel({ id: 'e1', name: 'eng-triage' });
    const guild = fakeGuild({ channels: [eng] });
    const out = findTriageChannel(guild);
    assert.equal(out?.name, 'eng-triage');
  });
});
