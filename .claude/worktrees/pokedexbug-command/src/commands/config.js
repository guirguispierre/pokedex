const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config/config');

const commandData = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Manage bot configuration')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName('set')
      .setDescription('Set a config value')
      .addStringOption(opt => opt.setName('key').setDescription('Config key').setRequired(true))
      .addStringOption(opt => opt.setName('value').setDescription('Config value').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('get')
      .setDescription('Get a config value')
      .addStringOption(opt => opt.setName('key').setDescription('Config key').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('reset')
      .setDescription('Reset a config key to default')
      .addStringOption(opt => opt.setName('key').setDescription('Config key').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('Show all config values')
  );

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const key = interaction.options.getString('key');
    let value = interaction.options.getString('value');

    if (value.length > 500) {
      return interaction.reply({ content: 'Config value too long (max 500 characters).', ephemeral: true });
    }

    // Parse booleans and arrays
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value.includes(',')) value = value.split(',').map(s => s.trim()).filter(s => s.length > 0);

    try {
      await config.setConfigOverride(key, value, interaction.user.id);
      await interaction.reply({ content: `Set \`${key}\` = \`${JSON.stringify(value)}\``, ephemeral: true });
    } catch (err) {
      const safeMsg = err.message?.startsWith('Unknown config key') ? err.message : 'Failed to update config.';
      await interaction.reply({ content: safeMsg, ephemeral: true });
    }
  }

  if (sub === 'get') {
    const key = interaction.options.getString('key');
    const value = config.getConfig(key);
    if (value === undefined) {
      await interaction.reply({ content: `Unknown key: \`${key}\``, ephemeral: true });
    } else {
      await interaction.reply({ content: `\`${key}\` = \`${JSON.stringify(value)}\``, ephemeral: true });
    }
  }

  if (sub === 'reset') {
    const key = interaction.options.getString('key');
    try {
      await config.resetConfigOverride(key);
      await interaction.reply({ content: `Reset \`${key}\` to default`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `Error: ${err.message}`, ephemeral: true });
    }
  }

  if (sub === 'list') {
    const all = config.getAllConfig();
    const lines = Object.entries(all).map(([k, v]) => `\`${k}\`: ${JSON.stringify(v)}`);
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }
}

module.exports = { data: commandData, execute };