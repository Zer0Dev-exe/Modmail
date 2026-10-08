const { EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');

/** Error "esperado" que se muestra al staff tal cual (uso incorrecto, ticket inexistente...). */
class UserError extends Error {}

const DEFAULT_COLORS = {
  user: 0x5865f2,
  staff: 0x57f287,
  anon: 0x3ba55c,
  note: 0xfee75c,
  greeting: 0x57f287,
  closing: 0xed4245,
  blocked: 0xed4245,
  info: 0x5865f2,
  success: 0x57f287,
  error: 0xed4245,
  system: 0x99aab5,
};

const COLOR_INFO = {
  user: 'Mensajes del usuario en el ticket',
  staff: 'Respuestas con reply',
  anon: 'Respuestas anónimas con areply',
  note: 'Notas internas',
  greeting: 'Mensaje de bienvenida que recibe el usuario',
  closing: 'Mensaje de cierre que recibe el usuario',
  blocked: 'Mensaje para usuarios bloqueados',
  info: 'Mensajes informativos del bot (help, listas, cabecera del ticket...)',
  success: 'Confirmaciones del bot',
  error: 'Errores del bot',
  system: 'Logs y avisos de sistema',
};

// Colores activos: los valores por defecto con las personalizaciones de la base de datos encima
const COLORS = { ...DEFAULT_COLORS };

function applyColors(custom) {
  Object.assign(COLORS, DEFAULT_COLORS);
  for (const [key, value] of custom ?? []) {
    if (key in DEFAULT_COLORS) COLORS[key] = value;
  }
}

/** Convierte "#ff0000", "ff0000" o "0xff0000" en número, o null si no es válido. */
function parseColor(str) {
  const match = str?.trim().match(/^(?:#|0x)?([0-9a-f]{6})$/i);
  return match ? parseInt(match[1], 16) : null;
}

const hex = (n) => `#${n.toString(16).padStart(6, '0').toUpperCase()}`;

const MB = 1024 * 1024;
const DM_UPLOAD_LIMIT = 10 * MB;

function guildUploadLimit(guild) {
  if (guild.premiumTier >= 3) return 100 * MB;
  if (guild.premiumTier >= 2) return 50 * MB;
  return 10 * MB;
}

const STAFF_PERMS = {
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
  AddReactions: true,
};
const BOT_PERMS = { ...STAFF_PERMS, ManageChannels: true, ManageMessages: true };

const toFlags = (perms) => Object.keys(perms).map((name) => PermissionFlagsBits[name]);

/** Overwrites para un canal/categoría que solo ve el staff (y el bot). */
function staffOverwrites(guild, roleIds) {
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: guild.client.user.id, allow: toFlags(BOT_PERMS) },
    ...roleIds
      .filter((id) => guild.roles.cache.has(id))
      .map((id) => ({ id, allow: toFlags(STAFF_PERMS) })),
  ];
}

/** Garantiza que el canal nunca quede visible para @everyone (p. ej. tras sincronizar con una categoría). */
async function ensurePrivate(channel) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { ViewChannel: false });
  await channel.permissionOverwrites.edit(channel.client.user.id, BOT_PERMS);
}

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function isStaff(member, cfg) {
  return isAdmin(member) || cfg.staffRoles.some((id) => member.roles.cache.has(id));
}

function embed(type, text) {
  return new EmbedBuilder().setColor(COLORS[type] ?? COLORS.info).setDescription(text);
}

function respond(message, type, text) {
  return message.reply({ embeds: [embed(type, text)], allowedMentions: { repliedUser: false } });
}

const ts = (date, style = 'R') => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

const truncate = (str, max) => (str.length > max ? `${str.slice(0, max - 1)}…` : str);

/** Separa la primera palabra del resto SIN tocar el resto (barras, comillas, saltos de línea...). */
function splitFirst(str) {
  const match = str.match(/^(\S*)\s*([\s\S]*)$/);
  return [match[1], match[2].trim()];
}

function parseId(str, kind) {
  if (!str) return null;
  const patterns = {
    user: /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/,
    role: /^(?:<@&(\d{17,20})>|(\d{17,20}))$/,
    channel: /^(?:<#(\d{17,20})>|(\d{17,20}))$/,
  };
  const match = str.match(patterns[kind]);
  return match ? (match[1] ?? match[2]) : null;
}

function channelName(username, number) {
  const clean = username.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80) || 'usuario';
  return `${clean}-${number}`;
}

/** Sustituye {variable} en una plantilla. Las variables desconocidas se dejan tal cual. */
function render(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => vars[key] ?? whole);
}

function vars({ guild, user, staff }) {
  return {
    server: guild.name,
    user: user ? `<@${user.id}>` : undefined,
    username: user?.username,
    staff: staff?.displayName,
  };
}

/** Texto del mensaje tal cual lo escribió el usuario, más los stickers (que no se pueden reenviar). */
function messageText(message) {
  let text = message.content ?? '';
  if (message.stickers?.size) {
    text += `${text ? '\n' : ''}${message.stickers.map((s) => `*[Sticker: ${s.name}]*`).join(' ')}`;
  }
  return text;
}

/**
 * Descarga los adjuntos en memoria para poder resubirlos (los enlaces de Discord caducan
 * y desaparecen si se borra el mensaje original). Los que superan maxBytes no se descargan.
 */
async function downloadAttachments(attachments, maxBytes) {
  const items = [];
  for (const att of attachments.values()) {
    const item = { name: att.name, url: att.url, size: att.size, buffer: null };
    if (att.size <= maxBytes) {
      try {
        const res = await fetch(att.url);
        if (res.ok) item.buffer = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        console.warn(`No se pudo descargar ${att.name}:`, err.message);
      }
    }
    items.push(item);
  }
  return items;
}

/** Decide qué adjuntos se resuben como archivo y cuáles se mandan como enlace según el límite. */
function splitAttachments(items, limit) {
  const files = [];
  const links = [];
  for (const item of items) {
    if (item.buffer && item.size <= limit && files.length < 10) {
      files.push(new AttachmentBuilder(item.buffer, { name: item.name }));
    } else {
      links.push(item);
    }
  }
  return { files, links };
}

function addLinksField(emb, links) {
  if (!links.length) return emb;
  const value = links.map((l) => `[${l.name.replace(/[[\]]/g, '')}](${l.url})`).join('\n');
  return emb.addFields({ name: '📎 Archivos demasiado grandes para resubir', value: truncate(value, 1024) });
}

const DURATION_UNITS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

/** "30m", "2h", "1d", "1h30m" → milisegundos, o null si no es una duración. */
function parseDuration(str) {
  if (!str || !/^(\d+[smhd])+$/i.test(str)) return null;
  let ms = 0;
  for (const [, n, unit] of str.toLowerCase().matchAll(/(\d+)([smhd])/g)) ms += Number(n) * DURATION_UNITS[unit];
  return ms;
}

/** Prefijo a mostrar en los textos del bot: el configurado o "/" si los comandos con prefijo están desactivados. */
const cmdPrefix = (cfg) => (require('./env').PREFIX ? cfg.prefix : '/');

const sysLog = (content) => ({ type: 'system', content, at: new Date() });

module.exports = {
  UserError,
  COLORS,
  DEFAULT_COLORS,
  COLOR_INFO,
  applyColors,
  parseColor,
  hex,
  DM_UPLOAD_LIMIT,
  STAFF_PERMS,
  guildUploadLimit,
  staffOverwrites,
  ensurePrivate,
  isAdmin,
  isStaff,
  embed,
  respond,
  ts,
  truncate,
  splitFirst,
  parseId,
  channelName,
  render,
  vars,
  messageText,
  downloadAttachments,
  splitAttachments,
  addLinksField,
  parseDuration,
  cmdPrefix,
  sysLog,
};
