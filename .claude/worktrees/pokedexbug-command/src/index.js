require('dotenv/config');
const { Client, GatewayIntentBits, Partials, REST, Routes, ActivityType, EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const firestore = require('./services/firestore');
const config = require('./config/config');
const triage = require('./services/triage');
const { handleMention } = require('./triggers/mention');
const { handleReaction } = require('./triggers/reaction');
const { handleThreadMessage } = require('./triggers/thread');
const { handleForumPost } = require('./triggers/forum');
// pending poller replaced by instant webhook message detection
const configCommand = require('./commands/config');
const helpCommand = require('./commands/help');
const changelogCommand = require('./commands/changelog');
const feedbackCommand = require('./commands/feedback');
const issueCommand = require('./commands/issue');
const pingCommand = require('./commands/ping');
const lockCommand = require('./commands/lock');
const unlockCommand = require('./commands/unlock');
const leaderboardCommand = require('./commands/leaderboard');
const pokedexCommand = require('./commands/pokedex');
const pokedexbugCommand = require('./commands/pokedexbug');
const typechartCommand = require('./commands/typechart');
const serverinfoCommand = require('./commands/serverinfo');
const afkCommand = require('./commands/afk');
const levelCommand = require('./commands/level');
const warnCommand = require('./commands/warn');
const timeoutCommand = require('./commands/timeout');
const kickCommand = require('./commands/kick');
const banCommand = require('./commands/ban');
const purgeCommand = require('./commands/purge');
const slowmodeCommand = require('./commands/slowmode');
const deletethreadCommand = require('./commands/deletethread');
const mergeCommand = require('./commands/merge');
const starboardCommand = require('./commands/starboard');
const pollCommand = require('./commands/poll');
const welcomeCommand = require('./commands/welcome');
const reactionroleCommand = require('./commands/reactionrole');
const giveawayCommand = require('./commands/giveaway');
const suggestCommand = require('./commands/suggest');
const creatorCommand = require('./commands/creator');
const rickandmortyCommand = require('./commands/rickandmorty');
const automodCommand = require('./commands/automod');
const automod = require('./services/automod');
const feedbackTriageCommand = require('./commands/feedbacktriage');
const recipesCommand = require('./commands/recipes');
const {
  canModerate,
  processPendingDecision,
  syncPendingWebhookMessage,
} = require('./services/mcpApproval');
const { startDashboard } = require('./dashboard/server');

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

// Register slash commands guild-scoped
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, process.env.DISCORD_GUILD_ID),
    { body: [configCommand.data.toJSON(), helpCommand.data.toJSON(), changelogCommand.data.toJSON(), feedbackCommand.data.toJSON(), issueCommand.data.toJSON(), pingCommand.data.toJSON(), lockCommand.data.toJSON(), unlockCommand.data.toJSON(), leaderboardCommand.data.toJSON(), pokedexCommand.data.toJSON(), pokedexbugCommand.data.toJSON(), typechartCommand.data.toJSON(), serverinfoCommand.data.toJSON(), afkCommand.data.toJSON(), levelCommand.data.toJSON(), warnCommand.data.toJSON(), timeoutCommand.data.toJSON(), kickCommand.data.toJSON(), banCommand.data.toJSON(), purgeCommand.data.toJSON(), slowmodeCommand.data.toJSON(), deletethreadCommand.data.toJSON(), mergeCommand.data.toJSON(), starboardCommand.data.toJSON(), pollCommand.data.toJSON(), welcomeCommand.data.toJSON(), reactionroleCommand.data.toJSON(), giveawayCommand.data.toJSON(), suggestCommand.data.toJSON(), creatorCommand.data.toJSON(), rickandmortyCommand.data.toJSON(), automodCommand.data.toJSON(), feedbackTriageCommand.data.toJSON(), recipesCommand.data.toJSON()] },
  );
  console.log('Slash commands registered.');
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Set rich presence
  client.user.setPresence({
    activities: [{ name: 'for bugs | /help + @pierre for support', type: ActivityType.Watching }],
    status: 'online',
  });

  // Check for triage channel
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (guild) {
    const triageChannel = triage.findTriageChannel(guild);
    if (!triageChannel) {
      const warning = `WARNING: Triage channel "${config.getConfig('triage_channel')}" not found. Please create it and restart the bot.`;
      console.warn(warning);
      guild.systemChannel?.send(warning).catch(() => {});
    }

    // Start digest scheduler
    triage.startDigestScheduler(guild);
  }
});

// Handle @mentions, thread follow-ups, and webhook pending messages
client.on('messageCreate', async (message) => {
  if (message.webhookId) {
    try {
      const handled = await syncPendingWebhookMessage(message);
      if (handled) return;
    } catch (err) {
      console.error('Error handling webhook pending:', err);
    }
  }

  if (message.author.bot) return;

  // AutoMod — check for spam, blocked content, etc. before other handlers
  try {
    const automodResult = await automod.handleMessage(message);
    if (automodResult) return; // Message was handled by automod (deleted)
  } catch (err) {
    console.error('Error in automod:', err);
  }

  // AFK system — runs on every non-bot message (welcome back + mention notices)
  try {
    await afkCommand.handleAfkMentions(message);
  } catch (err) {
    console.error('Error handling AFK:', err);
  }

  // XP / Level system — award XP for every non-bot message (with cooldown)
  try {
    await levelCommand.awardXP(message);
  } catch (err) {
    console.error('Error awarding XP:', err);
  }

  // Check if this is a message in an issue thread — route ALL thread messages
  // through the thread handler first (even @mentions) to prevent duplicate issues
  if (message.channel.isThread()) {
    try {
      const handled = await handleThreadMessage(message);
      if (handled) return; // Was an issue thread — context appended, don't create new issue
    } catch (err) {
      console.error('Error handling thread message:', err);
    }
    // Not an issue thread — fall through to mention handler if applicable
  }

  if (!message.mentions.has(client.user)) return;

  try {
    await handleMention(message);
  } catch (err) {
    console.error('Error handling mention:', err);
  }
});

client.on('threadCreate', async (thread) => {
  try {
    await handleForumPost(thread);
  } catch (err) {
    console.error('Error handling forum post:', err);
  }
});

// Handle emoji reactions
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    await handleReaction(reaction, user);
  } catch (err) {
    console.error('Error handling reaction:', err);
  }

  // Starboard — check for ⭐ reactions
  try {
    await starboardCommand.handleStarReaction(reaction, user);
  } catch (err) {
    console.error('Error handling starboard:', err);
  }

  // Reaction roles — add role on react
  try {
    await reactionroleCommand.handleReactionRoleAdd(reaction, user);
  } catch (err) {
    console.error('Error handling reaction role add:', err);
  }
});

// Reaction role removal
client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (reaction.partial) await reaction.fetch().catch(() => {});
    await reactionroleCommand.handleReactionRoleRemove(reaction, user);
  } catch (err) {
    console.error('Error handling reaction role remove:', err);
  }
});

// Welcome / Goodbye
client.on('guildMemberAdd', async (member) => {
  // AutoMod — raid detection
  try {
    await automod.handleJoin(member);
  } catch (err) {
    console.error('Error in automod raid check:', err);
  }

  try {
    await welcomeCommand.handleMemberJoin(member);
  } catch (err) {
    console.error('Error handling member join:', err);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    await welcomeCommand.handleMemberLeave(member);
  } catch (err) {
    console.error('Error handling member leave:', err);
  }
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
    const commands = { issue: issueCommand, merge: mergeCommand, warn: warnCommand, suggest: suggestCommand, giveaway: giveawayCommand, 'feedback-triage': feedbackTriageCommand, recipes: recipesCommand };
    const command = commands[interaction.commandName];
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

  if (!interaction.isChatInputCommand()) return;
  const commands = { config: configCommand, help: helpCommand, changelog: changelogCommand, feedback: feedbackCommand, issue: issueCommand, ping: pingCommand, lock: lockCommand, unlock: unlockCommand, leaderboard: leaderboardCommand, pokedex: pokedexCommand, pokedexbug: pokedexbugCommand, typechart: typechartCommand, serverinfo: serverinfoCommand, afk: afkCommand, level: levelCommand, warn: warnCommand, timeout: timeoutCommand, kick: kickCommand, ban: banCommand, purge: purgeCommand, slowmode: slowmodeCommand, deletethread: deletethreadCommand, merge: mergeCommand, starboard: starboardCommand, poll: pollCommand, welcome: welcomeCommand, reactionrole: reactionroleCommand, giveaway: giveawayCommand, suggest: suggestCommand, creator: creatorCommand, rickandmorty: rickandmortyCommand, automod: automodCommand, 'feedback-triage': feedbackTriageCommand, recipes: recipesCommand };
  const command = commands[interaction.commandName];
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    if (!interaction.replied) {
      await interaction.reply({ content: 'An error occurred.', ephemeral: true });
    }
  }
});

// Button interaction handler for triage embeds
async function handleButtonInteraction(interaction) {
  const { customId } = interaction;
  const user = interaction.user;

  // --- Changelog pagination buttons ---
  if (customId.startsWith('changelog_')) {
    return changelogCommand.handleChangelogButton(interaction);
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
        const history = buildConversationHistory(allMessages);
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

    // Disable buttons after action and highlight the one clicked
    // ActionRowBuilder, ButtonBuilder already imported at top
    const updatedRows = message.components.map(row => {
      const updatedRow = new ActionRowBuilder();
      for (const component of row.components) {
        const btn = ButtonBuilder.from(component);
        if (component.customId === customId) {
          btn.setDisabled(false);
          btn.setStyle(2);
        } else {
          btn.setDisabled(true);
        }
        updatedRow.addComponents(btn);
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

  // --- Recipe approval buttons ---
  if (customId.startsWith('recipe_')) {
    if (!canModerate(interaction.member)) {
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
