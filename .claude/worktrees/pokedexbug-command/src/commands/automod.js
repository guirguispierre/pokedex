const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const automod = require('../services/automod');

const commandData = new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Configure automatic moderation')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  // enable / disable
  .addSubcommand(sub =>
    sub.setName('enable')
      .setDescription('Enable auto-moderation'))
  .addSubcommand(sub =>
    sub.setName('disable')
      .setDescription('Disable auto-moderation'))
  // config — view current settings
  .addSubcommand(sub =>
    sub.setName('config')
      .setDescription('View current auto-moderation settings'))
  // log channel
  .addSubcommand(sub =>
    sub.setName('log')
      .setDescription('Set the mod log channel')
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('Channel for automod logs')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)))
  // dm toggle
  .addSubcommand(sub =>
    sub.setName('dm')
      .setDescription('Toggle DM notifications to users on automod actions')
      .addBooleanOption(opt =>
        opt.setName('enabled')
          .setDescription('Send DMs to users?')
          .setRequired(true)))
  // thresholds
  .addSubcommand(sub =>
    sub.setName('thresholds')
      .setDescription('Configure spam detection thresholds')
      .addIntegerOption(opt =>
        opt.setName('max_messages')
          .setDescription('Max messages per window (default: 5)')
          .setMinValue(2).setMaxValue(20))
      .addIntegerOption(opt =>
        opt.setName('window_seconds')
          .setDescription('Time window in seconds (default: 3)')
          .setMinValue(1).setMaxValue(30))
      .addIntegerOption(opt =>
        opt.setName('max_duplicates')
          .setDescription('Max duplicate messages (default: 3)')
          .setMinValue(2).setMaxValue(10))
      .addIntegerOption(opt =>
        opt.setName('max_mentions')
          .setDescription('Max mentions per message (default: 5)')
          .setMinValue(1).setMaxValue(25))
      .addIntegerOption(opt =>
        opt.setName('caps_percent')
          .setDescription('Caps threshold % (default: 70)')
          .setMinValue(50).setMaxValue(100)))
  // raid settings
  .addSubcommand(sub =>
    sub.setName('raid')
      .setDescription('Configure raid protection')
      .addIntegerOption(opt =>
        opt.setName('join_count')
          .setDescription('Joins to trigger raid alert (default: 10)')
          .setMinValue(3).setMaxValue(50))
      .addIntegerOption(opt =>
        opt.setName('window_seconds')
          .setDescription('Time window in seconds (default: 10)')
          .setMinValue(5).setMaxValue(60))
      .addBooleanOption(opt =>
        opt.setName('auto_kick')
          .setDescription('Auto-kick new joins during raid?')))
  // blocklist management
  .addSubcommandGroup(group =>
    group.setName('blocklist')
      .setDescription('Manage blocked words/phrases')
      .addSubcommand(sub =>
        sub.setName('add')
          .setDescription('Add a word/phrase to the blocklist')
          .addStringOption(opt =>
            opt.setName('word')
              .setDescription('Word or phrase to block')
              .setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('remove')
          .setDescription('Remove a word/phrase from the blocklist')
          .addStringOption(opt =>
            opt.setName('word')
              .setDescription('Word or phrase to unblock')
              .setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('list')
          .setDescription('View all blocked words/phrases')))
  // link management
  .addSubcommandGroup(group =>
    group.setName('links')
      .setDescription('Manage link allowlist/blocklist')
      .addSubcommand(sub =>
        sub.setName('allow')
          .setDescription('Add a domain to the allowlist')
          .addStringOption(opt =>
            opt.setName('domain')
              .setDescription('Domain to allow (e.g. github.com)')
              .setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('block')
          .setDescription('Add a domain to the blocklist')
          .addStringOption(opt =>
            opt.setName('domain')
              .setDescription('Domain to block')
              .setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('remove')
          .setDescription('Remove a domain from allow/blocklist')
          .addStringOption(opt =>
            opt.setName('domain')
              .setDescription('Domain to remove')
              .setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('list')
          .setDescription('View link allowlist and blocklist')))
  // exemptions
  .addSubcommandGroup(group =>
    group.setName('exempt')
      .setDescription('Manage automod exemptions')
      .addSubcommand(sub =>
        sub.setName('add')
          .setDescription('Exempt a role or channel from automod')
          .addRoleOption(opt =>
            opt.setName('role')
              .setDescription('Role to exempt'))
          .addChannelOption(opt =>
            opt.setName('channel')
              .setDescription('Channel to exempt')
              .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand(sub =>
        sub.setName('remove')
          .setDescription('Remove an exemption')
          .addRoleOption(opt =>
            opt.setName('role')
              .setDescription('Role to un-exempt'))
          .addChannelOption(opt =>
            opt.setName('channel')
              .setDescription('Channel to un-exempt')
              .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand(sub =>
        sub.setName('list')
          .setDescription('View all exemptions')));

async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group === 'blocklist') return handleBlocklist(interaction, sub);
  if (group === 'links') return handleLinks(interaction, sub);
  if (group === 'exempt') return handleExempt(interaction, sub);

  if (sub === 'enable') return handleToggle(interaction, true);
  if (sub === 'disable') return handleToggle(interaction, false);
  if (sub === 'config') return handleConfig(interaction);
  if (sub === 'log') return handleLog(interaction);
  if (sub === 'dm') return handleDm(interaction);
  if (sub === 'thresholds') return handleThresholds(interaction);
  if (sub === 'raid') return handleRaid(interaction);
}

async function handleToggle(interaction, enabled) {
  await interaction.deferReply({ ephemeral: true });
  await automod.updateAutomodConfig({ enabled });
  const emoji = enabled ? '✅' : '⛔';
  await interaction.editReply(`${emoji} Auto-moderation **${enabled ? 'enabled' : 'disabled'}**.`);
}

async function handleConfig(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const config = await automod.getAutomodConfig();
  const blocklist = await automod.getBlocklist();
  const linkConfig = await automod.getLinkConfig();
  const exemptions = await automod.getExemptions();

  const embed = new EmbedBuilder()
    .setTitle('🛡️ AutoMod Configuration')
    .setColor(config.enabled ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: 'Status', value: config.enabled ? '✅ Enabled' : '⛔ Disabled', inline: true },
      { name: 'Log Channel', value: config.logChannel ? `<#${config.logChannel}>` : 'Not set', inline: true },
      { name: 'DM on Action', value: config.dmOnAction ? 'Yes' : 'No', inline: true },
      { name: 'Spam Thresholds', value: [
        `Messages: ${config.maxMessagesPerWindow}/${config.messageWindowMs / 1000}s`,
        `Duplicates: ${config.maxDuplicates}/${config.duplicateWindowMs / 1000}s`,
        `Max mentions: ${config.maxMentionsPerMessage}`,
        `Caps: ${config.capsPercentThreshold}%+ (min ${config.capsMinLength} chars)`,
      ].join('\n') },
      { name: 'Raid Protection', value: [
        `Trigger: ${config.raidJoinCount} joins in ${config.raidJoinWindowMs / 1000}s`,
        `Auto-kick: ${config.raidAutoKick ? 'Yes' : 'No'}`,
      ].join('\n'), inline: true },
      { name: 'Invite Links', value: config.blockInviteLinks ? 'Blocked' : 'Allowed', inline: true },
      { name: `Blocklist (${blocklist.length})`, value: blocklist.length > 0 ? blocklist.map(w => `\`${w}\``).join(', ').slice(0, 1024) : 'None' },
      { name: 'Link Allowlist', value: linkConfig.allowed.length > 0 ? linkConfig.allowed.join(', ') : 'None', inline: true },
      { name: 'Link Blocklist', value: linkConfig.blocked.length > 0 ? linkConfig.blocked.join(', ') : 'None', inline: true },
      { name: 'Exempt Roles', value: exemptions.roles.length > 0 ? exemptions.roles.map(r => `<@&${r}>`).join(', ') : 'None', inline: true },
      { name: 'Exempt Channels', value: exemptions.channels.length > 0 ? exemptions.channels.map(c => `<#${c}>`).join(', ') : 'None', inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleLog(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.options.getChannel('channel');
  await automod.updateAutomodConfig({ logChannel: channel.id });
  await interaction.editReply(`📋 AutoMod logs will be sent to ${channel}.`);
}

async function handleDm(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const enabled = interaction.options.getBoolean('enabled');
  await automod.updateAutomodConfig({ dmOnAction: enabled });
  await interaction.editReply(`${enabled ? '✅' : '⛔'} User DM notifications **${enabled ? 'enabled' : 'disabled'}**.`);
}

async function handleThresholds(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const updates = {};

  const maxMessages = interaction.options.getInteger('max_messages');
  const windowSeconds = interaction.options.getInteger('window_seconds');
  const maxDuplicates = interaction.options.getInteger('max_duplicates');
  const maxMentions = interaction.options.getInteger('max_mentions');
  const capsPercent = interaction.options.getInteger('caps_percent');

  if (maxMessages !== null) updates.maxMessagesPerWindow = maxMessages;
  if (windowSeconds !== null) updates.messageWindowMs = windowSeconds * 1000;
  if (maxDuplicates !== null) updates.maxDuplicates = maxDuplicates;
  if (maxMentions !== null) updates.maxMentionsPerMessage = maxMentions;
  if (capsPercent !== null) updates.capsPercentThreshold = capsPercent;

  if (Object.keys(updates).length === 0) {
    return interaction.editReply('No thresholds specified. Use the options to set values.');
  }

  await automod.updateAutomodConfig(updates);

  const lines = Object.entries(updates).map(([k, v]) => `**${k}**: ${v}`);
  await interaction.editReply(`✅ Updated thresholds:\n${lines.join('\n')}`);
}

async function handleRaid(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const updates = {};

  const joinCount = interaction.options.getInteger('join_count');
  const windowSeconds = interaction.options.getInteger('window_seconds');
  const autoKick = interaction.options.getBoolean('auto_kick');

  if (joinCount !== null) updates.raidJoinCount = joinCount;
  if (windowSeconds !== null) updates.raidJoinWindowMs = windowSeconds * 1000;
  if (autoKick !== null) updates.raidAutoKick = autoKick;

  if (Object.keys(updates).length === 0) {
    return interaction.editReply('No raid settings specified. Use the options to set values.');
  }

  await automod.updateAutomodConfig(updates);

  const lines = Object.entries(updates).map(([k, v]) => `**${k}**: ${v}`);
  await interaction.editReply(`✅ Updated raid settings:\n${lines.join('\n')}`);
}

async function handleBlocklist(interaction, sub) {
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'add') {
    const word = interaction.options.getString('word').trim();
    if (!word || word.length === 0) {
      return interaction.editReply('Word/phrase cannot be empty or whitespace-only.');
    }
    if (word.length > 128) {
      return interaction.editReply('Word/phrase is too long (max 128 characters).');
    }
    await automod.addBlocklistWord(word);
    await interaction.editReply(`✅ Added \`${word}\` to the blocklist.`);
  } else if (sub === 'remove') {
    const word = interaction.options.getString('word');
    await automod.removeBlocklistWord(word);
    await interaction.editReply(`✅ Removed \`${word}\` from the blocklist.`);
  } else if (sub === 'list') {
    const words = await automod.getBlocklist();
    if (words.length === 0) {
      return interaction.editReply('The blocklist is empty.');
    }
    const embed = new EmbedBuilder()
      .setTitle('🚫 AutoMod Blocklist')
      .setColor(0xe74c3c)
      .setDescription(words.map(w => `\`${w}\``).join(', '))
      .setFooter({ text: `${words.length} word(s)` });
    await interaction.editReply({ embeds: [embed] });
  }
}

async function handleLinks(interaction, sub) {
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'allow') {
    const domain = normalizeDomain(interaction.options.getString('domain'));
    if (!domain) return interaction.editReply('Invalid domain. Provide a hostname like `example.com`, not a full URL.');
    await automod.addLinkEntry('allow', domain);
    await interaction.editReply(`✅ Added \`${domain}\` to the link allowlist.`);
  } else if (sub === 'block') {
    const domain = normalizeDomain(interaction.options.getString('domain'));
    if (!domain) return interaction.editReply('Invalid domain. Provide a hostname like `example.com`, not a full URL.');
    await automod.addLinkEntry('block', domain);
    await interaction.editReply(`✅ Added \`${domain}\` to the link blocklist.`);
  } else if (sub === 'remove') {
    const domain = normalizeDomain(interaction.options.getString('domain'));
    if (!domain) return interaction.editReply('Invalid domain. Provide a hostname like `example.com`, not a full URL.');
    await automod.removeLinkEntry('allow', domain);
    await automod.removeLinkEntry('block', domain);
    await interaction.editReply(`✅ Removed \`${domain}\` from allow/blocklists.`);
  } else if (sub === 'list') {
    const linkConfig = await automod.getLinkConfig();
    const embed = new EmbedBuilder()
      .setTitle('🔗 AutoMod Link Rules')
      .setColor(0x3498db)
      .addFields(
        { name: 'Allowlist', value: linkConfig.allowed.length > 0 ? linkConfig.allowed.map(d => `\`${d}\``).join(', ') : 'None (all non-blocked links allowed)' },
        { name: 'Blocklist', value: linkConfig.blocked.length > 0 ? linkConfig.blocked.map(d => `\`${d}\``).join(', ') : 'None' },
      );
    await interaction.editReply({ embeds: [embed] });
  }
}

async function handleExempt(interaction, sub) {
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'add') {
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    if (!role && !channel) return interaction.editReply('Specify a role or channel to exempt.');
    if (role) await automod.addExemption('role', role.id);
    if (channel) await automod.addExemption('channel', channel.id);
    const targets = [role && `role ${role}`, channel && `channel ${channel}`].filter(Boolean).join(' and ');
    await interaction.editReply(`✅ Exempted ${targets} from auto-moderation.`);
  } else if (sub === 'remove') {
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel');
    if (!role && !channel) return interaction.editReply('Specify a role or channel to un-exempt.');
    if (role) await automod.removeExemption('role', role.id);
    if (channel) await automod.removeExemption('channel', channel.id);
    const targets = [role && `role ${role}`, channel && `channel ${channel}`].filter(Boolean).join(' and ');
    await interaction.editReply(`✅ Removed exemption for ${targets}.`);
  } else if (sub === 'list') {
    const exemptions = await automod.getExemptions();
    const embed = new EmbedBuilder()
      .setTitle('✨ AutoMod Exemptions')
      .setColor(0x9b59b6)
      .addFields(
        { name: 'Roles', value: exemptions.roles.length > 0 ? exemptions.roles.map(r => `<@&${r}>`).join(', ') : 'None' },
        { name: 'Channels', value: exemptions.channels.length > 0 ? exemptions.channels.map(c => `<#${c}>`).join(', ') : 'None' },
      );
    await interaction.editReply({ embeds: [embed] });
  }
}

function normalizeDomain(input) {
  let raw = (input || '').trim().toLowerCase();
  // If it looks like a URL, extract the hostname
  try {
    if (raw.includes('://')) {
      raw = new URL(raw).hostname;
    } else if (raw.includes('/')) {
      raw = new URL('https://' + raw).hostname;
    }
  } catch {
    // not a valid URL, treat as hostname
  }
  // Strip www. prefix
  raw = raw.replace(/^www\./, '');
  // Basic domain validation: at least one dot, no spaces, reasonable length
  if (!raw || raw.length > 253 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw)) return null;
  return raw;
}

module.exports = { data: commandData, execute };
