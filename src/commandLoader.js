const fs = require('fs');
const path = require('path');

// Auto-loads every command module in the commands directory into a Map keyed by
// the registered command name (`data.name`) — which is exactly what
// `interaction.commandName` matches for BOTH slash commands and context-menu
// commands. Each command module exports `{ data, execute, autocomplete? }` (plus,
// for some, extra event-handler functions that index.js looks up by name).
//
// Building this map once at startup replaces the old hand-maintained trio in
// index.js: ~46 manual requires, the registration array, and the dispatch map
// literal that was rebuilt on every interaction.
function loadCommands(dir = path.join(__dirname, 'commands')) {
  const map = new Map();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    const source = fs.readFileSync(filePath, 'utf-8');
    const mod = require(filePath);
    if (!mod || !mod.data || typeof mod.data.name !== 'string') {
      throw new Error(`Command file ${file} must export { data } with a string name`);
    }
    if (typeof mod.execute !== 'function') {
      throw new Error(`Command file ${file} must export an execute() function`);
    }
    if (map.has(mod.data.name)) {
      throw new Error(`Duplicate command name "${mod.data.name}" (from ${file})`);
    }
    if (typeof mod.requiresFirebase !== 'boolean') {
      mod.requiresFirebase = /firebase-admin|services\/firestore|\.\.\/services\/firestore/.test(source);
    }
    if (typeof mod.requiresOpenRouter !== 'boolean') {
      mod.requiresOpenRouter = /OPENROUTER_API_KEY|services\/openrouter|\.\.\/services\/openrouter|services\/duplicates|\.\.\/services\/duplicates|services\/recipeTagger|\.\.\/services\/recipeTagger/.test(source);
    }
    map.set(mod.data.name, mod);
  }
  return map;
}

// Discord registration payload for all loaded commands, derived from the map so it
// can never drift from what actually dispatches.
function toRegistrationBody(commandMap) {
  return [...commandMap.values()].map(cmd => cmd.data.toJSON());
}

module.exports = { loadCommands, toRegistrationBody };
