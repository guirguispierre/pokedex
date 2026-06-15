const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

function getDb() {
  return admin.firestore();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Set up reaction role messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(subcommand =>
      subcommand
        .setName('setup')
        .setDescription('Create a reaction role message in the current channel')
        .addStringOption(option =>
          option
            .setName('title')
            .setDescription('Title for the role menu embed')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('roles')
            .setDescription('Comma-separated emoji:@role pairs (e.g., 🎮:@Gamer,🎵:@Music)')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    // Check if user has ManageRoles permission
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({
        content: 'You need the **Manage Roles** permission to use this command.',
        ephemeral: true,
      });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setup') {
      await handleSetup(interaction);
    }
  },
};

async function handleSetup(interaction) {
  await interaction.deferReply();

  const title = interaction.options.getString('title');
  const rolesString = interaction.options.getString('roles');

  // Parse the roles string
  const rolePairs = rolesString.split(',').map(pair => pair.trim());
  const roleMap = {};
  const fields = [];

  try {
    for (const pair of rolePairs) {
      const [emoji, roleMention] = pair.split(':').map(p => p.trim());

      if (!emoji || !roleMention) {
        return interaction.editReply({
          content: `Invalid format: "${pair}". Use format "emoji:@role"`,
        });
      }

      // Extract role from mention or name
      const roleId = roleMention.replace(/[<@&>]/g, '');
      let role;

      try {
        role = await interaction.guild.roles.fetch(roleId);
      } catch {
        return interaction.editReply({
          content: `Role "${roleMention}" not found. Make sure it exists in this server.`,
        });
      }

      roleMap[emoji] = role.id;
      fields.push({
        name: `${emoji} ${role.name}`,
        value: `React with ${emoji} to get the ${role.name} role`,
        inline: false,
      });
    }

    if (fields.length === 0) {
      return interaction.editReply({
        content: 'No valid role pairs provided.',
      });
    }

    // Create the embed
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription('React below to assign yourself roles!')
      .addFields(fields)
      .setColor('#3498db')
      .setTimestamp();

    // Send the message
    const message = await interaction.channel.send({ embeds: [embed] });

    // Add reactions
    for (const emoji of Object.keys(roleMap)) {
      await message.react(emoji).catch(() => {
        // Silently ignore if emoji is invalid
      });
    }

    // Store in Firestore
    const db = getDb();
    await db.collection('reaction_roles').doc(message.id).set({
      messageId: message.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      roles: roleMap,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: interaction.user.id,
    });

    return interaction.editReply({
      content: `Reaction role message created! Message ID: ${message.id}`,
      ephemeral: true,
    });
  } catch (error) {
    console.error('Error in reactionrole setup:', error);
    return interaction.editReply({
      content: 'An error occurred while setting up the reaction role message.',
    });
  }
}

async function handleReactionRoleAdd(reaction, user) {
  // Ignore bots
  if (user.bot) return;

  try {
    const db = getDb();
    const doc = await db.collection('reaction_roles').doc(reaction.message.id).get();

    if (!doc.exists) {
      return; // Message not tracked
    }

    const data = doc.data();
    const roleId = data.roles[reaction.emoji.toString()];

    if (!roleId) {
      return; // Emoji not mapped
    }

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    const role = await guild.roles.fetch(roleId);

    if (!role) {
      console.warn(`Role ${roleId} not found for reaction role ${reaction.message.id}`);
      return;
    }

    await member.roles.add(role);
  } catch (error) {
    console.error('Error handling reaction role add:', error);
  }
}

async function handleReactionRoleRemove(reaction, user) {
  // Ignore bots
  if (user.bot) return;

  try {
    const db = getDb();
    const doc = await db.collection('reaction_roles').doc(reaction.message.id).get();

    if (!doc.exists) {
      return; // Message not tracked
    }

    const data = doc.data();
    const roleId = data.roles[reaction.emoji.toString()];

    if (!roleId) {
      return; // Emoji not mapped
    }

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    const role = await guild.roles.fetch(roleId);

    if (!role) {
      console.warn(`Role ${roleId} not found for reaction role ${reaction.message.id}`);
      return;
    }

    await member.roles.remove(role);
  } catch (error) {
    console.error('Error handling reaction role remove:', error);
  }
}

module.exports.handleReactionRoleAdd = handleReactionRoleAdd;
module.exports.handleReactionRoleRemove = handleReactionRoleRemove;
