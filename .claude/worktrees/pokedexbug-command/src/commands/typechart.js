const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const POKEAPI_URL = 'https://pokeapi.co/api/v2';

const TYPE_COLORS = {
  normal: 0xa8a878,
  fire: 0xf08030,
  water: 0x6890f0,
  electric: 0xf8d030,
  grass: 0x78c850,
  ice: 0x98d8d8,
  fighting: 0xc03028,
  poison: 0xa040a0,
  ground: 0xe0c068,
  flying: 0xa890f0,
  psychic: 0xf85888,
  bug: 0xa8b820,
  rock: 0xb8a038,
  ghost: 0x705898,
  dragon: 0x7038f8,
  dark: 0x705848,
  steel: 0xb8b8d0,
  fairy: 0xee99ac,
};

const commandData = new SlashCommandBuilder()
  .setName('typechart')
  .setDescription('Look up Pokemon type strengths, weaknesses, and sample Pokemon')
  .addStringOption(opt =>
    opt.setName('type')
      .setDescription('Pokemon type, like fire or dragon')
      .setRequired(true));

async function execute(interaction) {
  const query = interaction.options.getString('type').toLowerCase().trim();
  await interaction.deferReply();

  try {
    const response = await fetch(`${POKEAPI_URL}/type/${query}`);
    if (!response.ok) {
      return interaction.editReply(`Could not find type "${query}". Try something like \`fire\`, \`water\`, or \`dragon\`.`);
    }

    const data = await response.json();
    const damage = data.damage_relations || {};

    const embed = new EmbedBuilder()
      .setTitle(`${capitalize(data.name)} Type Chart`)
      .setColor(TYPE_COLORS[data.name] || 0x5865f2)
      .setDescription('Offensive and defensive matchups from PokeAPI.')
      .addFields(
        { name: 'Attacks Are Strong Against', value: formatTypes(damage.double_damage_to), inline: true },
        { name: 'Attacks Are Weak Against', value: formatTypes(damage.half_damage_to), inline: true },
        { name: 'Attacks Do Nothing To', value: formatTypes(damage.no_damage_to), inline: true },
        { name: 'Weak To', value: formatTypes(damage.double_damage_from), inline: true },
        { name: 'Resists', value: formatTypes(damage.half_damage_from), inline: true },
        { name: 'Immune To', value: formatTypes(damage.no_damage_from), inline: true },
      )
      .setFooter({ text: 'Data from PokeAPI' });

    const samplePokemon = (data.pokemon || [])
      .slice(0, 10)
      .map(entry => capitalize(entry.pokemon.name))
      .join(', ');

    if (samplePokemon) {
      embed.addFields({ name: 'Sample Pokemon', value: samplePokemon });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('Type chart lookup failed:', err);
    await interaction.editReply('Failed to look up that type. Try again.');
  }
}

function formatTypes(types) {
  if (!Array.isArray(types) || types.length === 0) return 'None';
  return types.map(type => capitalize(type.name)).join(', ');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { data: commandData, execute };
