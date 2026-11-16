const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');
const { XP_COOLDOWN, XP_PER_MESSAGE } = require('./level');
const { PAGE_SIZE, parseSince, runReindex } = require('../services/xpReindex');

// Process start, derived from uptime. Only a fallback: the real cutoff is when the
// gateway became ready, since messages before that never reached the live path.
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
    .setDescription('Widen the scan: "36h", "2d", or a date. Members active since restart stay at the default')
    .setRequired(false));

// Channels with messages, plus every thread (active and archived), since live XP
// also counts thread messages.
// Archived threads come newest-archived first. Stop paging once they were archived
// before the scan start: those can't contain window messages.
async function fetchArchivedSince(threadManager, type, scanFromMs, add) {
  let before;
  for (;;) {
    const { threads, hasMore } = await threadManager.fetchArchived({ type, fetchAll: true, before, limit: 100 });
    let oldest = null;
    for (const th of threads.values()) {
      const at = th.archiveTimestamp ?? 0;
      if (at >= scanFromMs) add(th);
      if (oldest == null || at < oldest) oldest = at;
    }
    if (!hasMore || !threads.size || oldest == null || oldest < scanFromMs) return;
    before = oldest;
  }
}

async function collectSources(guild, scanFromMs) {
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
          await fetchArchivedSince(ch.threads, type, scanFromMs, add);
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
    `Window: ${fmtDate(r.scanFromMs)} to ${fmtDate(r.cutoffMs)} (bot ready). Messages in window: ${s.messagesInWindow}.`,
    `${r.dryRun ? 'Would award' : 'Awarded'} ${r.awardsGranted} XP events (~${r.xpGranted} XP) to ${r.usersWithWork} members.`,
  ];
  if (r.dryRun) lines.push('Run again with `dry_run: false` to apply.');
  lines.push('Recovered level-ups are not announced.');
  return lines.join('\n');
}

// The interaction token dies after 15 minutes. If the run outlived it, post the
// report in the channel instead so the admin still sees it.
async function reply(interaction, content) {
  try {
    await interaction.editReply({ content });
  } catch {
    await interaction.channel?.send({ content: `<@${interaction.user.id}> ${content}`, allowedMentions: { users: [interaction.user.id] } }).catch(() => {});
  }
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

    const guild = interaction.guild;
    const result = await runReindex({
      db: admin.firestore(),
      guildId: guild.id,
      getSources: (scanFromMs) => collectSources(guild, scanFromMs),
      sinceMs,
      cutoffMs: interaction.client.readyTimestamp ?? BOOT_AT_MS,
      dryRun,
      deadlineMs: Date.now() + SCAN_BUDGET_MS,
      cooldownMs: XP_COOLDOWN,
      minGain: XP_PER_MESSAGE.min,
      maxGain: XP_PER_MESSAGE.max,
    });
    await reply(interaction, formatReport(result));
  } catch (err) {
    console.error('xp-reindex failed:', err);
    await reply(interaction, 'XP reindex failed. Check logs.');
  }
}

module.exports = { data, execute };
