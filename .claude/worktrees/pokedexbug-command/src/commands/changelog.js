const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const CHANGELOG = [
  {
    version: '2.5.0',
    date: '2026-04-14',
    changes: [
      'Added **`/pokedexbug`** — report bugs against Pokedex directly from Discord',
      'Accepts title, description, optional priority, category, and screenshot attachment',
      'Reports flow through the existing Firestore issues pipeline and land in the eng-triage channel alongside other issues',
    ],
  },
  {
    version: '2.4.0',
    date: '2026-03-25',
    changes: [
      'Added **Vercel dashboard recipes page** — real-time recipe browsing at `/recipes` on the web dashboard',
      'Recipe cards with source badges, refer codes, tags, share counts, and clickable links',
      'Search and filter by source, tag, or refer code with interactive filter chips',
      'Recipes nav item added to sidebar and overview quick links',
      'Vercel dashboard: added moderation page, AutoMod config page, activity feed, and user search',
    ],
  },
  {
    version: '2.3.0',
    date: '2026-03-25',
    changes: [
      'Added `/recipes scrape` — scrapes #show-and-tell for all poke.com links (and others), fetches page titles, and sends each to #recipe-approval with Approve/Decline buttons',
      'Added `/recipes add` — submit a recipe link for approval',
      'Added `/recipes list` — browse approved community recipes in Discord',
      'Added `/recipes pending` — see recipes waiting for approval',
      'Recipes require mod approval before appearing on the website — Approve/Decline buttons in #recipe-approval',
      'Recognizes all poke.com links (`/r/`, `/refer/`, `/recipe/`, etc.) and fetches the page `<title>` for the recipe name',
      'Added **community recipe page** at `/recipes` — only shows approved recipes, with search, filters, and refer codes',
      'Recipe API (`GET /api/recipes`) only returns approved recipes',
      'Added `/feedback-triage scrape` — bulk-scrape every post in a feedback forum, classify with AI, deduplicate, and create/merge issues automatically with a live progress bar',
      'Added `/feedback-triage run` — run inside any #feedback forum post to smart-triage it into an issue',
      'Added `/feedback-triage merge <issue>` — manually merge a forum post into an existing issue when AI misses the duplicate',
      'Merge transfers reporters, context, and attachments to the target issue and links the thread for auto-tracking',
      'Detects duplicate issues automatically and merges context instead of creating duplicates',
      'Tracks unique affected users per issue — triage embeds show reporter count',
      'Auto-links forum threads so future messages update the issue automatically',
      'Added `/automod` — configurable spam detection, raid protection, and content filtering',
      'AutoMod catches message spam, duplicate messages, mass mentions, caps abuse, invite links, and blocklisted words',
      'Raid detection auto-locks server when join velocity spikes',
      'Hardened dashboard API with stricter rate limiting and auth validation',
      'Security fixes across bot commands, input handling, and fetch loops',
    ],
  },
  {
    version: '2.2.1',
    date: '2026-03-25',
    changes: [
      'MCP issues now created as "pending" and require approval before entering triage',
      'MCP agents can only update issues they created and cannot close or fix issues',
      'Input length limits on all string fields across both MCP servers',
      'Spam and quality filters on Node.js MCP server (gibberish, profanity, caps, URL spam)',
      'Screenshot URL SSRF protection — HTTPS-only, no private IPs, allowlisted image hosts',
      'Rate limiting on Node.js MCP server (10 writes/min, 30 reads/min)',
      'Restricted CORS on Cloudflare worker to known origins only',
      'Sanitized error messages to prevent internal detail leakage',
      'Fixed threadContext race condition using arrayUnion',
    ],
  },
  {
    version: '2.2.0',
    date: '2026-03-25',
    changes: [
      'Pokedex now auto-engages users in `#feedback` forum posts to gather context — asks smart follow-up questions until developers have enough info to fix issues',
      'Added "Context Complete" badge on triage embeds so devs can prioritize fully-contexted issues',
      'Added "Gather Context" button on triage embeds — mods can send Pokedex to ask more questions',
      '`/feedback analyze` — AI theme report using enriched conversation data instead of raw posts',
      '`/feedback status` — new dashboard showing feedback pipeline health (completion rates, breakdowns)',
    ],
  },
  {
    version: '2.1.5',
    date: '2026-03-25',
    changes: [
      'Added `/issue recover` — scrapes a thread to recreate a hard-deleted issue and continues the conversation with the reporter automatically',
      'Added `/issue revive` — reopens a deleted issue and creates a new thread for the reporter to add context',
      'Delete button on triage embeds now soft-deletes issues instead of permanently removing them, so `/issue reopen` works on deleted issues',
    ],
  },
  {
    version: '2.1.2',
    date: '2026-03-24',
    changes: [
      'Added autocomplete dropdowns to `/issue`, `/merge`, `/warn`, `/suggest`, and `/giveaway` — no more typing IDs manually',
      'All ID-based options now show filtered search results as you type',
    ],
  },
  {
    version: '2.1.1',
    date: '2026-03-24',
    changes: [
      'Rewrote `/help` — now shows all 30+ commands organized by category (issues, mod, community, fun, settings)',
      'Added optional `category` parameter to jump straight to a specific section',
    ],
  },
  {
    version: '2.1.0',
    date: '2026-03-24',
    changes: [
      'Added `/starboard` — highlight the best messages with ⭐ reactions, auto-reposted to a starboard channel',
      'Added `/poll` — create reaction-based polls with up to 10 options and optional auto-close timer',
      'Added `/welcome` — configurable welcome/goodbye embeds when members join or leave',
      'Added `/reactionrole setup` — self-assign roles by reacting to a setup message',
      'Added `/giveaway start` and `/giveaway reroll` — timed giveaways with random winner selection',
      'Added `/suggest` — suggestion board with 👍/👎 voting and status tracking (approved, denied, etc.)',
    ],
  },
  {
    version: '2.0.4',
    date: '2026-03-24',
    changes: [
      'Added `/merge` — combine multiple issues into one, merging context, attachments, and reporters',
      'Source issues are marked as "merged" and linked to the target issue',
      'Cleaned up all test and irrelevant issues from the database',
    ],
  },
  {
    version: '2.0.3',
    date: '2026-03-24',
    changes: [
      'Added `level_announce` config option — use `/config set level_announce false` to disable level-up messages in chat',
    ],
  },
  {
    version: '2.0.2',
    date: '2026-03-24',
    changes: [
      'Added `/deletethread` — delete any thread with an optional reason (requires Manage Threads permission)',
    ],
  },
  {
    version: '2.0.1',
    date: '2026-03-24',
    changes: [
      'Fixed duplicate issue creation when users add context in issue threads',
      'Reactions on messages inside issue threads no longer create new issues',
      'Thread context from any user (not just reporter) is now tracked',
    ],
  },
  {
    version: '2.0.0',
    date: '2026-03-24',
    changes: [
      'Added `/warn` — issue warnings with infraction history, list, remove, and clear subcommands',
      'Added `/timeout` — temporarily mute users with preset durations (60s to 28 days)',
      'Added `/kick` and `/ban` — remove users with reason logging and DM notifications',
      'Added `/purge` — bulk delete up to 100 messages, optionally filtered by user',
      'Added `/slowmode` — set or disable channel slowmode (up to 6 hours)',
      'All moderation actions are logged to Firestore with full infraction history',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-03-24',
    changes: [
      'Added `/serverinfo` — server stats, member counts, channels, boosts, roles, and creation date',
      'Added `/afk <reason>` — set yourself as AFK; anyone who pings you gets notified, and you\'re welcomed back when you return',
      'Added `/level check` and `/level top` — XP leveling system with ranks, progress bars, and a leaderboard',
      'XP is earned per message (15-25 XP, 1-minute cooldown) with level-up announcements',
    ],
  },
  {
    version: '1.8.1',
    date: '2026-03-24',
    changes: [
      'Fixed duplicate issue creation when multiple users react to the same message — only the first reaction triggers an issue now',
    ],
  },
  {
    version: '1.8.0',
    date: '2026-03-24',
    changes: [
      '`/ping` now shows the bot version number',
      '`/changelog` is now paginated — browse with Previous/Next buttons instead of one giant embed',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-03-24',
    changes: [
      'Added `/issue context <id> <text>` — anyone can add follow-up context to an open issue without filing a new one',
      'Added `pokedex_add_context` MCP tool — AI agents can append context via stdio and Cloudflare Workers MCP servers',
      'MCP context additions edit the existing triage/pending embed directly in Discord',
      'Works for both pending (pre-approval) and approved issues',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-03-23',
    changes: [
      'Added `/issue mine` — review your own recent issues',
      'Added `/issue search <query>` — search issues by keyword',
      'Added `/issue assign` and `/issue note` — track ownership and internal notes',
      'Added `/typechart <type>` — Pokemon type matchup lookup',
      '**Duplicate detection** — matches new reports against existing issues with confidence %',
      '**Web dashboard** — live issue dashboard with filters, search, and stats',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-03-23',
    changes: [
      'Added `/ping`, `/lock`, `/unlock`, `/leaderboard`, `/pokedex <pokemon>`',
      'Triage embeds now have action buttons: **Acknowledged**, **Fixed**, **Won\'t Fix**, **Escalate**, **Delete**',
      'Buttons update the embed and disable after an action is taken',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-03-23',
    changes: [
      'Added `/feedback` — AI-powered analysis of forum feedback, grouped by theme and priority',
      'Detailed triage output with priority reasoning, user quotes, affected areas, and suggested owners',
      'Feedback posts organized themes directly to #eng-triage',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-03-23',
    changes: [
      'Added `/issue` admin commands — close, reopen, view, list, and status dashboard',
      'Closing an issue grays out the triage embed and archives the thread',
      'Issue dashboard shows open/closed counts by priority',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-03-23',
    changes: [
      'Thread context tracking — Pokedex listens to replies in issue threads and reclassifies with full context',
      'Triage embeds update live when users add context in threads',
      'Added thread follow-ups — opens a thread when more info is needed',
      'Added `/changelog` command with public/private option',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-03-23',
    changes: [
      'Added suggestion support — react with 💡 to submit feature requests',
      'Added `/help` command with full usage guide',
      'Bot shows usage embed when @mentioned without a message',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-03-23',
    changes: [
      'Initial release',
      'AI-powered issue classification via OpenRouter',
      '@mention and 🐛 emoji triggers',
      'Color-coded triage embeds in dedicated channel',
      'Two-layer config system (file + Firestore) with `/config` command',
      'Scheduled daily/weekly digest summaries',
    ],
  },
];

const ITEMS_PER_PAGE = 3;
const TOTAL_PAGES = Math.ceil(CHANGELOG.length / ITEMS_PER_PAGE);

const commandData = new SlashCommandBuilder()
  .setName('changelog')
  .setDescription('See what\'s new in Pokedex')
  .addBooleanOption(option =>
    option.setName('public')
      .setDescription('Show the changelog to everyone in the channel (default: only you)')
      .setRequired(false)
  );

function buildChangelogPage(page) {
  const start = page * ITEMS_PER_PAGE;
  const entries = CHANGELOG.slice(start, start + ITEMS_PER_PAGE);

  const embed = new EmbedBuilder()
    .setTitle('Pokedex Changelog')
    .setColor(0x5865f2);

  for (const entry of entries) {
    const lines = entry.changes.map(c => `• ${c}`).join('\n');
    embed.addFields({
      name: `v${entry.version} — ${entry.date}`,
      value: lines,
    });
  }

  embed.setFooter({ text: `Page ${page + 1} of ${TOTAL_PAGES} • Pokedex v${CHANGELOG[0].version}` });
  return embed;
}

function buildPageButtons(page) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`changelog_prev_${page}`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`changelog_page_${page}`)
      .setLabel(`${page + 1} / ${TOTAL_PAGES}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`changelog_next_${page}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= TOTAL_PAGES - 1),
  );
}

async function execute(interaction) {
  const isPublic = interaction.options.getBoolean('public') ?? false;
  const page = 0;
  const embed = buildChangelogPage(page);
  const buttons = buildPageButtons(page);
  await interaction.reply({ embeds: [embed], components: [buttons], ephemeral: !isPublic });
}

async function handleChangelogButton(interaction) {
  const customId = interaction.customId;
  const parts = customId.split('_');
  const action = parts[1]; // prev or next
  const currentPage = parseInt(parts[2], 10);

  let newPage = currentPage;
  if (action === 'prev') newPage = Math.max(0, currentPage - 1);
  if (action === 'next') newPage = Math.min(TOTAL_PAGES - 1, currentPage + 1);

  const embed = buildChangelogPage(newPage);
  const buttons = buildPageButtons(newPage);
  await interaction.update({ embeds: [embed], components: [buttons] });
}

module.exports = { data: commandData, execute, handleChangelogButton };
