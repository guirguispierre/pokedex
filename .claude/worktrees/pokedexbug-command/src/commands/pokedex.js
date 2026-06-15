const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const POKEAPI_URL = 'https://pokeapi.co/api/v2';

const commandData = new SlashCommandBuilder()
  .setName('pokedex')
  .setDescription('Look up a Pokemon')
  .addStringOption(opt =>
    opt.setName('pokemon')
      .setDescription('Pokemon name or number')
      .setRequired(true));

const TYPE_COLORS = {
  normal: 0xa8a878, fire: 0xf08030, water: 0x6890f0, electric: 0xf8d030,
  grass: 0x78c850, ice: 0x98d8d8, fighting: 0xc03028, poison: 0xa040a0,
  ground: 0xe0c068, flying: 0xa890f0, psychic: 0xf85888, bug: 0xa8b820,
  rock: 0xb8a038, ghost: 0x705898, dragon: 0x7038f8, dark: 0x705848,
  steel: 0xb8b8d0, fairy: 0xee99ac,
};

async function execute(interaction) {
  const query = interaction.options.getString('pokemon').toLowerCase().trim();
  await interaction.deferReply();

  try {
    // Fetch pokemon data and species data in parallel
    const [pokemonRes, speciesRes] = await Promise.allSettled([
      fetch(`${POKEAPI_URL}/pokemon/${query}`),
      fetch(`${POKEAPI_URL}/pokemon-species/${query}`),
    ]);

    if (pokemonRes.status === 'rejected' || !pokemonRes.value.ok) {
      return interaction.editReply(`Could not find Pokemon "${query}". Try a name (pikachu) or number (25).`);
    }

    const pokemon = await pokemonRes.value.json();
    const species = speciesRes.status === 'fulfilled' && speciesRes.value.ok
      ? await speciesRes.value.json()
      : null;

    // Get English flavor text
    let flavorText = '';
    if (species?.flavor_text_entries) {
      const entry = species.flavor_text_entries.find(e => e.language.name === 'en');
      flavorText = entry?.flavor_text?.replace(/[\n\f\r]/g, ' ') || '';
    }

    // Get English genus
    let genus = '';
    if (species?.genera) {
      const g = species.genera.find(e => e.language.name === 'en');
      genus = g?.genus || '';
    }

    const types = pokemon.types.map(t => t.type.name);
    const primaryType = types[0];
    const color = TYPE_COLORS[primaryType] || 0x5865f2;

    const stats = pokemon.stats.map(s => {
      const name = s.stat.name
        .replace('hp', 'HP')
        .replace('attack', 'Atk')
        .replace('defense', 'Def')
        .replace('special-attack', 'SpA')
        .replace('special-defense', 'SpD')
        .replace('speed', 'Spe');
      const bar = '█'.repeat(Math.round(s.base_stat / 15)) + '░'.repeat(Math.max(0, 10 - Math.round(s.base_stat / 15)));
      return `\`${name.padEnd(3)}\` ${bar} **${s.base_stat}**`;
    }).join('\n');

    const totalStats = pokemon.stats.reduce((sum, s) => sum + s.base_stat, 0);

    const abilities = pokemon.abilities
      .map(a => a.is_hidden ? `*${a.ability.name}* (hidden)` : a.ability.name)
      .join(', ');

    const sprite = pokemon.sprites.other?.['official-artwork']?.front_default
      || pokemon.sprites.front_default;

    const embed = new EmbedBuilder()
      .setTitle(`#${pokemon.id} — ${capitalize(pokemon.name)}`)
      .setColor(color)
      .setThumbnail(sprite);

    if (genus) embed.setDescription(`*${genus}*`);

    embed.addFields(
      { name: 'Type', value: types.map(t => capitalize(t)).join(' / '), inline: true },
      { name: 'Height', value: `${(pokemon.height / 10).toFixed(1)}m`, inline: true },
      { name: 'Weight', value: `${(pokemon.weight / 10).toFixed(1)}kg`, inline: true },
      { name: 'Abilities', value: abilities || 'None' },
      { name: 'Base Stats', value: stats },
      { name: 'Total', value: `**${totalStats}**`, inline: true },
    );

    if (species?.capture_rate !== undefined) {
      embed.addFields({ name: 'Catch Rate', value: `${species.capture_rate}`, inline: true });
    }

    if (species?.base_happiness !== undefined) {
      embed.addFields({ name: 'Base Happiness', value: `${species.base_happiness}`, inline: true });
    }

    if (flavorText) {
      embed.addFields({ name: 'Pokedex Entry', value: flavorText });
    }

    embed.setFooter({ text: 'Data from PokeAPI' });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('Pokedex lookup failed:', err);
    await interaction.editReply('Failed to look up that Pokemon. Try again.');
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { data: commandData, execute };
