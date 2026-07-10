require('dotenv/config');
const { Client, GatewayIntentBits, Partials, REST, Routes, ActivityType, EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const firestore = require('./services/firestore');
const config = require('./config/config');
const triage = require('./services/triage');
const { handleMention, mentionsBotDirectly } = require('./triggers/mention');
const { handleReaction } = require('./triggers/reaction');
const { handleThreadMessage } = require('./triggers/thread');
const { handleForumPost } = require('./triggers/forum');
const { handleAutoScrape } = require('./triggers/autoscrape');
// pending poller replaced by instant webhook message detection
const automod = require('./services/automod');
const scamscan = require('./services/scamscan');
const { loadCommands, toRegistrationBody } = require('./commandLoader');

// All slash + context-menu commands, loaded once at startup and keyed by their
// registered name (data.name) — which is what interaction.commandName matches.
const commandMap = loadCommands();

// Named handles for the command modules whose extra exports power the event
// listeners and button/context-menu handlers further down this file.
const afkCommand = commandMap.get('afk');
const levelCommand = commandMap.get('level');
const starboardCommand = commandMap.get('starboard');
const reactionroleCommand = commandMap.get('reactionrole');
const welcomeCommand = commandMap.get('welcome');
const changelogCommand = commandMap.get('changelog');
const statusCommand = commandMap.get('status');
const recipesCommand = commandMap.get('recipes');
const raffleCommand = commandMap.get('raffle');
const excludeContextCommand = commandMap.get('Exclude from Pokedex');
const addContextMessageCommand = commandMap.get('Add to Pokedex context');
const { createFetcher } = require('./services/statusFetcher');
const { createStore: createStatusStore } = require('./services/statusStore');
const { createPoller: createStatusPoller } = require('./services/statusPoller');
const {
  canModerate,
  processPendingDecision,
  syncPendingWebhookMessage,
} = require('./services/mcpApproval');
const { startDashboard } = require('./dashboard/server');
const { safeInteractionReply } = require('./utils/safeInteractionReply');
const { hasOpenRouterConfig } = require('./config/featureGates');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Message, Partials.Reaction],
});

function firebaseUnavailableMessage(feature = 'This feature') {
  const reason = firestore.getDisabledReason?.();
  return `${feature} is disabled in local dev because Firebase is not configured${reason ? ` (${reason})` : ''}.`;
}

function openRouterUnavailableMessage(feature = 'This feature') {
  return `${feature} is disabled in local dev because OPENROUTER_API_KEY is not configured.`;
}

async function runFirebaseFeature(label, fn) {
  if (!firestore.isEnabled()) return false;
  try {
    return await fn();
  } catch (err) {
    console.error(`Error in ${label}:`, err);
    return false;
  }
}

// Register slash commands guild-scoped
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, process.env.DISCORD_GUILD_ID),
    { body: toRegistrationBody(commandMap) },
  );
  console.log('Slash commands registered.');
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Set rich presence
  client.user.setPresence({
    activities: [{ name: 'for bugs | /help + @pierre for support', type: ActivityType.Watching }],
    status: 'online',
  });

  // Check for triage channel
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (guild && triage.isTriageEnabled()) {
    const triageChannel = triage.findTriageChannel(guild);
    if (!triageChannel) {
      const warning = `WARNING: Triage channel "${config.getConfig('triage_channel')}" not found. Please create it and restart the bot, or set POKEDEX_DISABLE_TRIAGE=true for local dev.`;
      console.warn(warning);
      guild.systemChannel?.send(warning).catch(() => {});
    }

    // Start digest scheduler
    triage.startDigestScheduler(guild);
  } else if (guild) {
    console.log('[triage] disabled (POKEDEX_DISABLE_TRIAGE=true)');
  }

  raffleCommand.resumeActiveRaffles(client).catch((err) => console.error('[raffle] failed to resume active raffles:', err));

  if (config.getConfig('status_enabled')) {
    try {
      const admin = require('firebase-admin');
      const statusStore = createStatusStore(admin.firestore());
      const statusFetcher = createFetcher({
        timeoutMs: config.getConfig('status_fetch_timeout_ms') || 10000,
      });
      const statusPoller = createStatusPoller({
        client,
        fetcher: statusFetcher,
        store: statusStore,
        config,
      });
      statusPoller.start();
    } catch (err) {
      console.error('[status] failed to start poller:', err);
    }
  } else {
    console.log('[status] poller not started (status_enabled=false)');
  }
});

// Handle @mentions, thread follow-ups, and webhook pending messages
client.on('messageCreate', async (message) => {
  if (message.webhookId && firestore.isEnabled()) {
    const handled = await runFirebaseFeature('webhook pending', () => syncPendingWebhookMessage(message));
    if (handled) return;
  }

  if (message.author.bot) return;

  // AutoMod and scam scanning are Firebase-backed; skip them in local dev without Firebase.
  const automodResult = await runFirebaseFeature('automod', () => automod.handleMessage(message));
  if (automodResult) return;

  const scamResult = await runFirebaseFeature('scam scan', () => scamscan.handleMessage(message));
  if (scamResult) return;

  // AFK system — runs on every non-bot message (welcome back + mention notices)
  try {
    await afkCommand.handleAfkMentions(message);
  } catch (err) {
    console.error('Error handling AFK:', err);
  }

  // XP / Level system — Firebase-backed, so skip in local dev without Firebase.
  await runFirebaseFeature('awarding XP', () => levelCommand.awardXP(message));

  // Check if this is a message in an issue thread — route ALL thread messages
  // through the thread handler first (even @mentions) to prevent duplicate issues
  if (message.channel.isThread() && firestore.isEnabled()) {
    const handled = await runFirebaseFeature('thread message', () => handleThreadMessage(message));
    if (handled) return; // Was an issue thread — context appended, don't create new issue
    // Not an issue thread — fall through to mention handler if applicable
  }

  if (!mentionsBotDirectly(message, client.user)) return;

  try {
    await handleMention(message);
  } catch (err) {
    console.error('Error handling mention:', err);
  }
});

client.on('threadCreate', async (thread) => {
  await runFirebaseFeature('forum post', () => handleForumPost(thread));
  await runFirebaseFeature('recipe auto-scrape', () => handleAutoScrape(thread));
});

// Handle emoji reactions
client.on('messageReactionAdd', async (reaction, user) => {
  await runFirebaseFeature('reaction issue trigger', () => handleReaction(reaction, user));
  await runFirebaseFeature('starboard', () => starboardCommand.handleStarReaction(reaction, user));
  await runFirebaseFeature('reaction role add', () => reactionroleCommand.handleReactionRoleAdd(reaction, user));
});

// Reaction role removal
client.on('messageReactionRemove', async (reaction, user) => {
  if (reaction.partial) await reaction.fetch().catch(() => {});
  await runFirebaseFeature('reaction role remove', () => reactionroleCommand.handleReactionRoleRemove(reaction, user));
});

// Welcome / Goodbye
client.on('guildMemberAdd', async (member) => {
  // AutoMod raid detection is Firebase-backed; skip in local dev without Firebase.
  await runFirebaseFeature('automod raid check', () => automod.handleJoin(member));

  await runFirebaseFeature('member welcome', () => welcomeCommand.handleMemberJoin(member));
});

client.on('guildMemberRemove', async (member) => {
  await runFirebaseFeature('member leave', () => welcomeCommand.handleMemberLeave(member));
});

// Handle slash commands and button interactions
client.on('interactionCreate', async (interaction) => {
  // --- Button interactions ---
  if (interaction.isButton()) {
    try {
      await handleButtonInteraction(interaction);
    } catch (err) {
      console.error('Error handling button:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Failed to process action.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // --- Autocomplete interactions ---
  if (interaction.isAutocomplete()) {
    const command = commandMap.get(interaction.commandName);
    if (command?.requiresFirebase && !firestore.isEnabled()) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    if (command?.requiresOpenRouter && !hasOpenRouterConfig()) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error(`Autocomplete error for /${interaction.commandName}:`, err);
        await interaction.respond([]).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isMessageContextMenuCommand()) {
    if (!firestore.isEnabled()) {
      await safeInteractionReply(interaction, firebaseUnavailableMessage('Pokedex context actions'));
      return;
    }
    if (interaction.commandName === 'Exclude from Pokedex') {
      try { await excludeContextCommand.execute(interaction); }
      catch (err) { console.error('context-menu exclude failed:', err); await safeInteractionReply(interaction, 'Failed to exclude.'); }
    } else if (interaction.commandName === 'Add to Pokedex context') {
      try { await addContextMessageCommand.execute(interaction); }
      catch (err) { console.error('context-menu addcontext failed:', err); await safeInteractionReply(interaction, 'Failed to add context.'); }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  if (command.requiresFirebase && !firestore.isEnabled()) {
    await safeInteractionReply(interaction, firebaseUnavailableMessage(`/${interaction.commandName}`));
    return;
  }
  if (command.requiresOpenRouter && !hasOpenRouterConfig()) {
    await safeInteractionReply(interaction, openRouterUnavailableMessage(`/${interaction.commandName}`));
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    await safeInteractionReply(interaction, 'An error occurred.');
  }
});

// Button interaction handler for triage embeds
async function handleButtonInteraction(interaction) {
  const { customId } = interaction;
  const user = interaction.user;

  if (!firestore.isEnabled() && /^(triage_|fb_|mcp_|status_incidents_)/.test(customId)) {
    await interaction.reply({ content: firebaseUnavailableMessage('This button'), ephemeral: true }).catch(() => {});
    return;
  }

  // --- Changelog pagination buttons ---
  if (customId.startsWith('changelog_')) {
    return changelogCommand.handleChangelogButton(interaction);
  }

  // --- Status incident buttons ---
  if (customId.startsWith('status_incidents_')) {
    return statusCommand.handleIncidentButton(interaction);
  }

  // Parse button ID: triage_<action>_<issueId> or fb_<action>_<themeIndex>
  const ACTION_LABELS = {
    ack: { label: '👀 Acknowledged', color: 0x3498db, status: 'acknowledged' },
    fix: { label: '✅ Fixed', color: 0x2ecc71, status: 'fixed' },
    wontfix: { label: "🚫 Won't Fix", color: 0x95a5a6, status: 'wontfix' },
    escalate: { label: '🔺 Escalated', color: 0xe74c3c, status: 'escalated' },
  };

  // --- Issue triage buttons ---
  if (customId.startsWith('triage_')) {
    const parts = customId.split('_');
    const action = parts[1];
    const issueId = parts.slice(2).join('_');

    // Handle delete — soft-delete so the issue can still be reopened
    if (action === 'delete') {
      try {
        const admin = require('firebase-admin');
        const db = admin.firestore();
        await db.collection('issues').doc(issueId).update({
          status: 'deleted',
          deletedAt: new Date().toISOString(),
          deletedBy: interaction.user.id,
        });
        // Delete the triage message
        await interaction.message.delete();
      } catch (err) {
        console.error('Failed to delete issue:', err);
        await interaction.reply({ content: 'Failed to delete issue.', ephemeral: true });
      }
      return;
    }

    // Handle gather context — send Pokedex to the forum thread to ask more questions
    if (action === 'gather') {
      try {
        const issue = await firestore.getIssueById(issueId);
        if (!issue?.threadId) {
          await interaction.reply({ content: 'This issue has no linked thread.', ephemeral: true });
          return;
        }

        const thread = await interaction.guild.channels.fetch(issue.threadId);
        if (!thread) {
          await interaction.reply({ content: 'Could not find the linked thread.', ephemeral: true });
          return;
        }

        // Unarchive if needed
        if (thread.archived) {
          await thread.setArchived(false);
        }

        // Scrape conversation history (capped at 500 messages to prevent resource exhaustion)
        const allMessages = [];
        let lastId;
        const MAX_CONTEXT_MESSAGES = 500;
        while (allMessages.length < MAX_CONTEXT_MESSAGES) {
          const batch = await thread.messages.fetch({ limit: 100, ...(lastId && { before: lastId }) });
          if (batch.size === 0) break;
          allMessages.push(...batch.values());
          if (batch.size < 100) break;
          lastId = batch.last().id;
        }
        allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        const { evaluateContext, buildConversationHistory } = require('./services/contextEvaluator');
        const history = buildConversationHistory(allMessages, issue);
        const evaluation = await evaluateContext(issue, history, 'A developer needs more information on this issue.');

        if (evaluation.shouldReply && evaluation.reply) {
          await thread.send(evaluation.reply);
          await interaction.reply({ content: 'Sent follow-up in the forum post.', ephemeral: true });
        } else {
          await interaction.reply({ content: 'Context evaluator decided no follow-up is needed right now.', ephemeral: true });
        }
      } catch (err) {
        console.error('Failed to gather context:', err);
        await interaction.reply({ content: 'Failed to send follow-up.', ephemeral: true });
      }
      return;
    }

    const actionInfo = ACTION_LABELS[action];
    if (!actionInfo) return;

    // Update Firestore
    try {
      await firestore.updateIssueStatus(issueId, actionInfo.status, user.id);
    } catch (err) {
      console.error('Failed to update issue status:', err);
    }

    // Update the embed
    const message = interaction.message;
    const embed = EmbedBuilder.from(message.embeds[0]);
    embed.setColor(actionInfo.color);
    embed.addFields({ name: actionInfo.label, value: `by ${user.username} — <t:${Math.floor(Date.now() / 1000)}:R>` });

    // Keep every button enabled. Status is a transition state — a triager must be
    // able to move Acknowledged → Fixed later, still click Delete / Gather Context,
    // or correct a misclick. We re-render the same buttons (preserving their styles)
    // and rely on the appended embed field above as the running status log.
    // ActionRowBuilder, ButtonBuilder already imported at top
    const updatedRows = message.components.map(row => {
      const updatedRow = new ActionRowBuilder();
      for (const component of row.components) {
        updatedRow.addComponents(ButtonBuilder.from(component));
      }
      return updatedRow;
    });

    await interaction.update({ embeds: [embed], components: updatedRows });
    return;
  }

  // --- Feedback theme buttons ---
  if (customId.startsWith('fb_')) {
    const parts = customId.split('_');
    const action = parts[1];
    const themeIndex = parts[2];

    // Handle delete — just remove the message
    if (action === 'delete') {
      try {
        await interaction.message.delete();
      } catch (err) {
        console.error('Failed to delete feedback embed:', err);
        await interaction.reply({ content: 'Failed to delete.', ephemeral: true });
      }
      return;
    }

    const actionInfo = ACTION_LABELS[action];
    if (!actionInfo) return;

    // Update the embed
    const message = interaction.message;
    const embed = EmbedBuilder.from(message.embeds[0]);
    embed.setColor(actionInfo.color);
    embed.addFields({ name: actionInfo.label, value: `by ${user.username} — <t:${Math.floor(Date.now() / 1000)}:R>` });

    // Disable buttons after action
    // ActionRowBuilder, ButtonBuilder already imported at top
    const updatedRow = new ActionRowBuilder();
    for (const component of message.components[0].components) {
      const btn = ButtonBuilder.from(component);
      if (component.customId === customId) {
        btn.setDisabled(false);
      } else {
        btn.setDisabled(true);
      }
      updatedRow.addComponents(btn);
    }

    await interaction.update({ embeds: [embed], components: [updatedRow] });
    return;
  }

  // --- Duplicate detection buttons ---
  if (customId.startsWith('dupe_confirm_')) {
    // User confirms it's the same issue — just dismiss the embed
    const embed = EmbedBuilder.from(interaction.message.embeds[0]);
    embed.setColor(0x2ecc71);
    embed.setTitle('✅ Duplicate Confirmed');
    embed.setDescription('Thanks! Your report has been added as additional context to the existing issue.');
    await interaction.update({ embeds: [embed], components: [] });
    return;
  }

  if (customId.startsWith('dupe_new_')) {
    // User says it's NOT a duplicate — process as new issue
    const messageId = customId.replace('dupe_new_', '');
    const embed = EmbedBuilder.from(interaction.message.embeds[0]);
    embed.setColor(0x3498db);
    embed.setTitle('🆕 Creating New Issue');
    embed.setDescription('Got it — creating this as a separate issue.');
    await interaction.update({ embeds: [embed], components: [] });

    // Re-process the original message through the pipeline (skip dupe check)
    try {
      const channel = interaction.message.channel;
      const originalMsg = await channel.messages.fetch(interaction.message.reference?.messageId || messageId).catch(() => null);
      if (originalMsg) {
        const text = originalMsg.content.replace(/<@!?\d+>/g, '').trim();
        const { processIssueForced } = require('./services/pipeline');
        if (processIssueForced) {
          await processIssueForced(originalMsg, text);
        }
      }
    } catch (err) {
      console.error('Failed to re-process as new issue:', err);
    }
    return;
  }

  // --- Raffle buttons ---
  if (customId.startsWith('raffle_')) {
    try {
      await raffleCommand.handleRaffleButton(interaction);
    } catch (err) {
      console.error('Failed to process raffle interaction:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Failed to process raffle action.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // --- Recipe approval buttons ---
  if (customId.startsWith('recipe_')) {
    const isDeleteAction = customId.startsWith('recipe_delete_');

    // For delete: allow OP or mods. For approve/decline: mods only.
    if (isDeleteAction) {
      let allowed = canModerate(interaction.member);
      if (!allowed) {
        try {
          const prefix = 'recipe_delete_';
          const recipeId = customId.slice(prefix.length);
          const recipe = await firestore.getRecipeById(recipeId);
          if (recipe?.sharedBy?.some(s => s.id === interaction.user.id)) {
            allowed = true;
          }
        } catch {}
      }
      if (!allowed) {
        await interaction.reply({ content: 'You can only delete recipes you shared, or you need **Manage Messages** permission.', ephemeral: true }).catch(() => {});
        return;
      }
    } else if (!canModerate(interaction.member)) {
      await interaction.reply({ content: 'You need **Manage Messages** permission to approve or decline recipes.', ephemeral: true }).catch(() => {});
      return;
    }

    try {
      await recipesCommand.handleRecipeButton(interaction);
    } catch (err) {
      console.error('Failed to process recipe decision:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Failed to process recipe.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // --- MCP pending approval buttons ---
  if (customId.startsWith('mcp_')) {
    const isApprove = customId.startsWith('mcp_approve_');
    const isDecline = customId.startsWith('mcp_decline_') || customId.startsWith('mcp_delete_');
    if (!isApprove && !isDecline) return;

    if (!canModerate(interaction.member)) {
      await interaction.reply({ content: 'You need **Manage Messages** permission to approve or decline MCP issues.', ephemeral: true }).catch(() => {});
      return;
    }

    const decision = isApprove ? 'approve' : 'decline';
    const issueId = customId
      .replace('mcp_approve_', '')
      .replace('mcp_decline_', '')
      .replace('mcp_delete_', '');

    try {
      await interaction.deferReply({ ephemeral: true });

      const result = await processPendingDecision({
        guild: interaction.guild,
        channel: interaction.channel,
        issueId,
        decision,
        user,
      });

      if (!result.ok) {
        await interaction.editReply({ content: result.error }).catch(() => {});
        return;
      }

      await interaction.editReply({ content: result.message }).catch(() => {});
    } catch (err) {
      console.error('Failed to process MCP decision:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Failed to process MCP issue.' }).catch(() => {});
      } else {
        await interaction.reply({ content: 'Failed to process MCP issue.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }
}


// Startup
async function main() {
  firestore.init();
  config.setFirestoreService(firestore);
  await config.init();
  await registerCommands();
  startDashboard();
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
