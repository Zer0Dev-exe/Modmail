require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, ChannelType, ActivityType } = require('discord.js');
const mongoose = require('mongoose');
const { Ticket } = require('./models');
const { getConfig } = require('./config');
const { handleDM, closeTicket, startAutoCloseLoop } = require('./tickets');
const { handleCommand, handleInteraction, registerSlashCommands } = require('./commands');
const env = require('./env');

for (const key of ['DISCORD_TOKEN', 'GUILD_ID', 'MONGODB_URI']) {
  if (!process.env[key]) {
    console.error(`Falta la variable ${key} en el archivo .env`);
    process.exit(1);
  }
}

if (!env.SLASH && !env.PREFIX) {
  console.error('SLASH y PREFIX están desactivados en el .env: activa al menos uno.');
  process.exit(1);
}
console.log(`Comandos: slash ${env.SLASH ? 'activados' : 'desactivados'} · prefijo ${env.PREFIX ? 'activado' : 'desactivado'}`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    // Solo hace falta para leer comandos con prefijo; el contenido de los MD llega igualmente
    ...(env.PREFIX ? [GatewayIntentBits.MessageContent] : []),
  ],
  // Necesario para recibir mensajes directos
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Conectado como ${c.user.tag}`);
  const status = 'Envíame un MD para contactar con el staff';
  c.user.setPresence({ activities: [{ name: status, state: status, type: ActivityType.Custom }] });
  if (!c.guilds.cache.has(process.env.GUILD_ID)) {
    console.warn('⚠️ El bot no está en el servidor indicado en GUILD_ID.');
  }
  startAutoCloseLoop(c);
  registerSlashCommands(c).catch((err) => console.error('Error registrando los comandos slash:', err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(client, interaction);
  } catch (err) {
    console.error('Error procesando interacción:', err);
    if (interaction.deferred) await interaction.editReply({ content: '❌ Ha ocurrido un error inesperado.' }).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.system) return;
  try {
    if (message.channel.type === ChannelType.DM) return await handleDM(client, message);
    if (message.guildId === process.env.GUILD_ID) await handleCommand(client, message);
  } catch (err) {
    console.error('Error procesando mensaje:', err);
  }
});

// Si alguien borra a mano el canal de un ticket, se cierra y se guarda el transcript
client.on(Events.ChannelDelete, async (channel) => {
  try {
    const ticket = await Ticket.findOne({ channelId: channel.id, open: true });
    if (!ticket) return;
    const cfg = await getConfig(channel.guild.id);
    await closeTicket({ guild: channel.guild, cfg, ticket, reason: 'Canal eliminado manualmente', silent: true, channelDeleted: true });
  } catch (err) {
    console.error('Error cerrando ticket de canal eliminado:', err);
  }
});

process.on('unhandledRejection', (err) => console.error('Promesa rechazada sin manejar:', err));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB');
  await client.login(process.env.DISCORD_TOKEN);
})().catch((err) => {
  console.error('Error al arrancar:', err);
  process.exit(1);
});
