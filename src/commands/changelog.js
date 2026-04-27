const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const CHANGELOG = [
  {
    version: '2.9.0',
    date: '2026-04-27',
    changes: [
      'Pokedex now **reads attached screenshots** — error text, app screen, and visible state are extracted into the triage report',
      'Pokedex can now **call tools while triaging** — searches existing issues, checks live poke.com status, and reads recent channel messages before classifying',
      'Bug reports about Pokedex itself ("the bot misclassified", "you\'re doing it wrong") now route to `#pokedex-testing` instead of `eng-triage`',
      '**Capability-gap backlog** in `#pokedex-testing` — when Pokedex notices something it wishes it could do, it logs it (deduped, count-tracked, owner pinged at thresholds)',
      'Pokedex now **auto-resolves** issues when the reporter says "solved" / "fixed" / "nvm" — no more zombie open issues',
      'Smart thread replies — Pokedex now **decides whether to ignore, react ✅, or reply** based on what the message actually says, instead of always reacting',
      'Per-thread reply rate limit (default 3 / 10 min) so Pokedex can\'t spam an issue thread',
      'When @Pokedex is a **reply** to another user\'s message, Pokedex now classifies the parent\'s content (the actual complaint), not the reply wrapper',
      'Casual mentions of Pokedex no longer create issues; direct questions to the bot get a short help reply',
      'Forum-thread bug reports now get the same agent treatment (vision, target routing, capability gaps)',
      '**`/pokedexbug`** now runs through the agent for richer summary and screenshot reading; user-selected priority and category still win',
      '**`/issue close`** now treats `resolved` as a terminal state — auto-resolution metadata is no longer overwritten',
      '**`/issue status`** displays a Resolved bucket alongside Open and Closed',
      'New config keys: `pokedex_owner_id` (set via `POKEDEX_OWNER_ID` env var or `/config set` — the user that gets pinged on capability gaps and critical Pokedex-self bugs), `pokedex_self_channel`, `agent_enabled` (kill switch back to single-shot triage), `agent_max_tool_calls`, `agent_max_replies_per_thread_per_10m`',
    ],
  },
  {
    version: '2.8.2',
    date: '2026-04-17',
    changes: [
      '**`/status check`** is now visible to everyone by default — admins can set the default via `/config set status_check_public false`',
      'Added `display:public` / `display:private` option to **`/status check`** to override the default per-use',
      'Added **View Incidents** button to the status embed — shows detailed incident info with impact, status, timestamps, and a full update timeline',
      'Only the user who ran `/status check` can click the button — others get a private message explaining why',
      'Incident details now match the visibility of the parent status check (public or private)',
      'Added disclaimer footer on incident embeds noting the integration relies on the public status page API',
    ],
  },
  {
    version: '2.8.1',
    date: '2026-04-17',
    changes: [
      'Added autocomplete to **`/config`** — key param now shows all valid config keys',
      'Added autocomplete to **`/pokedex`** — search Pokemon by name or number with cached PokeAPI list',
      'Added static type choices to **`/typechart`** — all 18 types as a dropdown',
      'Added autocomplete to **`/automod blocklist remove`** and **`/automod links remove`** — shows current entries',
    ],
  },
  {
    version: '2.8.0',
    date: '2026-04-17',
    changes: [
      'Added **`/status`** command — check poke.com service status on demand with `check`, `setup` a live-updating status channel, or `disable` it',
      'Auto-updating status channel — cron-driven poller detects incidents, component changes, and resolutions, posting embeds in real time',
      'Fixed 9 CodeQL security alerts: SSRF prevention via snowflake validation and `encodeURIComponent` in Discord API calls, exact domain matching (`endsWith`) replacing `hostname.includes()`, and global rate limiting via `express-rate-limit`',
    ],
  },
  {
    version: '2.7.2',
    date: '2026-04-15',
    changes: [
      'Compacted `/changelog` — now shows one version per page instead of three, so each page fits in a single viewport without scrolling',
      'Added ⏮ / ⏭ jump-to-first / jump-to-last buttons to the pager for faster navigation through the full history',
    ],
  },
  {
    version: '2.7.1',
    date: '2026-04-15',
    changes: [
      'Fixed the canonical recipe tag vocabulary — it was accidentally Pokemon-themed from an earlier prototype, now matches the actual poke.com recipe domain (productivity, travel, coding, mcp, etc.)',
      'Fixed `inferSource` whitelist — dropped Pokemon battling sites, added poke.com, Notion, and the other real sources',
      'Updated keyword fallback and test suite to match the new vocabulary',
    ],
  },
  {
    version: '2.7.0',
    date: '2026-04-15',
    changes: [
      'Recipe tags are now generated by OpenRouter from a curated ~40-tag canonical vocabulary. Both the AI path and the keyword fallback enforce the same vocabulary, so no tag outside the canonical set is ever written.',
      'Tags are sorted alphabetically for stable rendering on every recipe card',
      '`/recipes retag` now uses AI tagging, with a new `preview:true` option that reports what would change without writing',
      'Rate-limited to ~10 req/s with live progress updates in the Discord reply',
      'Falls back to the keyword extractor on any OpenRouter failure so ingestion never breaks',
    ],
  },
  {
    version: '2.6.1',
    date: '2026-04-15',
    changes: [
      'Fixed `/recipes` tag noise — switched from substring matching to word-boundary regex so `#ou` no longer fires on "about"/"cloud"/"out", etc.',
      'Fixed `/recipes` source noise — unknown hostnames no longer get promoted to fake sources like "ogeneo" or "petrol"; they return null and drop out of the filter chips',
      'Added `/recipes retag` — mod-only subcommand that re-runs the extractors against every stored recipe to fix historical data',
    ],
  },
  {
    version: '2.6.0',
    date: '2026-04-14',
    changes: [
      'Added `/autoscrape recipes` — automatically scrape new #show-and-tell forum posts for recipe links without needing `/recipes scrape`',
      'Configurable auto-approve: skip the approval workflow with `auto_approve:true` or keep manual review (default)',
      'Added `/recipes delete` — original poster can delete their own recipe via slash command',
      'OP delete button on recipe approval embeds — the person who shared a recipe can now delete it directly',
    ],
  },
  {
    version: '2.5.1',
    date: '2026-04-14',
    changes: [
      'Added **`/pokedexbug`** — report bugs against Pokedex directly from Discord',
      'Accepts title, description, optional priority, category, and screenshot attachment',
      'Reports flow through the existing Firestore issues pipeline and land in the eng-triage channel alongside other issues',
    ],
  },
  {
    version: '2.5.0',
    date: '2026-03-26',
    changes: [
      'Added **standalone public recipes site** — glassmorphism dark theme at `recipes-site/`, deployed separately on Vercel',
      'Added `/recipes grab` — run inside any thread to scrape it for recipe links, with `auto-approve` option',
      'Added `/recipes approve <id>` — approve a single pending recipe with autocomplete search',
      'Added `/recipes scrape auto-approve:true` — skip the approval channel, publish scraped recipes directly',
      'Added `/recipes approve-all` — bulk-approve every pending recipe in one click',
      'Smarter recipe duplicate detection — URL normalization, refer code cross-checks, and in-run dedup',
      '`/recipes scrape` and `/feedback-triage scrape` now **skip already-scraped posts** — re-runs are near-instant',
      'Added **public feedback page** at `/feedback` — auto-syncs #feedback forum posts to the website with search and filters',
      'Thread context acknowledgements now use ✅ reactions instead of sending embed messages',
      'Fixed `/changelog` crash — entries exceeding Discord\'s 1024-char embed field limit now split across multiple fields',
      'Fixed startup crash from `setDefaultMemberPermissions` on recipe subcommand',
      'Security hardening across MCP servers, automod, recipes, dashboard OAuth, and feedback triage (PR #20)',
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
      'Added `/rickandmorty` command — character lookup, episode details, random cards, quotes, and burps',
      'AI-powered duplicate detection replaces Jaccard word-overlap for issue matching',
      'Added `/feedback-triage reorganize` — batch-scan open issues for duplicate clusters and auto-merge',
      'Forum trigger duplicate check — new #feedback posts are checked against existing issues before creating new ones',
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

const TOTAL_PAGES = CHANGELOG.length;

const commandData = new SlashCommandBuilder()
  .setName('changelog')
  .setDescription('See what\'s new in Pokedex')
  .addBooleanOption(option =>
    option.setName('public')
      .setDescription('Show the changelog to everyone in the channel (default: only you)')
      .setRequired(false)
  );

function buildChangelogPage(page) {
  const entry = CHANGELOG[page];
  if (!entry) return null;

  const embed = new EmbedBuilder()
    .setTitle(`Pokedex Changelog — v${entry.version}`)
    .setColor(0x5865f2);

  const FIELD_LIMIT = 1024;
  const bullets = entry.changes.map(c => `• ${c}`);
  const chunks = [];
  let current = '';

  for (const bullet of bullets) {
    const candidate = current ? current + '\n' + bullet : bullet;
    if (candidate.length > FIELD_LIMIT) {
      if (current) chunks.push(current);
      current = bullet;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  chunks.forEach((chunk, i) => {
    embed.addFields({
      name: i === 0 ? entry.date : '\u200b',
      value: chunk,
    });
  });

  embed.setFooter({ text: `Page ${page + 1} of ${TOTAL_PAGES} • Pokedex v${CHANGELOG[0].version}` });
  return embed;
}

function buildPageButtons(page) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`changelog_first_${page}`)
      .setLabel('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`changelog_prev_${page}`)
      .setLabel('◀ Prev')
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
    new ButtonBuilder()
      .setCustomId(`changelog_last_${page}`)
      .setLabel('⏭')
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
  const action = parts[1]; // first, prev, next, last
  const currentPage = parseInt(parts[2], 10);

  let newPage = currentPage;
  if (action === 'first') newPage = 0;
  if (action === 'prev') newPage = Math.max(0, currentPage - 1);
  if (action === 'next') newPage = Math.min(TOTAL_PAGES - 1, currentPage + 1);
  if (action === 'last') newPage = TOTAL_PAGES - 1;

  const embed = buildChangelogPage(newPage);
  const buttons = buildPageButtons(newPage);
  await interaction.update({ embeds: [embed], components: [buttons] });
}

module.exports = { data: commandData, execute, handleChangelogButton };
