const { EmbedBuilder, ChannelType } = require('discord.js');
const { Ticket, Category, Snippet } = require('../models');
const {
  sendStaffReply, editLastReply, deleteLastReply, closeTicket, scheduleClose, cancelScheduledClose, addLog,
} = require('../tickets');
const U = require('../util');
const S = require('../slash');

const G = 'Tickets';

async function findSnippet(guildId, name) {
  if (!name) throw new U.UserError('Indica el nombre del snippet.');
  const snippet = await Snippet.findOne({ guildId, name: name.toLowerCase() });
  if (!snippet) throw new U.UserError(`No existe ningún snippet llamado \`${name}\`.`);
  return snippet;
}

const commands = [
  {
    name: 'reply',
    aliases: ['r'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'reply <mensaje>',
    description: 'Responde al usuario mostrando tu nombre y avatar. Admite archivos adjuntos.',
    run: (ctx) => sendStaffReply({ ...ctx, text: ctx.args, anonymous: false }),
  },
  {
    name: 'areply',
    aliases: ['ar', 'anonreply'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'areply <mensaje>',
    description: 'Responde al usuario de forma anónima (no ve quién eres). Admite archivos adjuntos.',
    run: (ctx) => sendStaffReply({ ...ctx, text: ctx.args, anonymous: true }),
  },
  {
    name: 's',
    aliases: ['snip'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 's <snippet>',
    description: 'Envía un snippet (respuesta guardada) mostrando tu nombre.',
    run: async (ctx) => {
      const snippet = await findSnippet(ctx.guild.id, ctx.args);
      await sendStaffReply({ ...ctx, text: snippet.content, anonymous: false, includeAttachments: false, renderVars: true });
    },
  },
  {
    name: 'as',
    aliases: ['asnip'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'as <snippet>',
    description: 'Envía un snippet de forma anónima.',
    run: async (ctx) => {
      const snippet = await findSnippet(ctx.guild.id, ctx.args);
      await sendStaffReply({ ...ctx, text: snippet.content, anonymous: true, includeAttachments: false, renderVars: true });
    },
  },
  {
    name: 'edit',
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'edit <nuevo texto>',
    description: 'Edita tu última respuesta enviada al usuario.',
    run: async ({ message, ticket, args }) => {
      if (!args) throw new U.UserError('Escribe el nuevo texto.');
      await editLastReply(message, ticket, args);
      await message.delete().catch(() => message.react('✅'));
    },
  },
  {
    name: 'delete',
    aliases: ['del'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'delete',
    description: 'Borra tu última respuesta del MD del usuario.',
    run: async ({ message, ticket }) => {
      await deleteLastReply(message, ticket);
      await message.delete().catch(() => message.react('✅'));
    },
  },
  {
    name: 'note',
    aliases: ['n'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'note <texto>',
    description: 'Deja una nota interna (el usuario no la ve). Queda en el transcript.',
    run: async ({ message, ticket, args }) => {
      if (!args) throw new U.UserError('Escribe el contenido de la nota.');
      await message.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(U.COLORS.note)
          .setAuthor({ name: `Nota de ${message.member.displayName}`, iconURL: message.member.displayAvatarURL() })
          .setDescription(args)
          .setTimestamp()],
      });
      await addLog(ticket, { type: 'note', authorId: message.author.id, authorTag: message.author.tag, content: args });
      // Si la nota lleva archivos se deja el mensaje original para no perderlos
      if (!message.attachments.size) await message.delete().catch(() => {});
    },
  },
  {
    name: 'claim',
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'claim',
    description: 'Reclama el ticket: te haces cargo y recibes una mención con cada mensaje del usuario.',
    run: async ({ message, ticket }) => {
      if (ticket.claimedBy === message.author.id) throw new U.UserError('Ya has reclamado este ticket.');
      if (ticket.claimedBy) {
        throw new U.UserError(`Este ticket ya lo ha reclamado <@${ticket.claimedBy}>. Tiene que usar \`unclaim\` primero.`);
      }
      const res = await Ticket.updateOne(
        { _id: ticket._id, claimedBy: null },
        { $set: { claimedBy: message.author.id }, $push: { log: U.sysLog(`${message.author.tag} reclamó el ticket`) } },
      );
      if (!res.modifiedCount) throw new U.UserError('Otra persona acaba de reclamar este ticket.');
      await message.channel.send({
        embeds: [U.embed('success', `🙋 ${message.author} ha reclamado este ticket.`)],
      });
    },
  },
  {
    name: 'unclaim',
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'unclaim',
    description: 'Libera el ticket para que otro miembro del staff pueda reclamarlo.',
    run: async ({ message, ticket }) => {
      if (!ticket.claimedBy) throw new U.UserError('Este ticket no está reclamado.');
      if (ticket.claimedBy !== message.author.id && !U.isAdmin(message.member)) {
        throw new U.UserError('Solo quien reclamó el ticket o un administrador puede liberarlo.');
      }
      await Ticket.updateOne(
        { _id: ticket._id },
        { $set: { claimedBy: null }, $push: { log: U.sysLog(`${message.author.tag} liberó el ticket`) } },
      );
      await message.channel.send({ embeds: [U.embed('info', `🔓 ${message.author} ha liberado este ticket.`)] });
    },
  },
  {
    name: 'subscribe',
    aliases: ['sub'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'subscribe',
    description: 'Recibe una mención con cada mensaje nuevo del usuario, aunque no hayas reclamado el ticket.',
    run: async ({ message, ticket }) => {
      if (ticket.subscribers.includes(message.author.id)) throw new U.UserError('Ya estás suscrito a este ticket.');
      await Ticket.updateOne({ _id: ticket._id }, { $addToSet: { subscribers: message.author.id } });
      await U.respond(message, 'success', '🔔 Te has suscrito. Te mencionaré cuando el usuario escriba.');
    },
  },
  {
    name: 'unsubscribe',
    aliases: ['unsub'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'unsubscribe',
    description: 'Deja de recibir menciones de este ticket.',
    run: async ({ message, ticket }) => {
      if (!ticket.subscribers.includes(message.author.id)) throw new U.UserError('No estás suscrito a este ticket.');
      await Ticket.updateOne({ _id: ticket._id }, { $pull: { subscribers: message.author.id } });
      await U.respond(message, 'success', '🔕 Ya no recibirás menciones de este ticket.');
    },
  },
  {
    name: 'move',
    aliases: ['mv'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'move <categoría>',
    description: 'Mueve el ticket a una categoría registrada (o `default` para volver a la principal).',
    run: async ({ message, guild, cfg, ticket, args, prefix }) => {
      const name = args.toLowerCase();
      if (!name) {
        const cats = await Category.find({ guildId: guild.id }).sort({ name: 1 });
        throw new U.UserError(`Uso: \`${prefix}move <categoría>\`\nDisponibles: ${
          ['default', ...cats.map((c) => c.name)].map((n) => `\`${n}\``).join(', ')}`);
      }

      let targetId;
      let label = null;
      if (['default', 'principal'].includes(name)) {
        targetId = cfg.defaultCategoryId;
      } else {
        const cat = await Category.findOne({ guildId: guild.id, name });
        if (!cat) throw new U.UserError(`No existe la categoría \`${name}\`. Usa \`${prefix}category list\` para verlas.`);
        targetId = cat.discordCategoryId;
        label = cat.name;
      }

      const parent = targetId && guild.channels.cache.get(targetId);
      if (!parent || parent.type !== ChannelType.GuildCategory) {
        throw new U.UserError('La categoría de Discord asociada ya no existe. Vuelve a registrarla.');
      }
      if (message.channel.parentId === parent.id) throw new U.UserError('El ticket ya está en esa categoría.');

      // Hereda los permisos de la categoría destino (p. ej. solo admins), pero nunca visible para @everyone
      await message.channel.setParent(parent.id, { lockPermissions: true, reason: `Movido por ${message.author.tag}` });
      await U.ensurePrivate(message.channel);
      await Ticket.updateOne(
        { _id: ticket._id },
        { $set: { category: label }, $push: { log: U.sysLog(`${message.author.tag} movió el ticket a ${parent.name}`) } },
      );
      await message.channel.send({ embeds: [U.embed('success', `📂 Ticket movido a **${parent.name}** por ${message.author}.`)] });
    },
  },
  {
    name: 'close',
    aliases: ['c'],
    group: G,
    level: 'staff',
    ticketOnly: true,
    usage: 'close [silent] [duración] [motivo] | close cancel',
    description: 'Cierra el ticket, avisa al usuario (salvo con `silent`) y guarda el transcript en logs. '
      + 'Con duración (`30m`, `12h`, `2d`, `1h30m`) se cierra solo si el usuario no responde antes; '
      + '`close cancel` lo cancela.',
    run: async ({ message, guild, cfg, ticket, args }) => {
      if (/^(cancel|cancelar|stop)$/i.test(args)) return cancelScheduledClose(message, ticket);

      let reason = args;
      let silent = false;
      const match = args.match(/^(silent|silencioso|-s)(?:\s+([\s\S]*))?$/i);
      if (match) {
        silent = true;
        reason = (match[2] ?? '').trim();
      }

      // Duración opcional, admite "close 24h ..." y "close en 24h ..."
      let [first, rest] = U.splitFirst(reason);
      if (/^(in|en)$/i.test(first) && U.parseDuration(U.splitFirst(rest)[0]) !== null) [first, rest] = U.splitFirst(rest);
      const ms = U.parseDuration(first);
      if (ms !== null) {
        return scheduleClose({ message, guild, cfg, ticket, ms, reason: rest || null, silent });
      }

      await message.channel.send({ embeds: [U.embed('system', '🔒 Cerrando ticket...')] });
      await closeTicket({ guild, cfg, ticket, closer: message.author, reason: reason || null, silent });
    },
  },
];

// ─── Definiciones de los comandos slash ─────────────────────────────────────────

const messageOption = (b, description, required = false) => b.addStringOption((o) => o
  .setName('mensaje').setDescription(description).setRequired(required).setMaxLength(4000));
const snippetName = (b) => b.addStringOption((o) => o
  .setName('nombre').setDescription('Nombre del snippet').setRequired(true).setAutocomplete(true));

const SLASH = {
  reply: {
    build: (b) => S.withFiles(messageOption(b, 'Mensaje para el usuario (escribe \\n para un salto de línea)')),
    toArgs: (i) => S.nl(i.options.getString('mensaje')),
  },
  areply: {
    build: (b) => S.withFiles(messageOption(b, 'Mensaje anónimo para el usuario (escribe \\n para un salto de línea)')),
    toArgs: (i) => S.nl(i.options.getString('mensaje')),
  },
  s: {
    name: 'snip',
    build: snippetName,
    toArgs: (i) => i.options.getString('nombre'),
    autocomplete: S.snippetChoices,
  },
  as: {
    name: 'asnip',
    build: snippetName,
    toArgs: (i) => i.options.getString('nombre'),
    autocomplete: S.snippetChoices,
  },
  edit: {
    build: (b) => messageOption(b, 'Nuevo texto (escribe \\n para un salto de línea)', true),
    toArgs: (i) => S.nl(i.options.getString('mensaje')),
  },
  delete: {},
  note: {
    build: (b) => b.addStringOption((o) => o.setName('texto')
      .setDescription('Contenido de la nota (escribe \\n para un salto de línea)').setRequired(true).setMaxLength(4000)),
    toArgs: (i) => S.nl(i.options.getString('texto')),
  },
  claim: {},
  unclaim: {},
  subscribe: {},
  unsubscribe: {},
  move: {
    build: (b) => b.addStringOption((o) => o
      .setName('categoria').setDescription('Categoría destino').setRequired(true).setAutocomplete(true)),
    toArgs: (i) => i.options.getString('categoria'),
    autocomplete: (i) => S.categoryChoices(i),
  },
  close: {
    build: (b) => b
      .addStringOption((o) => o.setName('motivo').setDescription('Motivo del cierre').setMaxLength(1000))
      .addStringOption((o) => o.setName('tiempo')
        .setDescription('Cerrar solo si el usuario no responde en este tiempo: 30m, 12h, 2d, 1h30m'))
      .addBooleanOption((o) => o.setName('silencioso').setDescription('No avisar al usuario'))
      .addBooleanOption((o) => o.setName('cancelar').setDescription('Cancelar el cierre automático programado')),
    toArgs: (i) => {
      if (i.options.getBoolean('cancelar')) return 'cancel';
      const time = i.options.getString('tiempo')?.trim();
      if (time && U.parseDuration(time) === null) {
        throw new U.UserError('Duración no válida. Ejemplos: `30m`, `12h`, `2d`, `1h30m`.');
      }
      return [i.options.getBoolean('silencioso') ? 'silent' : '', time, i.options.getString('motivo')]
        .filter(Boolean).join(' ');
    },
  },
};

for (const cmd of commands) cmd.slash = SLASH[cmd.name];
module.exports = commands;
