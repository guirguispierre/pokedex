const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');
const { XP_COOLDOWN, XP_PER_MESSAGE } = require('./level');
const { PAGE_SIZE, parseSince, runReindex } = require('../services/xpReindex');

// Process start, derived from uptime. Messages before this are downtime and
// messages after it are handled live.
const BOOT_AT_MS = Date.now() - Math.round(process.uptime() * 1000);
// The scan is read-only, but the interaction token expires after 15 minutes.
const SCAN_BUDGET_MS = 12 * 60 * 1000;

const data = new SlashCommandBuilder()
  .setName('xp-reindex')
  .setDescription('Recover XP for messages sent while the bot was offline (admin)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addBooleanOption(opt => opt.setName('dry_run')
    .setDescription('Only report what would change (default: true)')
    .setRequired(false))
  .addStringOption(opt => opt.setName('since')
    .setDescription('Scan back to here: "36h", "2d", or a date. Default: last XP award before this start')
    .setRequired(false));

// Channels with messages, plus every thread (active and archived), since live XP
// also counts thread messages.
async function collectSources(guild) {
  const seen = new Set();
  const sources = [];
  const add = (ch) => {
    if (!ch || !ch.messages || seen.has(ch.id)) return;
    seen.add(ch.id);
    sources.push({
      id: ch.id,
      fetchPage: async (before) => {
        const page = await ch.messages.fetch({ limit: PAGE_SIZE, ...(before ? { before } : {}) });
        return [...page.values()].map(m => ({
          id: m.id,
          createdTimestamp: m.createdTimestamp,
          authorId: m.author?.id,
          authorIsBot: m.author?.bot,
          authorName: m.author?.username,
        }));
      },
    });
  };

  const channels = await guild.channels.fetch();
  for (const ch of channels.values()) {
    if (!ch) continue;
    add(ch);
    if (ch.threads) {
      for (const type of ['public', 'private']) {
        try {
          const archived = await ch.threads.fetchArchived({ type, fetchAll: true });
          archived.threads.forEach(add);
        } catch {
          // Private archived threads need extra permissions. Skip if unavailable.
        }
      }
    }
  }
  const active = await guild.channels.fetchActiveThreads();
  active.threads.forEach(add);
  return sources;
}

function fmtDate(ms) {
  return ms == null ? 'n/a' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatReport(r) {
  if (r.error === 'no-baseline') {
    return 'No earlier XP award exists to anchor the scan. Pass `since`, for example `since: 3d`.';
  }
  if (r.error === 'scan-timeout') {
    return `Scan ran past the time budget (${r.stats.scannedSources} sources read), so nothing was changed. Narrow the window with \`since\` and try again.`;
  }
  const s = r.stats;
  const lines = [
    r.dryRun ? '**Dry run. Nothing was written.**' : '**XP reindex applied.**',
    `Scanned ${s.scannedSources}/${s.sources} channels and threads (${s.skippedSources} skipped, no access).`,
    `Window: ${fmtDate(r.scanFromMs)} to ${fmtDate(r.cutoffMs)} (bot start). Messages in window: ${s.messagesInWindow}.`,
    `${r.dryRun ? 'Would award' : 'Awarded'} ${r.awardsGranted} XP events (~${r.xpGranted} XP) to ${r.usersWithWork} members.`,
  ];
  if (r.dryRun) lines.push('Run again with `dry_run: false` to apply.');
  return lines.join('\n');
}

async function execute(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'Use this in a server.', ephemeral: true });
  }
  const dryRun = interaction.options.getBoolean('dry_run') ?? true;
  const sinceRaw = interaction.options.getString('since');
  await interaction.deferReply({ ephemeral: true });

  try {
    let sinceMs = null;
    if (sinceRaw) {
      sinceMs = parseSince(sinceRaw, Date.now());
      if (sinceMs == null) {
        return interaction.editReply('Could not read `since`. Use something like `36h`, `2d`, or `2026-11-14 18:00`.');
      }
    }

    const sources = await collectSources(interaction.guild);
    const result = await runReindex({
      db: admin.firestore(),
      guildId: interaction.guild.id,
      sources,
      sinceMs,
      cutoffMs: BOOT_AT_MS,
      dryRun,
      deadlineMs: Date.now() + SCAN_BUDGET_MS,
      cooldownMs: XP_COOLDOWN,
      minGain: XP_PER_MESSAGE.min,
      maxGain: XP_PER_MESSAGE.max,
    });
    await interaction.editReply({ content: formatReport(result) });
  } catch (err) {
    console.error('xp-reindex failed:', err);
    await interaction.editReply({ content: 'XP reindex failed. Check logs.' }).catch(() => {});
  }
}

module.exports = { data, execute };
