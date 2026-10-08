const { Config } = require('./models');
const { render, applyColors } = require('./util');

const DEFAULT_MESSAGES = {
  greetingTitle: '📬 Ticket abierto',
  greeting: 'Hola {username}, gracias por contactar con el staff de **{server}**.\n'
    + 'Hemos recibido tu mensaje y te responderemos lo antes posible. Todo lo que escribas aquí le llegará al equipo.',
  closingTitle: '🔒 Ticket cerrado',
  closing: 'Tu ticket ha sido cerrado. Si necesitas algo más, solo tienes que volver a escribirnos por aquí.',
  autoClose: 'Si no recibimos respuesta tuya {time}, este ticket se cerrará automáticamente.',
  anonName: 'Staff de {server}',
  blocked: 'No puedes contactar con el staff en este momento.',
};

const MESSAGE_INFO = {
  greetingTitle: 'Título del mensaje que recibe el usuario al abrir un ticket',
  greeting: 'Mensaje que recibe el usuario al abrir un ticket',
  closingTitle: 'Título del mensaje de cierre',
  closing: 'Mensaje que recibe el usuario al cerrar el ticket',
  autoClose: 'Aviso al usuario al programar un cierre automático ({time} = cuándo se cierra)',
  anonName: 'Nombre que aparece en las respuestas anónimas (areply)',
  blocked: 'Mensaje para usuarios bloqueados',
};

const cache = new Map();

async function getConfig(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);
  const cfg = await Config.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true },
  );
  cache.set(guildId, cfg);
  applyColors(cfg.colors);
  return cfg;
}

async function saveConfig(cfg) {
  await cfg.save();
  cache.set(cfg.guildId, cfg);
  applyColors(cfg.colors);
}

function getMessage(cfg, key, vars = {}) {
  const template = cfg.messages?.get(key) ?? DEFAULT_MESSAGES[key] ?? '';
  return render(template, vars);
}

module.exports = { DEFAULT_MESSAGES, MESSAGE_INFO, getConfig, saveConfig, getMessage };
