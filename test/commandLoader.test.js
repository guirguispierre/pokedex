const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCommands, toRegistrationBody } = require('../src/commandLoader');

// The exact set of command names. This locks the dispatch surface: changes must
// be intentional, not accidental side effects of the autoloader.
const EXPECTED_NAMES = [
  'Add to Pokedex context', 'Exclude from Pokedex',
  'addcontext', 'afk', 'automod', 'autoscrape', 'backfill-numbers', 'ban',
  'changelog', 'color', 'config', 'creator', 'deletethread', 'exclude',
  'feedback', 'feedback-triage', 'giveaway', 'help', 'issue', 'kick',
  'leaderboard', 'level', 'lock', 'lockall', 'merge', 'mute', 'ping',
  'pokedexbug', 'poll', 'purge', 'raffle', 'reactionrole', 'recipes',
  'serverinfo', 'slowmode', 'starboard', 'status', 'suggest',
  'unlock', 'unlockall', 'unmute', 'warn', 'welcome',
].sort();

// Commands that expose an autocomplete handler — must match the old hardcoded subset.
const EXPECTED_AUTOCOMPLETE = [
  'automod', 'config', 'feedback-triage', 'giveaway', 'issue', 'merge',
  'raffle', 'recipes', 'suggest', 'warn',
].sort();

test('loadCommands loads every command keyed by data.name with an execute()', () => {
  const map = loadCommands();
  for (const [name, cmd] of map) {
    assert.equal(typeof name, 'string');
    assert.equal(cmd.data.name, name, `map key must equal data.name for ${name}`);
    assert.equal(typeof cmd.execute, 'function', `${name} must export execute()`);
  }
});

test('loadCommands produces exactly the previously-wired command surface', () => {
  const map = loadCommands();
  assert.deepEqual([...map.keys()].sort(), EXPECTED_NAMES);
});

test('autocomplete-capable commands match the old hardcoded subset', () => {
  const map = loadCommands();
  const withAutocomplete = [...map.values()]
    .filter(c => typeof c.autocomplete === 'function')
    .map(c => c.data.name)
    .sort();
  assert.deepEqual(withAutocomplete, EXPECTED_AUTOCOMPLETE);
});

test('commands may opt out of Firebase gating when they have local fallbacks', () => {
  const map = loadCommands();
  assert.equal(map.get('raffle').requiresFirebase, false);
});

test('toRegistrationBody returns one JSON payload per command', () => {
  const map = loadCommands();
  const body = toRegistrationBody(map);
  assert.equal(body.length, map.size);
  for (const entry of body) {
    assert.equal(typeof entry.name, 'string');
  }
  // Every registered payload name round-trips back to a loaded command.
  assert.deepEqual(body.map(e => e.name).sort(), EXPECTED_NAMES);
});
