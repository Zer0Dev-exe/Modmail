const fs = require('node:fs');
const path = require('node:path');
const { MessageFlags } = require('discord.js');
const { Ticket } = require('../models');
const { getConfig } = require('../config');
const { buildDefinition, createAdapter } = require('../slash');
const env = require('../env');
const U = require('../util');

const commands = [];
const lookup = new Map();
const slashLookup = new Map();
for (const file of fs.readdirSync(__dirname).filter((f) => f !== 'index.js' && f.endsWith('.js'))) {
  for (const cmd of require(path.join(__dirname, file))) {
    commands.push(cmd);
    for (const name of [cmd.name, ...(cmd.aliases ?? [])]) lookup.set(name, cmd);
    if (cmd.slash) slashLookup.set(cmd.slash.name ?? cmd.name, cmd);
  }
}

/** Comprobaciones comunes (staff, admin, ticket) y ejecución, venga el comando de prefijo o de slash. */
async function executeCommand({ client, message, cmd, cfg, prefix, getArgs, isSlash }) {
  const member = message.member ?? await message.guild.members.fetch(message.author.id);
  if (!U.isStaff(member, cfg)) {
    // Con prefijo se ignora en silencio; con slash hay que contestar algo
    if (isSlash) await U.respond(message, 'error', 'Solo el staff puede usar este comando.');
    return;
  }
  if (cmd.level === 'admin' && !U.isAdmin(member)) {
    return U.respond(message, 'error', 'Necesitas el permiso **Gestionar servidor** para usar este comando.');
  }

  let ticket = null;
  if (cmd.ticketOnly) {
    ticket = await Ticket.findOne({ channelId: message.channel.id, open: true });
    if (!ticket) return U.respond(message, 'error', 'Este comando solo se puede usar dentro de un ticket abierto.');
  }

  try {
    const args = getArgs();
    await cmd.run({ client, message, guild: message.guild, cfg, args, ticket, prefix, commands });
  } catch (err) {
    if (err instanceof U.UserError) return U.respond(message, 'error', err.message);
    console.error(`Error en el comando ${cmd.name}:`, err);
    await U.respond(message, 'error', `Ha ocurrido un error inesperado: \`${U.truncate(err.message, 200)}\``).catch(() => {});
  }
}

async function handleCommand(client, message) {
  if (!env.PREFIX) return;
  const cfg = await getConfig(message.guild.id);
  const prefix = [cfg.prefix, `<@${client.user.id}>`, `<@!${client.user.id}>`]
    .find((p) => message.content.startsWith(p));
  if (!prefix) return;

  // Solo se separa el NOMBRE del comando; el resto se pasa intacto (con barras, saltos de línea, etc.)
  const match = message.content.slice(prefix.length).trim().match(/^(\S+)([\s\S]*)$/);
  if (!match) return;
  const cmd = lookup.get(match[1].toLowerCase());
  if (!cmd) return;
  const args = match[2].trim();

  await executeCommand({ client, message, cmd, cfg, prefix: cfg.prefix, getArgs: () => args, isSlash: false });
}

async function handleInteraction(client, interaction) {
  if (!env.SLASH || interaction.guildId !== process.env.GUILD_ID) return;
  const cmd = slashLookup.get(interaction.commandName);

  if (interaction.isAutocomplete()) {
    const cfg = await getConfig(interaction.guildId);
    let choices = [];
    if (cmd?.slash.autocomplete && U.isStaff(interaction.member, cfg)) choices = await cmd.slash.autocomplete(interaction);
    const focused = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(choices.filter((c) => c.name.toLowerCase().includes(focused)).slice(0, 25)).catch(() => {});
    return;
  }

  if (!interaction.isChatInputCommand() || !cmd) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const cfg = await getConfig(interaction.guildId);
  const { message, state } = createAdapter(interaction);
  await executeCommand({
    client, message, cmd, cfg, prefix: '/', getArgs: () => cmd.slash.toArgs?.(interaction) ?? '', isSlash: true,
  });
  // Si el comando no contestó nada al staff (p. ej. claim, que ya publica en el canal), se quita el "pensando..."
  if (!state.replied && !state.deleted) await interaction.deleteReply().catch(() => {});
}

/** Registra los slash en el servidor (al instante). Si SLASH=false los borra para que no queden colgados. */
async function registerSlashCommands(client) {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const definitions = env.SLASH ? commands.filter((c) => c.slash).map(buildDefinition) : [];
  await guild.commands.set(definitions);
  console.log(env.SLASH ? `${definitions.length} comandos slash registrados` : 'Comandos slash desactivados');
}

module.exports = { handleCommand, handleInteraction, registerSlashCommands };
