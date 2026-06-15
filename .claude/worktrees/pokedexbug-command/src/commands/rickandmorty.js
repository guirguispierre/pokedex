const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const API_BASE = 'https://rickandmortyapi.com/api';

const QUOTES = [
  { text: "Wubba lubba dub dub!", character: "Rick Sanchez" },
  { text: "Nobody exists on purpose. Nobody belongs anywhere. Everybody's gonna die. Come watch TV.", character: "Morty Smith" },
  { text: "I'm not the villain, Morty. I'm the universe.", character: "Rick Sanchez" },
  { text: "Sometimes science is more art than science, Morty. A lot of people don't get that.", character: "Rick Sanchez" },
  { text: "Get your shit together. Get it all together and put it in a backpack.", character: "Morty Smith" },
  { text: "I'm sorry, but your opinion means very little to me.", character: "Rick Sanchez" },
  { text: "To live is to risk it all; otherwise you're just an inert chunk of randomly assembled molecules drifting wherever the universe blows you.", character: "Rick Sanchez" },
  { text: "I turned myself into a pickle, Morty! Boom! Big reveal! I'm Pickle Rick!", character: "Rick Sanchez" },
  { text: "The universe is basically an animal. It grazes on the ordinary.", character: "Rick Sanchez" },
  { text: "Listen, I'm not the nicest guy in the universe, because I'm the smartest.", character: "Rick Sanchez" },
  { text: "What, so everyone's supposed to sleep every single night now?", character: "Rick Sanchez" },
  { text: "I don't like it here, Morty. I can't abide bureaucracy.", character: "Rick Sanchez" },
  { text: "Your boos mean nothing! I've seen what makes you cheer!", character: "Rick Sanchez" },
  { text: "That's planning for failure, Morty. Even dumber than regular planning.", character: "Rick Sanchez" },
  { text: "Peace among worlds.", character: "Rick Sanchez" },
  { text: "Existence is pain to a Meeseeks, Jerry! And we will do anything to alleviate that pain!", character: "Mr. Meeseeks" },
  { text: "Aw, geez, Rick.", character: "Morty Smith" },
  { text: "I'm Mr. Meeseeks! Look at me!", character: "Mr. Meeseeks" },
  { text: "In bird culture, this is considered a dick move.", character: "Birdperson" },
  { text: "AIDS!", character: "Scary Terry" },
  { text: "And that's the waaaay the news goes!", character: "Rick Sanchez" },
  { text: "Hit the sack, Jack!", character: "Rick Sanchez" },
  { text: "Rikki-tikki-tavi, biiiitch!", character: "Rick Sanchez" },
  { text: "Grass... tastes bad.", character: "Rick Sanchez" },
  { text: "Lick lick lick my balls!", character: "Rick Sanchez" },
];

const BURPS = [
  "***BUUUUUURRRRRP*** ...excuse me.",
  "Listen M-*UURRRP*-orty, I need you to *BUURRRP* focus.",
  "*BRRAAAP* — oh that one had some dimension C-137 flavor.",
  "***BUURRRRRRRRRP*** ...where was I?",
  "*burp* Wubba lubba *BUUURRRP* dub dub!",
  "M-Morty *BUURP* — Morty you gotta *BRAAP* — you gotta listen to me Morty!",
  "***BRRRRRRAAAAAAP*** ...that's the sound of progress, Morty.",
  "*UURRRP* I'm not *burp* I'm not drunk, I'm *BUUURP* scientifically impaired.",
  "***BUUUUUURRRRRRRRP*** ...and that's the waaaay the news goes!",
  "*BRAAP* ...sorry, that one was from a different dimension.",
  "Let me just — *BUURRRP* — let me just portal out of this conversation.",
  "*burp* *burp* ***BRRRRAAAAAAAAAP*** ...okay THAT one I felt in my portal gun.",
];

const STATUS_EMOJI = { Alive: '🟢', Dead: '💀', unknown: '❓' };
const GENDER_EMOJI = { Male: '♂️', Female: '♀️', Genderless: '⚧', unknown: '❓' };

const commandData = new SlashCommandBuilder()
  .setName('rickandmorty')
  .setDescription('Rick and Morty lookup, quotes, and burps')
  .addSubcommand(sub =>
    sub.setName('character')
      .setDescription('Look up a Rick and Morty character')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Character name (e.g. Rick, Morty, Birdperson)').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('episode')
      .setDescription('Look up a Rick and Morty episode')
      .addIntegerOption(opt =>
        opt.setName('number').setDescription('Episode number (1-51)').setRequired(true).setMinValue(1).setMaxValue(51)))
  .addSubcommand(sub =>
    sub.setName('random')
      .setDescription('Get a random Rick and Morty character'))
  .addSubcommand(sub =>
    sub.setName('quote')
      .setDescription('Get a random Rick and Morty quote'))
  .addSubcommand(sub =>
    sub.setName('burp')
      .setDescription('*BUUURRRP*'));

function buildCharacterEmbed(char) {
  const statusEmoji = STATUS_EMOJI[char.status] || '❓';
  const genderEmoji = GENDER_EMOJI[char.gender] || '';

  return new EmbedBuilder()
    .setTitle(`${statusEmoji} ${char.name}`)
    .setColor(char.status === 'Alive' ? 0x44ff44 : char.status === 'Dead' ? 0xff4444 : 0x888888)
    .setThumbnail(char.image)
    .addFields(
      { name: 'Status', value: char.status, inline: true },
      { name: 'Species', value: char.species, inline: true },
      { name: 'Gender', value: `${genderEmoji} ${char.gender}`, inline: true },
      { name: 'Origin', value: char.origin?.name || 'Unknown', inline: true },
      { name: 'Location', value: char.location?.name || 'Unknown', inline: true },
      { name: 'Episodes', value: `Appeared in ${char.episode?.length || 0} episode(s)`, inline: true },
    )
    .setFooter({ text: `ID: ${char.id} | Data from rickandmortyapi.com` })
    .setTimestamp();
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'quote') {
    const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    const embed = new EmbedBuilder()
      .setDescription(`> *"${quote.text}"*`)
      .setColor(0x97ce4c)
      .setFooter({ text: `— ${quote.character}` });
    return interaction.reply({ embeds: [embed] });
  }

  if (sub === 'burp') {
    const burp = BURPS[Math.floor(Math.random() * BURPS.length)];
    return interaction.reply({ content: burp });
  }

  await interaction.deferReply();

  try {
    if (sub === 'character') {
      const name = interaction.options.getString('name').trim();
      const res = await fetch(`${API_BASE}/character/?name=${encodeURIComponent(name)}`);

      if (!res.ok) {
        return interaction.editReply(`No character found matching "${name}". Try Rick, Morty, Birdperson, etc.`);
      }

      const data = await res.json();
      if (!data.results?.length) {
        return interaction.editReply(`No character found matching "${name}".`);
      }

      const char = data.results[0];
      return interaction.editReply({ embeds: [buildCharacterEmbed(char)] });
    }

    if (sub === 'episode') {
      const num = interaction.options.getInteger('number');
      const res = await fetch(`${API_BASE}/episode/${num}`);

      if (!res.ok) {
        return interaction.editReply(`Episode ${num} not found. Try 1-51.`);
      }

      const ep = await res.json();

      // Fetch first few character names
      const charUrls = (ep.characters || []).slice(0, 8);
      const charNames = await Promise.all(
        charUrls.map(async url => {
          try {
            const r = await fetch(url);
            if (!r.ok) return 'Unknown';
            const c = await r.json();
            return c.name;
          } catch {
            return 'Unknown';
          }
        })
      );

      const remaining = (ep.characters?.length || 0) - charNames.length;
      let charList = charNames.join(', ');
      if (remaining > 0) charList += ` and ${remaining} more`;

      const embed = new EmbedBuilder()
        .setTitle(`${ep.episode} — ${ep.name}`)
        .setColor(0x97ce4c)
        .addFields(
          { name: 'Air Date', value: ep.air_date || 'Unknown', inline: true },
          { name: 'Episode Code', value: ep.episode || 'Unknown', inline: true },
          { name: `Characters (${ep.characters?.length || 0})`, value: charList || 'None listed' },
        )
        .setFooter({ text: `ID: ${ep.id} | Data from rickandmortyapi.com` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'random') {
      const randomId = Math.floor(Math.random() * 826) + 1;
      const res = await fetch(`${API_BASE}/character/${randomId}`);

      if (!res.ok) {
        return interaction.editReply('Failed to fetch a random character. Try again.');
      }

      const char = await res.json();
      return interaction.editReply({ embeds: [buildCharacterEmbed(char)] });
    }
  } catch (err) {
    console.error('Rick and Morty command failed:', err);
    await interaction.editReply('Something went wrong. Wubba lubba dub dub!');
  }
}

module.exports = { data: commandData, execute };
