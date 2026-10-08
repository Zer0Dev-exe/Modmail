const { EmbedBuilder, ChannelType } = require('discord.js');
const { Ticket, Category } = require('../models');
const { saveConfig, getMessage, DEFAULT_MESSAGES, MESSAGE_INFO } = require('../config');
const U = require('../util');
const S = require('../slash');

const G = 'Administración';

/** Da o quita acceso a un rol de staff en la categoría principal, el canal de logs y los tickets abiertos en ella. */
async function syncStaffRole(guild, cfg, roleId, add) {
  const targets = [cfg.defaultCategoryId, cfg.logChannelId]
    .map((id) => id && guild.channels.cache.get(id))
    .filter(Boolean);
  const open = await Ticket.find({ guildId: guild.id, open: true, category: null });
  for (const t of open) {
    const ch = guild.channels.cache.get(t.channelId);
    if (ch) targets.push(ch);
  }
  for (const ch of targets) {
    await (add ? ch.permissionOverwrites.edit(roleId, U.STAFF_PERMS) : ch.permissionOverwrites.delete(roleId))
      .catch((err) => console.warn(`No se pudieron actualizar los permisos de #${ch.name}:`, err.message));
  }
}

function parseRoles(message, text) {
  const ids = new Set(message.mentions.roles.keys());
  for (const token of text.split(/\s+/)) {
    const id = U.parseId(token, 'role');
    if (id && message.guild.roles.cache.has(id)) ids.add(id);
  }
  return [...ids];
}

function showConfig(guild, cfg, prefix) {
  const ch = (id) => (id && guild.channels.cache.get(id) ? `<#${id}>` : '*No configurado*');
  return new EmbedBuilder()
    .setColor(U.COLORS.info)
    .setTitle('⚙️ Configuración de Modmail')
    .addFields(
      { name: 'Prefijo', value: `\`${cfg.prefix}\``, inline: true },
      { name: 'Categoría principal', value: ch(cfg.defaultCategoryId), inline: true },
      { name: 'Canal de logs', value: ch(cfg.logChannelId), inline: true },
      { name: 'Roles de staff', value: cfg.staffRoles.map((id) => `<@&${id}>`).join(' ') || '*Ninguno (solo admins)*' },
      { name: 'Rol mencionado en tickets nuevos', value: cfg.notifyRoleId ? `<@&${cfg.notifyRoleId}>` : '*Ninguno*' },
    )
    .setFooter({ text: `${prefix}config help para ver cómo cambiar cada opción` });
}

const CONFIG_HELP = (p) => [
  `\`${p}config\` — ver la configuración actual`,
  `\`${p}config prefix <prefijo>\``,
  `\`${p}config staff add <@rol...>\` / \`remove <@rol...>\` / \`list\``,
  `\`${p}config logs <#canal|ID|off>\``,
  `\`${p}config category <ID de categoría>\` — categoría donde se crean los tickets`,
  `\`${p}config ping <@rol|off>\` — rol mencionado al abrir un ticket`,
  `\`${p}config color\` — ver los colores · \`${p}config color <clave> <#hex|reset>\` para cambiarlos`,
  `\`${p}config messages\` — ver los mensajes personalizables`,
  `\`${p}config message <clave> <texto>\` — cambiar un mensaje (\`reset\` para restaurar)`,
].join('\n');

const commands = [
  {
    name: 'setup',
    group: G,
    level: 'admin',
    usage: 'setup',
    description: 'Crea la categoría de tickets y el canal de logs (solo visibles para el staff).',
    run: async ({ message, guild, cfg, prefix }) => {
      const overwrites = U.staffOverwrites(guild, cfg.staffRoles);
      let category = cfg.defaultCategoryId && guild.channels.cache.get(cfg.defaultCategoryId);
      if (!category) {
        category = await guild.channels.create({ name: '📬 Modmail', type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
      }
      let logs = cfg.logChannelId && guild.channels.cache.get(cfg.logChannelId);
      if (!logs) {
        logs = await guild.channels.create({
          name: 'modmail-logs', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites,
        });
      }
      cfg.defaultCategoryId = category.id;
      cfg.logChannelId = logs.id;
      await saveConfig(cfg);
      await U.respond(message, 'success', [
        `✅ Listo. Categoría: **${category.name}** · Logs: ${logs}`,
        cfg.staffRoles.length ? '' : `\n⚠️ Aún no hay roles de staff. Añádelos con \`${prefix}config staff add @rol\`.`,
      ].join(''));
    },
  },
  {
    name: 'config',
    aliases: ['settings'],
    group: G,
    level: 'admin',
    usage: 'config [opción] [valor]',
    description: 'Configura prefijo, roles de staff, logs, categoría, menciones y mensajes. `config help` para más.',
    run: async ({ message, guild, cfg, args, prefix }) => {
      const [sub, rest] = U.splitFirst(args);

      switch (sub.toLowerCase()) {
        case '':
        case 'show':
          return message.reply({ embeds: [showConfig(guild, cfg, prefix)], allowedMentions: { parse: [], repliedUser: false } });

        case 'help':
          return U.respond(message, 'info', CONFIG_HELP(prefix));

        case 'prefix': {
          if (!rest || /\s/.test(rest) || rest.length > 5) throw new U.UserError('El prefijo debe tener entre 1 y 5 caracteres sin espacios.');
          cfg.prefix = rest;
          await saveConfig(cfg);
          return U.respond(message, 'success', `Prefijo cambiado a \`${rest}\`.`);
        }

        case 'staff': {
          const [action, roleText] = U.splitFirst(rest);
          if (!action || action === 'list') {
            return U.respond(message, 'info', cfg.staffRoles.map((id) => `<@&${id}>`).join('\n') || 'No hay roles de staff configurados.');
          }
          const roles = parseRoles(message, roleText);
          if (!roles.length) throw new U.UserError(`Uso: \`${prefix}config staff ${action} <@rol...>\``);
          if (action === 'add') {
            const added = roles.filter((id) => !cfg.staffRoles.includes(id));
            cfg.staffRoles.push(...added);
            await saveConfig(cfg);
            for (const id of added) await syncStaffRole(guild, cfg, id, true);
            return U.respond(message, 'success', `Roles de staff añadidos: ${roles.map((id) => `<@&${id}>`).join(' ')}`);
          }
          if (action === 'remove') {
            cfg.staffRoles = cfg.staffRoles.filter((id) => !roles.includes(id));
            await saveConfig(cfg);
            for (const id of roles) await syncStaffRole(guild, cfg, id, false);
            return U.respond(message, 'success', `Roles de staff eliminados: ${roles.map((id) => `<@&${id}>`).join(' ')}`);
          }
          throw new U.UserError(`Uso: \`${prefix}config staff <add|remove|list> [@rol...]\``);
        }

        case 'logs': {
          if (rest.toLowerCase() === 'off') {
            cfg.logChannelId = null;
            await saveConfig(cfg);
            return U.respond(message, 'success', 'Canal de logs desactivado.');
          }
          const id = message.mentions.channels.first()?.id ?? U.parseId(rest, 'channel');
          const channel = id && guild.channels.cache.get(id);
          if (!channel?.isTextBased()) throw new U.UserError(`Uso: \`${prefix}config logs <#canal|ID|off>\``);
          cfg.logChannelId = channel.id;
          await saveConfig(cfg);
          return U.respond(message, 'success', `Canal de logs: ${channel}`);
        }

        case 'category': {
          const channel = guild.channels.cache.get(U.parseId(rest, 'channel') ?? '');
          if (channel?.type !== ChannelType.GuildCategory) {
            throw new U.UserError(`Uso: \`${prefix}config category <ID de categoría>\` (activa el modo desarrollador para copiar IDs)`);
          }
          cfg.defaultCategoryId = channel.id;
          await saveConfig(cfg);
          return U.respond(message, 'success', `Los tickets nuevos se crearán en **${channel.name}**.`);
        }

        case 'ping': {
          if (rest.toLowerCase() === 'off') {
            cfg.notifyRoleId = null;
            await saveConfig(cfg);
            return U.respond(message, 'success', 'Ya no se mencionará a ningún rol al abrir tickets.');
          }
          const [roleId] = parseRoles(message, rest);
          if (!roleId) throw new U.UserError(`Uso: \`${prefix}config ping <@rol|off>\``);
          cfg.notifyRoleId = roleId;
          await saveConfig(cfg);
          return U.respond(message, 'success', `Se mencionará a <@&${roleId}> al abrir cada ticket.`);
        }

        case 'color':
        case 'colors':
        case 'colour': {
          const [rawKey, value] = U.splitFirst(rest);
          if (!rawKey) {
            const lines = Object.keys(U.DEFAULT_COLORS).map((key) => {
              const custom = cfg.colors.has(key);
              return `\`${key}\` **${U.hex(U.COLORS[key])}**${custom ? ' ✏️' : ''} — ${U.COLOR_INFO[key]}`;
            });
            return U.respond(message, 'info', `🎨 **Colores de los embeds**\n${lines.join('\n')}\n\n`
              + `Cambia uno con \`${prefix}config color <clave> <#hex>\` o restáuralo con \`reset\`.`);
          }
          const key = Object.keys(U.DEFAULT_COLORS).find((k) => k.toLowerCase() === rawKey.toLowerCase());
          if (!key) {
            throw new U.UserError(`Clave no válida. Disponibles: ${Object.keys(U.DEFAULT_COLORS).map((k) => `\`${k}\``).join(', ')}`);
          }
          if (value.toLowerCase() === 'reset') {
            cfg.colors.delete(key);
          } else {
            const color = U.parseColor(value);
            if (color === null) throw new U.UserError(`Color no válido. Usa formato hexadecimal, por ejemplo \`${prefix}config color ${key} #ff8800\``);
            cfg.colors.set(key, color);
          }
          await saveConfig(cfg);
          return message.reply({
            embeds: [U.embed(key, `Color \`${key}\` → **${U.hex(U.COLORS[key])}**. Así se verá este tipo de mensaje.`)],
            allowedMentions: { repliedUser: false },
          });
        }

        case 'messages': {
          const emb = new EmbedBuilder()
            .setColor(U.COLORS.info)
            .setTitle('✏️ Mensajes personalizables')
            .setDescription(`Cambia uno con \`${prefix}config message <clave> <texto>\` o restáuralo con \`reset\`.\n`
              + 'Variables: `{user}` (mención) `{username}` `{server}`');
          for (const key of Object.keys(DEFAULT_MESSAGES)) {
            const custom = cfg.messages.has(key);
            emb.addFields({
              name: `${key}${custom ? ' ✏️' : ''}`,
              value: U.truncate(`*${MESSAGE_INFO[key]}*\n${cfg.messages.get(key) ?? DEFAULT_MESSAGES[key]}`, 1024),
            });
          }
          return message.reply({ embeds: [emb], allowedMentions: { repliedUser: false } });
        }

        case 'message': {
          const [rawKey, text] = U.splitFirst(rest);
          const key = Object.keys(DEFAULT_MESSAGES).find((k) => k.toLowerCase() === rawKey.toLowerCase());
          if (!key) {
            throw new U.UserError(`Clave no válida. Disponibles: ${Object.keys(DEFAULT_MESSAGES).map((k) => `\`${k}\``).join(', ')}`);
          }
          if (!text) throw new U.UserError(`Uso: \`${prefix}config message ${key} <texto|reset>\``);
          if (text.toLowerCase() === 'reset') cfg.messages.delete(key);
          else cfg.messages.set(key, text);
          await saveConfig(cfg);
          const preview = getMessage(cfg, key, U.vars({ guild, user: message.author, staff: message.member }));
          return U.respond(message, 'success', `Mensaje \`${key}\` ${text.toLowerCase() === 'reset' ? 'restaurado' : 'actualizado'}. Vista previa:\n\n${preview}`);
        }

        default:
          return U.respond(message, 'error', CONFIG_HELP(prefix));
      }
    },
  },
  {
    name: 'category',
    aliases: ['categories', 'cat'],
    group: G,
    level: 'admin',
    usage: 'category <create|delete|list> [nombre] [ID de categoría] [@roles]',
    description: 'Registra categorías a las que mover tickets con `move`. Sin ID se crea la categoría en Discord '
      + 'visible solo para los roles indicados (o el staff si no indicas ninguno).',
    run: async ({ message, guild, cfg, args, prefix }) => {
      const [sub, rest] = U.splitFirst(args);
      const [rawName, extra] = U.splitFirst(rest);
      const name = rawName.toLowerCase();

      switch (sub.toLowerCase()) {
        case 'create':
        case 'add': {
          if (!name) throw new U.UserError(`Uso: \`${prefix}category create <nombre> [ID de categoría] [@roles]\``);
          if (['default', 'principal'].includes(name)) throw new U.UserError('Ese nombre está reservado.');
          if (await Category.exists({ guildId: guild.id, name })) throw new U.UserError(`La categoría \`${name}\` ya existe.`);

          const existingId = extra.split(/\s+/).find((t) => /^\d{17,20}$/.test(t));
          let discordCat;
          if (existingId) {
            discordCat = guild.channels.cache.get(existingId);
            if (discordCat?.type !== ChannelType.GuildCategory) throw new U.UserError('Ese ID no es una categoría de este servidor.');
          } else {
            const roles = parseRoles(message, extra);
            discordCat = await guild.channels.create({
              name: rawName,
              type: ChannelType.GuildCategory,
              permissionOverwrites: U.staffOverwrites(guild, roles.length ? roles : cfg.staffRoles),
            });
          }
          await Category.create({ guildId: guild.id, name, discordCategoryId: discordCat.id });
          return U.respond(message, 'success', `Categoría \`${name}\` registrada → **${discordCat.name}**. `
            + `Usa \`${prefix}move ${name}\` dentro de un ticket.`);
        }

        case 'delete':
        case 'remove': {
          const res = await Category.deleteOne({ guildId: guild.id, name });
          if (!res.deletedCount) throw new U.UserError(`No existe la categoría \`${name}\`.`);
          return U.respond(message, 'success', `Categoría \`${name}\` eliminada del registro (la categoría de Discord no se borra).`);
        }

        case '':
        case 'list': {
          const cats = await Category.find({ guildId: guild.id }).sort({ name: 1 });
          if (!cats.length) return U.respond(message, 'info', `No hay categorías. Crea una con \`${prefix}category create <nombre>\`.`);
          const lines = cats.map((c) => {
            const ch = guild.channels.cache.get(c.discordCategoryId);
            return `\`${c.name}\` → ${ch ? `**${ch.name}**` : '⚠️ *categoría de Discord eliminada*'}`;
          });
          return U.respond(message, 'info', lines.join('\n'));
        }

        default:
          throw new U.UserError(`Uso: \`${prefix}category <create|delete|list> [nombre]\``);
      }
    },
  },
];

// ─── Definiciones de los comandos slash ─────────────────────────────────────────

const keyChoices = (keys) => keys.map((k) => ({ name: k, value: k }));

const SLASH = {
  setup: {},
  config: {
    build: (b) => b
      .addSubcommand((s) => s.setName('ver').setDescription('Muestra la configuración actual'))
      .addSubcommand((s) => s.setName('prefix').setDescription('Cambia el prefijo de los comandos')
        .addStringOption((o) => o.setName('prefijo').setDescription('Nuevo prefijo (máx. 5 caracteres)')
          .setRequired(true).setMaxLength(5)))
      .addSubcommand((s) => s.setName('staff').setDescription('Gestiona los roles de staff')
        .addStringOption((o) => o.setName('accion').setDescription('Qué hacer').setRequired(true)
          .addChoices({ name: 'Añadir', value: 'add' }, { name: 'Quitar', value: 'remove' }, { name: 'Ver lista', value: 'list' }))
        .addRoleOption((o) => o.setName('rol').setDescription('Rol a añadir o quitar')))
      .addSubcommand((s) => s.setName('logs').setDescription('Canal donde se envían logs y transcripts')
        .addChannelOption((o) => o.setName('canal').setDescription('Canal de logs').addChannelTypes(ChannelType.GuildText))
        .addBooleanOption((o) => o.setName('desactivar').setDescription('Desactivar los logs')))
      .addSubcommand((s) => s.setName('category').setDescription('Categoría donde se crean los tickets nuevos')
        .addChannelOption((o) => o.setName('categoria').setDescription('Categoría').setRequired(true)
          .addChannelTypes(ChannelType.GuildCategory)))
      .addSubcommand((s) => s.setName('ping').setDescription('Rol que se menciona al abrir un ticket')
        .addRoleOption((o) => o.setName('rol').setDescription('Rol a mencionar'))
        .addBooleanOption((o) => o.setName('desactivar').setDescription('No mencionar a ningún rol')))
      .addSubcommand((s) => s.setName('color').setDescription('Ver o cambiar los colores de los embeds')
        .addStringOption((o) => o.setName('clave').setDescription('Tipo de mensaje')
          .addChoices(...keyChoices(Object.keys(U.DEFAULT_COLORS))))
        .addStringOption((o) => o.setName('color').setDescription('Color en hexadecimal (#ff8800) o "reset"').setMaxLength(8)))
      .addSubcommand((s) => s.setName('mensajes').setDescription('Ver los mensajes personalizables'))
      .addSubcommand((s) => s.setName('mensaje').setDescription('Cambiar un mensaje personalizable')
        .addStringOption((o) => o.setName('clave').setDescription('Mensaje a cambiar').setRequired(true)
          .addChoices(...keyChoices(Object.keys(DEFAULT_MESSAGES))))
        .addStringOption((o) => o.setName('texto').setDescription('Nuevo texto (\\n = salto de línea) o "reset"')
          .setRequired(true).setMaxLength(4000))),
    toArgs: (i) => {
      const o = i.options;
      const role = o.getRole('rol');
      switch (o.getSubcommand()) {
        case 'prefix': return `prefix ${o.getString('prefijo')}`;
        case 'staff': return `staff ${o.getString('accion')}${role ? ` <@&${role.id}>` : ''}`;
        case 'logs': return o.getBoolean('desactivar') ? 'logs off' : `logs ${o.getChannel('canal')?.id ?? ''}`;
        case 'category': return `category ${o.getChannel('categoria').id}`;
        case 'ping': return o.getBoolean('desactivar') ? 'ping off' : `ping ${role ? `<@&${role.id}>` : ''}`;
        case 'color': return ['color', o.getString('clave'), o.getString('color')].filter(Boolean).join(' ');
        case 'mensajes': return 'messages';
        case 'mensaje': return `message ${o.getString('clave')} ${S.nl(o.getString('texto'))}`;
        default: return '';
      }
    },
  },
  category: {
    build: (b) => b
      .addSubcommand((s) => s.setName('create').setDescription('Registra una categoría a la que mover tickets')
        .addStringOption((o) => o.setName('nombre').setDescription('Nombre (sin espacios), p. ej. admin')
          .setRequired(true).setMaxLength(50))
        .addChannelOption((o) => o.setName('categoria').setDescription('Categoría de Discord existente (si no, se crea una)')
          .addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption((o) => o.setName('rol').setDescription('Rol con acceso si se crea la categoría (por defecto: staff)'))
        .addRoleOption((o) => o.setName('rol2').setDescription('Otro rol con acceso'))
        .addRoleOption((o) => o.setName('rol3').setDescription('Otro rol con acceso')))
      .addSubcommand((s) => s.setName('delete').setDescription('Quita una categoría del registro')
        .addStringOption((o) => o.setName('nombre').setDescription('Categoría').setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Lista las categorías registradas')),
    toArgs: (i) => {
      const o = i.options;
      const sub = o.getSubcommand();
      const name = o.getString('nombre') ?? '';
      if (/\s/.test(name)) throw new U.UserError('El nombre de la categoría no puede tener espacios.');
      if (sub !== 'create') return [sub, name].filter(Boolean).join(' ');
      const roles = ['rol', 'rol2', 'rol3'].map((n) => o.getRole(n)).filter(Boolean).map((r) => `<@&${r.id}>`);
      return ['create', name, o.getChannel('categoria')?.id, ...roles].filter(Boolean).join(' ');
    },
    autocomplete: (i) => S.categoryChoices(i, false),
  },
};

for (const cmd of commands) cmd.slash = SLASH[cmd.name];
module.exports = commands;
