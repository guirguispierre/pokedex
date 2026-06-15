const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

const statusColors = {
  pending: 0x5865f2,
  approved: 0x2ecc71,
  denied: 0xe74c3c,
  implemented: 0x9b59b6,
  considering: 0xe67e22,
};

const statusEmojis = {
  pending: '⏳',
  approved: '✅',
  denied: '❌',
  implemented: '🎉',
  considering: '🤔',
};

const moduleExports = {
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Submit, manage, or configure suggestions')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('idea')
        .setDescription('Submit a new suggestion')
        .addStringOption((option) =>
          option
            .setName('idea')
            .setDescription('Your suggestion')
            .setRequired(true)
            .setMaxLength(2000)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('Update a suggestion status (Moderator only)')
        .addStringOption((option) =>
          option
            .setName('id')
            .setDescription('The suggestion document ID')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName('status')
            .setDescription('New status')
            .setRequired(true)
            .addChoices(
              { name: 'Approved', value: 'approved' },
              { name: 'Denied', value: 'denied' },
              { name: 'Implemented', value: 'implemented' },
              { name: 'Considering', value: 'considering' }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('channel')
        .setDescription('Set the suggestions channel (Admin only)')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('The channel for suggestions')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'idea') {
      return handleIdea(interaction);
    } else if (subcommand === 'status') {
      return handleStatus(interaction);
    } else if (subcommand === 'channel') {
      return handleChannel(interaction);
    }
  },
};

async function handleIdea(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const idea = interaction.options.getString('idea');

    const db = getDb();
    const configDoc = await db.collection('suggest_config').doc(guildId).get();

    if (!configDoc.exists) {
      return interaction.editReply({
        content:
          '❌ Suggestions channel not configured. An admin must run `/suggest channel` first.',
      });
    }

    const channelId = configDoc.data().channelId;
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);

    if (!channel) {
      return interaction.editReply({
        content:
          '❌ Suggestions channel not found. An admin may need to reconfigure it with `/suggest channel`.',
      });
    }

    const embed = new EmbedBuilder()
      .setColor(statusColors.pending)
      .setTitle(`${statusEmojis.pending} New Suggestion`)
      .setDescription(idea)
      .setAuthor({ name: userName })
      .setTimestamp();

    const message = await channel.send({ embeds: [embed] });

    const docRef = db.collection('suggestions').doc();
    const docId = docRef.id;

    embed.setFooter({ text: `ID: ${docId}` });
    await message.edit({ embeds: [embed] });

    await docRef.set({
      guildId,
      messageId: message.id,
      authorId: userId,
      authorName: userName,
      idea,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await message.react('👍');
    await message.react('👎');

    return interaction.editReply({
      content: `✅ Suggestion submitted! (ID: \`${docId}\`)`,
    });
  } catch (error) {
    console.error('Error in handleIdea:', error);
    return interaction.editReply({
      content: '❌ An error occurred while submitting your suggestion.',
    });
  }
}

async function handleStatus(interaction) {
  try {
    if (!interaction.member.permissions.has('ManageMessages')) {
      return interaction.reply({
        content: '❌ You do not have permission to manage suggestions.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const docId = interaction.options.getString('id');
    const newStatus = interaction.options.getString('status');
    const guildId = interaction.guildId;

    const db = getDb();
    const docRef = db.collection('suggestions').doc(docId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return interaction.editReply({
        content: `❌ Suggestion with ID \`${docId}\` not found.`,
      });
    }

    const data = docSnap.data();

    if (data.guildId !== guildId) {
      return interaction.editReply({
        content:
          '❌ This suggestion does not belong to this guild.',
      });
    }

    const messageId = data.messageId;
    const channelId = (await db.collection('suggest_config').doc(guildId).get()).data()?.channelId;

    if (!channelId) {
      return interaction.editReply({
        content: '❌ Suggestions channel is not configured.',
      });
    }

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return interaction.editReply({
        content: '❌ Suggestions channel not found.',
      });
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      return interaction.editReply({
        content: '❌ Original suggestion message not found.',
      });
    }

    const embed = EmbedBuilder.from(message.embeds[0])
      .setColor(statusColors[newStatus])
      .setTitle(`${statusEmojis[newStatus]} ${capitalize(newStatus)}`);

    await message.edit({ embeds: [embed] });

    await docRef.update({
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return interaction.editReply({
      content: `✅ Suggestion status updated to **${capitalize(newStatus)}**.`,
    });
  } catch (error) {
    console.error('Error in handleStatus:', error);
    return interaction.editReply({
      content: '❌ An error occurred while updating the suggestion status.',
    });
  }
}

async function handleChannel(interaction) {
  try {
    if (!interaction.member.permissions.has('ManageGuild')) {
      return interaction.reply({
        content: '❌ You do not have permission to configure suggestions.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guildId;

    const db = getDb();
    await db.collection('suggest_config').doc(guildId).set({
      channelId: channel.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return interaction.editReply({
      content: `✅ Suggestions channel set to ${channel}.`,
    });
  } catch (error) {
    console.error('Error in handleChannel:', error);
    return interaction.editReply({
      content: '❌ An error occurred while setting the suggestions channel.',
    });
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

moduleExports.autocomplete = async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId;
  try {
    const db = getDb();
    const snapshot = await db.collection('suggestions')
      .where('guildId', '==', guildId)
      .orderBy('createdAt', 'desc')
      .limit(25)
      .get();
    const filtered = snapshot.docs
      .filter(doc => {
        const d = doc.data();
        return doc.id.toLowerCase().includes(focused) ||
          (d.idea || '').toLowerCase().includes(focused) ||
          (d.authorName || '').toLowerCase().includes(focused);
      })
      .slice(0, 25)
      .map(doc => {
        const d = doc.data();
        return {
          name: `${(d.status || 'pending').toUpperCase()} | ${d.authorName || '?'} | ${(d.idea || '').slice(0, 55)}`,
          value: doc.id,
        };
      });
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
};

module.exports = moduleExports;