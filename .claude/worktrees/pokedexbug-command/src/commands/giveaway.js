const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

const moduleExports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage giveaways')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('Start a new giveaway')
        .addStringOption((option) =>
          option
            .setName('prize')
            .setDescription('What is being given away')
            .setRequired(true)
        )
        .addIntegerOption((option) =>
          option
            .setName('duration')
            .setDescription('Duration in minutes (1-10080, max 7 days)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(10080)
        )
        .addIntegerOption((option) =>
          option
            .setName('winners')
            .setDescription('Number of winners to select (1-10)')
            .setMinValue(1)
            .setMaxValue(10)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reroll')
        .setDescription('Re-pick a winner from a giveaway')
        .addStringOption((option) =>
          option
            .setName('message_id')
            .setDescription('Message ID of the giveaway')
            .setRequired(true)
            .setAutocomplete(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'start') {
      await handleStart(interaction);
    } else if (subcommand === 'reroll') {
      await handleReroll(interaction);
    }
  },
};

async function handleStart(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const prize = interaction.options.getString('prize');
  const duration = interaction.options.getInteger('duration');
  const winners = interaction.options.getInteger('winners') || 1;

  const endTime = Date.now() + duration * 60 * 1000;

  // Create embed
  const embed = new EmbedBuilder()
    .setColor('#FF00FF')
    .setTitle('🎉 GIVEAWAY 🎉')
    .addFields(
      { name: 'Prize', value: prize, inline: false },
      { name: 'Winners', value: `${winners}`, inline: true },
      { name: 'Ends In', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: true }
    )
    .setFooter({ text: 'React with 🎉 to enter!' });

  // Send message
  const giveawayMessage = await interaction.channel.send({ embeds: [embed] });
  await giveawayMessage.react('🎉');

  // Store in Firestore
  const db = getDb();
  const giveawayData = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: giveawayMessage.id,
    prize,
    winners,
    endTime: admin.firestore.Timestamp.fromDate(new Date(endTime)),
    ended: false,
    hostId: interaction.user.id,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection('giveaways').doc(giveawayMessage.id).set(giveawayData);

  // Schedule end
  scheduleGiveawayEnd(
    interaction.client,
    giveawayMessage.id,
    giveawayMessage,
    winners,
    duration * 60 * 1000
  );

  await interaction.editReply({
    content: `✅ Giveaway started! Prize: **${prize}** | Duration: **${duration} minutes** | Winners: **${winners}**`,
  });
}

async function handleReroll(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const messageId = interaction.options.getString('message_id');
  const db = getDb();

  // Fetch giveaway from Firestore
  const giveawaySnap = await db.collection('giveaways').doc(messageId).get();

  if (!giveawaySnap.exists) {
    return interaction.editReply({
      content: '❌ Giveaway not found. Make sure you have the correct message ID.',
    });
  }

  const giveawayData = giveawaySnap.data();

  if (!giveawayData.ended) {
    return interaction.editReply({
      content: '❌ This giveaway has not ended yet.',
    });
  }

  try {
    const channel = await interaction.client.channels.fetch(giveawayData.channelId);
    const message = await channel.messages.fetch(giveawayData.messageId);

    // Get reactions
    const reaction = message.reactions.cache.find((r) => r.emoji.name === '🎉');
    if (!reaction) {
      return interaction.editReply({
        content: '❌ No reactions found on this giveaway.',
      });
    }

    const users = await reaction.users.fetch();
    const validUsers = users.filter((user) => !user.bot);

    if (validUsers.size < giveawayData.winners) {
      return interaction.editReply({
        content: `❌ Not enough participants. Need ${giveawayData.winners}, found ${validUsers.size}.`,
      });
    }

    // Pick new winner(s)
    const winners = [];
    const userArray = Array.from(validUsers.values());

    for (let i = 0; i < giveawayData.winners; i++) {
      const randomIndex = Math.floor(Math.random() * userArray.length);
      winners.push(userArray[randomIndex]);
      userArray.splice(randomIndex, 1);
    }

    // Update embed with new winners
    const winnerMentions = winners.map((w) => `<@${w.id}>`).join(', ');
    const embed = EmbedBuilder.from(message.embeds[0]).addFields({
      name: 'Rerolled Winners',
      value: winnerMentions || 'No valid participants',
      inline: false,
    });

    await message.edit({ embeds: [embed] });

    await interaction.editReply({
      content: `✅ Reroll complete! New winner(s): ${winnerMentions}`,
    });
  } catch (error) {
    console.error('Reroll error:', error);
    await interaction.editReply({
      content: '❌ Error rerolling giveaway. Please check the message ID and try again.',
    });
  }
}

function scheduleGiveawayEnd(client, messageId, message, winners, duration) {
  setTimeout(async () => {
    try {
      const db = getDb();

      // Fetch current message to get latest reactions
      const freshMessage = await message.channel.messages.fetch(messageId);
      const reaction = freshMessage.reactions.cache.find((r) => r.emoji.name === '🎉');

      if (!reaction) {
        const embed = EmbedBuilder.from(freshMessage.embeds[0]).addFields({
          name: 'Result',
          value: 'No participants. Giveaway ended.',
          inline: false,
        });
        await freshMessage.edit({ embeds: [embed] });

        await db.collection('giveaways').doc(messageId).update({ ended: true });
        return;
      }

      // Get all users who reacted
      const users = await reaction.users.fetch();
      const validUsers = users.filter((user) => !user.bot);

      if (validUsers.size === 0) {
        const embed = EmbedBuilder.from(freshMessage.embeds[0]).addFields({
          name: 'Result',
          value: 'No valid participants. Giveaway ended.',
          inline: false,
        });
        await freshMessage.edit({ embeds: [embed] });

        await db.collection('giveaways').doc(messageId).update({ ended: true });
        return;
      }

      // Pick random winners
      const winnerCount = Math.min(winners, validUsers.size);
      const selectedWinners = [];
      const userArray = Array.from(validUsers.values());

      for (let i = 0; i < winnerCount; i++) {
        const randomIndex = Math.floor(Math.random() * userArray.length);
        selectedWinners.push(userArray[randomIndex]);
        userArray.splice(randomIndex, 1);
      }

      // Update embed
      const winnerMentions = selectedWinners.map((w) => `<@${w.id}>`).join(', ');
      const embed = EmbedBuilder.from(freshMessage.embeds[0]).addFields({
        name: 'Winners',
        value: winnerMentions,
        inline: false,
      });

      await freshMessage.edit({ embeds: [embed] });

      // Send congratulations message
      await freshMessage.reply({
        content: `🎉 **Congratulations ${winnerMentions}!** You won the giveaway!`,
      });

      // Update Firestore
      await db.collection('giveaways').doc(messageId).update({ ended: true });
    } catch (error) {
      console.error('Giveaway end error:', error);
    }
  }, duration);
}

moduleExports.autocomplete = async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId;
  try {
    const db = getDb();
    const snapshot = await db.collection('giveaways')
      .where('guildId', '==', guildId)
      .orderBy('createdAt', 'desc')
      .limit(25)
      .get();
    const filtered = snapshot.docs
      .filter(doc => {
        const d = doc.data();
        return doc.id.includes(focused) || (d.prize || '').toLowerCase().includes(focused);
      })
      .slice(0, 25)
      .map(doc => {
        const d = doc.data();
        return {
          name: `${d.ended ? 'ENDED' : 'ACTIVE'} | ${(d.prize || 'Unknown').slice(0, 60)}`,
          value: doc.id,
        };
      });
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
};

module.exports = moduleExports;
