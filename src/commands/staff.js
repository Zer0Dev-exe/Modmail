const { EmbedBuilder } = require('discord.js');
const { Ticket, Block, Snippet } = require('../models');
const { contactUser, sendLog } = require('../tickets');
const U = require('../util');
const S = require('../slash');

const G = 'Staff';

/** Usuario indicado en los argumentos o, si no hay, el usuario del ticket del canal actual. */
async function resolveTarget(message, args) {
  const [first, rest] = U.splitFirst(args);
  const id = U.parseId(first, 'user');
  if (id) return { userId: id, rest };
  const ticket = await Ticket.findOne({ channelId: message.channel.id, open: true });
  if (ticket) return { userId: ticket.userId, rest: args };
  return { userId: null, rest: args };
}

const commands = [
  {
    name: 'help',
    aliases: ['ayuda', 'commands'],
    group: G,
    level: 'staff',
    usage: 'help',
    description: 'Muestra esta lista de comandos.',
    run: async ({ message, prefix, commands }) => {
      const groups = new Map();
      for (const cmd of commands) {
        if (!groups.has(cmd.group)) groups.set(cmd.group, []);
        const slash = prefix === '/';
        const usage = slash ? cmd.usage.replace(/^\S+/, cmd.slash?.name ?? cmd.name) : cmd.usage;
        const aliases = !slash && cmd.aliases?.length ? ` *(${cmd.aliases.join(', ')})*` : '';
        groups.get(cmd.group).push(`\`${prefix}${usage}\`${aliases}\n${cmd.description}`);
      }
      const emb = new EmbedBuilder()
        .setColor(U.COLORS.info)
        .setTitle('📬 Comandos de Modmail')
        .setDescription('Los mensajes que escribas en un ticket **sin** prefijo son internos: el usuario no los ve.');
      for (const [group, lines] of groups) {
        // Un campo admite 1024 caracteres: se reparte en varios si hace falta
        let chunk = '';
        let first = true;
        for (const line of lines) {
          if (chunk.length + line.length + 2 > 1024) {
            emb.addFields({ name: first ? group : `${group} (cont.)`, value: chunk });
            chunk = '';
            first = false;
          }
          chunk += `${chunk ? '\n\n' : ''}${line}`;
        }
        if (chunk) emb.addFields({ name: first ? group : `${group} (cont.)`, value: chunk });
      }
      await message.reply({ embeds: [emb], allowedMentions: { repliedUser: false } });
    },
  },
  {
    name: 'contact',
    aliases: ['open'],
    group: G,
    level: 'staff',
    usage: 'contact <@usuario|ID>',
    description: 'Abre un ticket con un usuario para escribirle tú primero.',
    run: async ({ client, message, guild, cfg, args, prefix }) => {
      const id = U.parseId(U.splitFirst(args)[0], 'user');
      if (!id) throw new U.UserError(`Uso: \`${prefix}contact <@usuario|ID>\``);
      const user = await client.users.fetch(id).catch(() => null);
      if (!user || user.bot) throw new U.UserError('Usuario no válido.');
      const { channel, created } = await contactUser(guild, cfg, user, message.author);
      await U.respond(message, created ? 'success' : 'info', created
        ? `📬 Ticket creado: ${channel}. Usa \`${prefix}reply\` o \`${prefix}areply\` para escribirle.`
        : `Ese usuario ya tiene un ticket abierto: ${channel}`);
    },
  },
  {
    name: 'tickets',
    aliases: ['list'],
    group: G,
    level: 'staff',
    usage: 'tickets',
    description: 'Lista los tickets abiertos.',
    run: async ({ message, guild }) => {
      const open = await Ticket.find({ guildId: guild.id, open: true }).sort({ createdAt: 1 }).limit(30);
      if (!open.length) return U.respond(message, 'info', 'No hay tickets abiertos. 🎉');
      const lines = open.map((t) => `**#${t.number}** <#${t.channelId}> · <@${t.userId}>`
        + `${t.claimedBy ? ` · 🙋 <@${t.claimedBy}>` : ''} · ${U.ts(t.createdAt)}`);
      await message.reply({
        embeds: [U.embed('info', U.truncate(lines.join('\n'), 4096)).setTitle(`Tickets abiertos (${open.length})`)],
        allowedMentions: { parse: [], repliedUser: false },
      });
    },
  },
  {
    name: 'block',
    aliases: ['blacklist', 'bl'],
    group: G,
    level: 'staff',
    usage: 'block [@usuario|ID] [duración] [motivo]',
    description: 'Añade a la blacklist: el usuario no podrá abrir tickets. Duración opcional (`12h`, `7d`…) '
      + 'para un bloqueo temporal. Dentro de un ticket bloquea a su usuario.',
    run: async ({ client, message, guild, cfg, args, prefix }) => {
      const { userId, rest } = await resolveTarget(message, args);
      if (!userId) throw new U.UserError(`Uso: \`${prefix}block <@usuario|ID> [duración] [motivo]\``);

      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) throw new U.UserError('No se ha encontrado a ese usuario.');
      if (user.bot) throw new U.UserError('No se puede bloquear a un bot.');
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && U.isStaff(member, cfg)) throw new U.UserError('No puedes bloquear a un miembro del staff.');

      const [first, afterFirst] = U.splitFirst(rest);
      const ms = U.parseDuration(first);
      if (ms !== null && ms < 60 * 1000) throw new U.UserError('La duración mínima es de 1 minuto.');
      const reason = (ms !== null ? afterFirst : rest) || null;
      const expiresAt = ms !== null ? new Date(Date.now() + ms) : null;

      await Block.updateOne(
        { guildId: guild.id, userId },
        { $set: { reason, blockedBy: message.author.id, expiresAt } },
        { upsert: true },
      );

      const until = expiresAt ? `hasta ${U.ts(expiresAt, 'f')} (${U.ts(expiresAt)})` : 'de forma **permanente**';
      const text = `⛔ ${user} (\`${user.id}\`) añadido a la blacklist ${until}.${reason ? `\n**Motivo:** ${reason}` : ''}`;
      await U.respond(message, 'success', text);
      await sendLog(guild, cfg, {
        embeds: [U.embed('error', `${text}\n**Por:** ${message.author}`)],
        allowedMentions: { parse: [] },
      });
    },
  },
  {
    name: 'unblock',
    aliases: ['unblacklist', 'unbl'],
    group: G,
    level: 'staff',
    usage: 'unblock [@usuario|ID]',
    description: 'Quita a un usuario de la blacklist.',
    run: async ({ message, guild, cfg, args, prefix }) => {
      const { userId } = await resolveTarget(message, args);
      if (!userId) throw new U.UserError(`Uso: \`${prefix}unblock <@usuario|ID>\``);
      const res = await Block.deleteOne({ guildId: guild.id, userId });
      if (!res.deletedCount) throw new U.UserError('Ese usuario no está en la blacklist.');
      await U.respond(message, 'success', `✅ <@${userId}> quitado de la blacklist.`);
      await sendLog(guild, cfg, {
        embeds: [U.embed('success', `✅ <@${userId}> (\`${userId}\`) quitado de la blacklist por ${message.author}.`)],
        allowedMentions: { parse: [] },
      });
    },
  },
  {
    name: 'blocklist',
    aliases: ['blocked', 'bllist'],
    group: G,
    level: 'staff',
    usage: 'blocklist',
    description: 'Muestra la blacklist.',
    run: async ({ message, guild }) => {
      const blocks = await Block.find({
        guildId: guild.id,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      }).sort({ createdAt: -1 }).limit(50);
      if (!blocks.length) return U.respond(message, 'info', 'La blacklist está vacía.');
      const lines = blocks.map((b) => `<@${b.userId}> (\`${b.userId}\`)`
        + ` · ${b.expiresAt ? `hasta ${U.ts(b.expiresAt)}` : 'permanente'}`
        + `${b.reason ? ` · ${U.truncate(b.reason, 80)}` : ''}`);
      await message.reply({
        embeds: [U.embed('info', U.truncate(lines.join('\n'), 4096)).setTitle(`⛔ Blacklist (${blocks.length})`)],
        allowedMentions: { parse: [], repliedUser: false },
      });
    },
  },
  {
    name: 'snippet',
    aliases: ['snippets'],
    group: G,
    level: 'staff',
    usage: 'snippet <add|edit|remove|list> [nombre] [texto]',
    description: 'Gestiona respuestas guardadas. Variables: `{user}` `{username}` `{server}` `{staff}`. '
      + 'Se envían con `s` o `as`.',
    run: async ({ message, guild, args, prefix }) => {
      const [sub, rest] = U.splitFirst(args);
      const [rawName, content] = U.splitFirst(rest);
      const name = rawName.toLowerCase();

      switch (sub.toLowerCase()) {
        case 'add':
        case 'create': {
          if (!name || !content) throw new U.UserError(`Uso: \`${prefix}snippet add <nombre> <texto>\``);
          if (await Snippet.exists({ guildId: guild.id, name })) {
            throw new U.UserError(`Ya existe \`${name}\`. Usa \`${prefix}snippet edit\`.`);
          }
          await Snippet.create({ guildId: guild.id, name, content, createdBy: message.author.id });
          return U.respond(message, 'success', `Snippet \`${name}\` creado.`);
        }
        case 'edit': {
          if (!name || !content) throw new U.UserError(`Uso: \`${prefix}snippet edit <nombre> <texto>\``);
          const res = await Snippet.updateOne({ guildId: guild.id, name }, { $set: { content } });
          if (!res.matchedCount) throw new U.UserError(`No existe el snippet \`${name}\`.`);
          return U.respond(message, 'success', `Snippet \`${name}\` actualizado.`);
        }
        case 'remove':
        case 'delete': {
          const res = await Snippet.deleteOne({ guildId: guild.id, name });
          if (!res.deletedCount) throw new U.UserError(`No existe el snippet \`${name}\`.`);
          return U.respond(message, 'success', `Snippet \`${name}\` eliminado.`);
        }
        case '':
        case 'list': {
          const snippets = await Snippet.find({ guildId: guild.id }).sort({ name: 1 });
          if (!snippets.length) return U.respond(message, 'info', `No hay snippets. Crea uno con \`${prefix}snippet add\`.`);
          return U.respond(message, 'info', U.truncate(snippets.map((s) => `\`${s.name}\``).join(', '), 4096));
        }
        default: {
          const snippet = await Snippet.findOne({ guildId: guild.id, name: sub.toLowerCase() });
          if (!snippet) throw new U.UserError(`No existe el snippet \`${sub}\`.`);
          return U.respond(message, 'info', `**${snippet.name}**\n${snippet.content}`);
        }
      }
    },
  },
];

// ─── Definiciones de los comandos slash ─────────────────────────────────────────

const userOption = (b, required) => b.addUserOption((o) => o.setName('usuario').setDescription('Usuario').setRequired(required));
const mention = (user) => (user ? `<@${user.id}>` : '');

const snippetSub = (s, name, description, { autocomplete = false, text = false } = {}) => {
  s.setName(name).setDescription(description);
  if (name !== 'list') {
    s.addStringOption((o) => o.setName('nombre').setDescription('Nombre del snippet (sin espacios)')
      .setRequired(true).setAutocomplete(autocomplete).setMaxLength(50));
  }
  if (text) {
    s.addStringOption((o) => o.setName('texto')
      .setDescription('Contenido (\\n = salto de línea; variables {user} {username} {server} {staff})')
      .setRequired(true).setMaxLength(4000));
  }
  return s;
};

const SLASH = {
  help: {},
  contact: {
    build: (b) => userOption(b, true),
    toArgs: (i) => mention(i.options.getUser('usuario')),
  },
  tickets: {},
  block: {
    build: (b) => userOption(b, false)
      .addStringOption((o) => o.setName('motivo').setDescription('Motivo del bloqueo').setMaxLength(500))
      .addStringOption((o) => o.setName('duracion').setDescription('Bloqueo temporal: 12h, 7d, 30d… (vacío = permanente)')),
    toArgs: (i) => {
      const time = i.options.getString('duracion')?.trim();
      if (time && U.parseDuration(time) === null) {
        throw new U.UserError('Duración no válida. Ejemplos: `12h`, `7d`, `30d`.');
      }
      return [mention(i.options.getUser('usuario')), time, i.options.getString('motivo')].filter(Boolean).join(' ');
    },
  },
  unblock: {
    build: (b) => userOption(b, false),
    toArgs: (i) => mention(i.options.getUser('usuario')),
  },
  blocklist: {},
  snippet: {
    build: (b) => b
      .addSubcommand((s) => snippetSub(s, 'add', 'Crea un snippet', { text: true }))
      .addSubcommand((s) => snippetSub(s, 'edit', 'Edita un snippet', { autocomplete: true, text: true }))
      .addSubcommand((s) => snippetSub(s, 'remove', 'Elimina un snippet', { autocomplete: true }))
      .addSubcommand((s) => snippetSub(s, 'ver', 'Muestra el contenido de un snippet', { autocomplete: true }))
      .addSubcommand((s) => snippetSub(s, 'list', 'Lista los snippets')),
    toArgs: (i) => {
      const sub = i.options.getSubcommand();
      const name = i.options.getString('nombre') ?? '';
      if (/\s/.test(name)) throw new U.UserError('El nombre del snippet no puede tener espacios.');
      if (sub === 'ver') return name;
      return [sub, name, S.nl(i.options.getString('texto'))].filter(Boolean).join(' ');
    },
    autocomplete: S.snippetChoices,
  },
};

for (const cmd of commands) cmd.slash = SLASH[cmd.name];
module.exports = commands;
