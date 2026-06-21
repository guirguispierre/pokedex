const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { createFetcher } = require('../services/statusFetcher');
const { createStore } = require('../services/statusStore');
const { createPoller } = require('../services/statusPoller');
const { buildSummaryEmbed, buildIncidentListEmbeds } = require('../services/statusFormatter');
const { normalize } = require('../services/statusDiff');
const config = require('../config/config');
const { getFirestore } = require('firebase-admin/firestore');

const commandData = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Check Poke status')
  .addSubcommand(sub =>
    sub.setName('check')
      .setDescription('Show the current Poke status')
      .addStringOption(opt =>
        opt.setName('display')
          .setDescription('Show publicly or privately (default: set by /config)')
          .addChoices(
            { name: 'Public — visible to everyone', value: 'public' },
            { name: 'Private — only you can see', value: 'private' },
          )))
  .addSubcommand(sub =>
    sub.setName('setup')
      .setDescription('Create or adopt a status channel for this server')
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('Existing channel to use (default: create #poke-status)')
          .addChannelTypes(ChannelType.GuildText))
      .addRoleOption(opt =>
        opt.setName('alert_role')
          .setDescription('Role to ping on new incidents (optional)')))
  .addSubcommand(sub =>
    sub.setName('disable')
      .setDescription('Stop tracking status in this server'))
  .setDefaultMemberPermissions(PermissionFlagsBits.ViewChannel);

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'check') {
    return handleCheck(interaction);
  }

  const member = interaction.member;
  if (!member?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.reply({
      content: 'You need the **Manage Channels** permission to configure the status integration.',
      ephemeral: true,
    });
  }

  if (sub === 'setup') return handleSetup(interaction);
  if (sub === 'disable') return handleDisable(interaction);
}

function getDeps() {
  const db = getFirestore();
  const store = createStore(db);
  const fetcher = createFetcher({ timeoutMs: config.getConfig('status_fetch_timeout_ms') || 10000 });
  return { store, fetcher };
}

async function handleCheck(interaction) {
  const displayChoice = interaction.options.getString('display');
  const defaultPublic = config.getConfig('status_check_public') ?? true;
  const isPublic = displayChoice ? displayChoice === 'public' : defaultPublic;
  await interaction.deferReply({ ephemeral: !isPublic });

  if (!config.getConfig('status_enabled')) {
    return interaction.editReply({ content: 'Status feature is disabled globally. Ask an admin to enable `status_enabled` via `/config`.' });
  }

  const { store, fetcher } = getDeps();
  const poller = createPoller({
    client: interaction.client,
    fetcher, store, config,
  });

  try {
    let raw = await poller.runTickForGuild(interaction.guildId);
    if (!raw) raw = await poller.fetchOnce();
    const snap = normalize(raw);
    const apiUrl = config.getConfig('status_api_url') || 'https://status.poke.com/api/v2/summary.json';
    let pageUrl;
    try { pageUrl = new URL(apiUrl).origin; } catch { pageUrl = 'https://status.poke.com'; }
    const { embed, row } = buildSummaryEmbed(snap, { statusPageUrl: pageUrl, userId: interaction.user.id, isPublic });
    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('[status] /status check failed:', err);
    await interaction.editReply({ content: 'Could not reach the Poke status page right now. Try again in a minute.' });
  }
}

async function handleIncidentButton(interaction) {
  // customId format: status_incidents_<userId>_<pub|priv>
  const ownerId = interaction.customId.split('_')[2];
  const visibility = interaction.customId.split('_')[3];
  const isPublic = visibility === 'pub';

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: 'Only the person who ran `/status check` can view incident details.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: !isPublic });

  const { fetcher } = getDeps();
  const apiUrl = config.getConfig('status_api_url') || 'https://status.poke.com/api/v2/summary.json';

  try {
    const raw = await fetcher.fetchSummary(apiUrl);
    const snap = normalize(raw);
    let pageUrl;
    try { pageUrl = new URL(apiUrl).origin; } catch { pageUrl = 'https://status.poke.com'; }
    const embeds = buildIncidentListEmbeds(snap, { statusPageUrl: pageUrl });
    await interaction.editReply({ embeds: embeds.slice(0, 10) });
  } catch (err) {
    console.error('[status] incident button failed:', err);
    await interaction.editReply({ content: 'Could not fetch incident details. Try again.' });
  }
}

async function handleSetup(interaction) {
  await interaction.deferReply({ ephemeral: true });

  if (!config.getConfig('status_enabled')) {
    return interaction.editReply({ content: 'Status feature is disabled globally. Ask an admin to enable `status_enabled` via `/config`.' });
  }

  const providedChannel = interaction.options.getChannel('channel');
  const alertRole = interaction.options.getRole('alert_role');

  if (alertRole && (alertRole.id === interaction.guildId || alertRole.name === '@everyone')) {
    return interaction.editReply({ content: 'The alert role cannot be `@everyone`.' });
  }

  let channel = providedChannel;
  if (!channel) {
    const name = config.getConfig('status_default_channel_name') || 'poke-status';
    try {
      channel = await interaction.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: interaction.channel?.parentId ?? null,
        reason: `Requested by ${interaction.user.tag} via /status setup`,
      });
    } catch (err) {
      console.error('[status] channel create failed:', err);
      return interaction.editReply({ content: `Could not create channel: ${err?.message}` });
    }
  }

  const me = interaction.guild.members.me;
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.EmbedLinks,
  ];
  const missing = required.filter(p => !channel.permissionsFor(me).has(p));
  if (missing.length > 0) {
    return interaction.editReply({
      content: `I'm missing permissions in ${channel}: need **View Channel**, **Send Messages**, **Manage Messages**, and **Embed Links**.`,
    });
  }

  const { store, fetcher } = getDeps();
  await store.save(interaction.guildId, {
    channelId: channel.id,
    alertRoleId: alertRole?.id ?? null,
    enabled: true,
  });

  const poller = createPoller({
    client: interaction.client, fetcher, store, config,
  });
  try {
    await poller.runTickForGuild(interaction.guildId);
  } catch (err) {
    console.warn('[status] initial tick failed:', err?.message);
  }

  await interaction.editReply({
    content: `Status tracking enabled in ${channel}${alertRole ? ` — ${alertRole} will be pinged on new incidents` : ''}.`,
  });
}

async function handleDisable(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const { store } = getDeps();
  const existing = await store.get(interaction.guildId);
  if (!existing) {
    return interaction.editReply({ content: 'Status tracking is not configured in this server.' });
  }

  if (existing.pinnedMessageId && existing.channelId) {
    try {
      const ch = await interaction.client.channels.fetch(existing.channelId);
      const msg = await ch.messages.fetch(existing.pinnedMessageId);
      await msg.unpin().catch(() => {});
    } catch (err) {
      // Channel/message might be gone — not worth blocking on.
    }
  }

  await store.disable(interaction.guildId);
  await interaction.editReply({ content: 'Status tracking disabled. Run `/status setup` to re-enable.' });
}

module.exports = { data: commandData, execute, handleIncidentButton };
