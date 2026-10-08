const { EmbedBuilder, AttachmentBuilder, ChannelType } = require('discord.js');
const { Ticket, Block, Config } = require('./models');
const { getConfig, getMessage } = require('./config');
const U = require('./util');

// Cola por usuario: los mensajes de un mismo usuario se procesan en orden y nunca
// se crean dos tickets a la vez aunque mande varios MD seguidos.
const queues = new Map();
function enqueue(key, fn) {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, next);
  next.catch(() => {}).then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

async function getGuild(client) {
  return client.guilds.cache.get(process.env.GUILD_ID) ?? client.guilds.fetch(process.env.GUILD_ID);
}

const BLOCK_NOTICE_COOLDOWN = 60 * 60 * 1000;
const blockedNotices = new Map();

/** Bloqueo vigente del usuario (el TTL de MongoDB tarda hasta un minuto en borrar los caducados). */
function getActiveBlock(guildId, userId) {
  return Block.findOne({
    guildId,
    userId,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
}

function addLog(ticket, entry) {
  return Ticket.updateOne({ _id: ticket._id }, { $push: { log: { ...entry, at: new Date() } } });
}

async function sendLog(guild, cfg, payload) {
  const channel = cfg.logChannelId && guild.channels.cache.get(cfg.logChannelId);
  if (channel) await channel.send(payload).catch((err) => console.error('Error enviando log:', err.message));
}

/** Devuelve el canal del ticket o, si alguien lo borró, marca el ticket como cerrado y devuelve null. */
async function fetchTicketChannel(guild, ticket) {
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel) {
    await Ticket.updateOne(
      { _id: ticket._id },
      { $set: { open: false, closedAt: new Date(), closeReason: 'El canal ya no existía' } },
    );
  }
  return channel;
}

async function openTicket(guild, user, cfg, { openedBy = null } = {}) {
  const counter = await Config.findOneAndUpdate({ guildId: guild.id }, { $inc: { ticketCount: 1 } }, { new: true });
  const number = counter.ticketCount;
  const parent = cfg.defaultCategoryId && guild.channels.cache.get(cfg.defaultCategoryId);

  const channel = await guild.channels.create({
    name: U.channelName(user.username, number),
    type: ChannelType.GuildText,
    parent: parent?.id ?? null,
    topic: `Ticket #${number} · ${user.tag} (${user.id})`,
    permissionOverwrites: U.staffOverwrites(guild, cfg.staffRoles),
    reason: `Ticket de modmail de ${user.tag}`,
  });

  let ticket;
  try {
    ticket = await Ticket.create({
      guildId: guild.id,
      userId: user.id,
      userTag: user.tag,
      channelId: channel.id,
      number,
      openedBy: openedBy?.id ?? null,
      subscribers: openedBy ? [openedBy.id] : [],
      log: [U.sysLog(openedBy ? `Ticket abierto por ${openedBy.tag} (contact)` : 'Ticket abierto por el usuario')],
    });
  } catch (err) {
    await channel.delete().catch(() => {});
    throw err;
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  const previous = await Ticket.countDocuments({ guildId: guild.id, userId: user.id, open: false });
  const roles = member
    ? member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.toString()).join(' ')
    : '';

  const header = new EmbedBuilder()
    .setColor(U.COLORS.info)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
    .setTitle(`Ticket #${number}`)
    .addFields(
      { name: 'Usuario', value: `${user} (\`${user.id}\`)` },
      { name: 'Cuenta creada', value: U.ts(user.createdAt), inline: true },
      { name: 'Entró al servidor', value: member ? U.ts(member.joinedAt) : 'No está en el servidor', inline: true },
      { name: 'Tickets anteriores', value: String(previous), inline: true },
      { name: 'Roles', value: U.truncate(roles || 'Ninguno', 1024) },
    )
    .setFooter({
      text: openedBy
        ? `Abierto por ${openedBy.tag} · ${U.cmdPrefix(cfg)}help para ver los comandos`
        : `${U.cmdPrefix(cfg)}help para ver los comandos`,
    })
    .setTimestamp();

  await channel.send({
    content: cfg.notifyRoleId ? `<@&${cfg.notifyRoleId}>` : undefined,
    embeds: [header],
    allowedMentions: { roles: cfg.notifyRoleId ? [cfg.notifyRoleId] : [] },
  });

  await sendLog(guild, cfg, {
    embeds: [U.embed('info', `📬 **Ticket #${number}** abierto para ${user} (\`${user.id}\`) → ${channel}`
      + (openedBy ? `\nAbierto por ${openedBy}` : ''))],
    allowedMentions: { parse: [] },
  });

  return { ticket, channel };
}

// ─── Usuario → staff ────────────────────────────────────────────────────────────

async function handleDM(client, message) {
  const guild = await getGuild(client);
  const cfg = await getConfig(guild.id);
  return enqueue(message.author.id, () => processUserMessage(guild, cfg, message));
}

async function processUserMessage(guild, cfg, message) {
  const { author } = message;

  const block = await getActiveBlock(guild.id, author.id);
  if (block) {
    // Se avisa como mucho una vez por hora para que no pueda usar al bot para hacer spam
    const last = blockedNotices.get(author.id) ?? 0;
    if (Date.now() - last > BLOCK_NOTICE_COOLDOWN) {
      blockedNotices.set(author.id, Date.now());
      const emb = U.embed('blocked', getMessage(cfg, 'blocked', U.vars({ guild, user: author })))
        .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined });
      if (block.reason) emb.addFields({ name: 'Motivo', value: U.truncate(block.reason, 1024), inline: true });
      if (block.expiresAt) emb.addFields({ name: 'Hasta', value: `${U.ts(block.expiresAt, 'f')} (${U.ts(block.expiresAt)})`, inline: true });
      await message.channel.send({ embeds: [emb] }).catch(() => {});
    }
    return;
  }

  try {
    let ticket = await Ticket.findOne({ guildId: guild.id, userId: author.id, open: true });
    let channel = ticket ? await fetchTicketChannel(guild, ticket) : null;
    const isNew = !channel;
    if (isNew) ({ ticket, channel } = await openTicket(guild, author, cfg));

    await relayUserMessage(guild, ticket, channel, message);

    // El usuario ha contestado: se cancela el cierre automático pendiente
    if (ticket.scheduledClose?.at) {
      await Ticket.updateOne(
        { _id: ticket._id },
        { $set: { scheduledClose: null }, $push: { log: U.sysLog('Cierre automático cancelado: el usuario respondió') } },
      );
      await channel.send({ embeds: [U.embed('info', '⏹️ Cierre automático cancelado: el usuario ha respondido.')] });
    }

    if (isNew) {
      const v = U.vars({ guild, user: author });
      await author.send({
        embeds: [new EmbedBuilder()
          .setColor(U.COLORS.greeting)
          .setTitle(getMessage(cfg, 'greetingTitle', v))
          .setDescription(getMessage(cfg, 'greeting', v))
          .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })
          .setTimestamp()],
      }).catch(() => {});
    }
    await message.react('✅').catch(() => {});
  } catch (err) {
    console.error('Error procesando MD:', err);
    await message.react('❌').catch(() => {});
  }
}

async function relayUserMessage(guild, ticket, channel, message) {
  const limit = U.guildUploadLimit(guild);
  const items = await U.downloadAttachments(message.attachments, limit);
  const { files, links } = U.splitAttachments(items, limit);
  const text = U.messageText(message);

  const emb = new EmbedBuilder()
    .setColor(U.COLORS.user)
    .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
    .setDescription(text || null)
    .setFooter({ text: `ID: ${message.author.id}` })
    .setTimestamp();
  U.addLinksField(emb, links);

  // Avisar a quien haya reclamado el ticket y a los suscritos
  const pings = [...new Set([ticket.claimedBy, ...ticket.subscribers].filter(Boolean))];
  const sent = await channel.send({
    content: pings.length ? pings.map((id) => `<@${id}>`).join(' ') : undefined,
    embeds: [emb],
    files,
    allowedMentions: { users: pings },
  });

  await addLog(ticket, {
    type: 'user',
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: text,
    attachments: items.map((i) => i.url),
    dmMessageId: message.id,
    channelMessageId: sent.id,
  });
}

// ─── Staff → usuario ────────────────────────────────────────────────────────────

async function sendStaffReply({ message, cfg, ticket, text, anonymous, includeAttachments = true, renderVars = false }) {
  const { guild, member } = message;
  const user = await message.client.users.fetch(ticket.userId).catch(() => null);
  if (!user) throw new U.UserError('No se ha encontrado al usuario de este ticket.');

  const v = U.vars({ guild, user, staff: member });
  if (renderVars) text = U.render(text, v);

  const guildLimit = U.guildUploadLimit(guild);
  const items = includeAttachments ? await U.downloadAttachments(message.attachments, guildLimit) : [];
  if (!text && !items.length) throw new U.UserError('Escribe un mensaje o adjunta algún archivo.');

  const role = member.roles.highest.id === guild.id ? null : member.roles.highest.name;
  const author = anonymous
    ? { name: getMessage(cfg, 'anonName', v), iconURL: guild.iconURL() ?? undefined }
    : { name: member.displayName, iconURL: member.displayAvatarURL() };
  const makeEmbed = (footer, links) => U.addLinksField(
    new EmbedBuilder()
      .setColor(anonymous ? U.COLORS.anon : U.COLORS.staff)
      .setAuthor(author)
      .setDescription(text || null)
      .setFooter({ text: footer })
      .setTimestamp(),
    links,
  );

  // 1) Copia en el canal del ticket (el staff ve quién respondió aunque sea anónimo)
  const ch = U.splitAttachments(items, guildLimit);
  const chFooter = anonymous ? `Respuesta anónima · enviada por ${message.author.tag}` : `Respuesta · ${role ?? 'Staff'}`;
  const chMsg = await message.channel.send({ embeds: [makeEmbed(chFooter, ch.links)], files: ch.files });

  // Los archivos que no quepan en el MD se enlazan a la copia del canal (el original se borra)
  const uploaded = [...chMsg.attachments.values()];
  let idx = 0;
  for (const item of items) {
    if (item.buffer && item.size <= guildLimit && idx < uploaded.length) item.url = uploaded[idx++].url;
  }

  // 2) MD al usuario
  const dm = U.splitAttachments(items, U.DM_UPLOAD_LIMIT);
  const dmFooter = anonymous || !role ? guild.name : `${role} · ${guild.name}`;
  let dmMsg;
  try {
    dmMsg = await user.send({ embeds: [makeEmbed(dmFooter, dm.links)], files: dm.files });
  } catch {
    await chMsg.delete().catch(() => {});
    throw new U.UserError('No se ha podido enviar el mensaje al usuario. Puede que tenga los MD cerrados, '
      + 'haya bloqueado al bot o ya no comparta servidor con él.');
  }

  // 3) Borrar el comando original, salvo si tiene algún archivo que no se pudo resubir
  if (items.every((i) => i.buffer)) await message.delete().catch(() => {});

  await addLog(ticket, {
    type: anonymous ? 'anon' : 'staff',
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: text,
    attachments: [...dmMsg.attachments.values()].map((a) => a.url).concat(dm.links.map((l) => l.url)),
    dmMessageId: dmMsg.id,
    channelMessageId: chMsg.id,
  });
}

function lastReplyOf(ticket, staffId) {
  return [...ticket.log].reverse()
    .find((e) => (e.type === 'staff' || e.type === 'anon') && e.authorId === staffId && !e.deleted);
}

async function fetchReplyMessages(message, ticket, entry) {
  const user = await message.client.users.fetch(ticket.userId);
  const dmChannel = await user.createDM();
  const dmMsg = await dmChannel.messages.fetch(entry.dmMessageId).catch(() => null);
  const chMsg = await message.channel.messages.fetch(entry.channelMessageId).catch(() => null);
  return { dmMsg, chMsg };
}

async function editLastReply(message, ticket, text) {
  const entry = lastReplyOf(ticket, message.author.id);
  if (!entry) throw new U.UserError('No tienes ninguna respuesta que editar en este ticket.');
  const { dmMsg, chMsg } = await fetchReplyMessages(message, ticket, entry);
  if (!dmMsg) throw new U.UserError('No se ha encontrado el mensaje en el MD del usuario.');

  await dmMsg.edit({ embeds: [EmbedBuilder.from(dmMsg.embeds[0]).setDescription(text)] });
  if (chMsg) {
    const old = chMsg.embeds[0];
    const footer = old.footer?.text ?? '';
    await chMsg.edit({
      embeds: [EmbedBuilder.from(old).setDescription(text)
        .setFooter({ text: footer.endsWith('(editado)') ? footer : `${footer} (editado)` })],
    });
  }
  await Ticket.updateOne(
    { _id: ticket._id, 'log.dmMessageId': entry.dmMessageId },
    { $set: { 'log.$.content': text, 'log.$.edited': true } },
  );
}

async function deleteLastReply(message, ticket) {
  const entry = lastReplyOf(ticket, message.author.id);
  if (!entry) throw new U.UserError('No tienes ninguna respuesta que borrar en este ticket.');
  const { dmMsg, chMsg } = await fetchReplyMessages(message, ticket, entry);
  if (dmMsg) await dmMsg.delete();
  if (chMsg) {
    const old = chMsg.embeds[0];
    await chMsg.edit({
      embeds: [EmbedBuilder.from(old).setColor(U.COLORS.error).setFooter({ text: `${old.footer?.text ?? ''} (eliminado)` })],
    });
  }
  await Ticket.updateOne(
    { _id: ticket._id, 'log.dmMessageId': entry.dmMessageId },
    { $set: { 'log.$.deleted': true } },
  );
}

// ─── Contact / cierre ───────────────────────────────────────────────────────────

function contactUser(guild, cfg, user, staffUser) {
  return enqueue(user.id, async () => {
    const existing = await Ticket.findOne({ guildId: guild.id, userId: user.id, open: true });
    const existingChannel = existing && await fetchTicketChannel(guild, existing);
    if (existingChannel) return { channel: existingChannel, created: false };
    const { channel } = await openTicket(guild, user, cfg, { openedBy: staffUser });
    return { channel, created: true };
  });
}

function closeTicket({ guild, cfg, ticket, closer = null, reason = null, silent = false, channelDeleted = false, auto = false }) {
  return enqueue(ticket.userId, async () => {
    const filter = { _id: ticket._id, open: true };
    // Un cierre automático solo se ejecuta si sigue programado (el usuario no ha respondido entretanto)
    if (auto) filter['scheduledClose.at'] = { $lte: new Date() };
    const how = auto ? ' automáticamente' : '';
    const closed = await Ticket.findOneAndUpdate(
      filter,
      {
        $set: { open: false, closedAt: new Date(), closedBy: closer?.id ?? null, closeReason: reason, scheduledClose: null },
        $push: { log: U.sysLog(`Ticket cerrado${how}${closer ? ` (${auto ? 'programado' : 'por'} ${closer.tag})` : ''}`
          + `${reason ? ` · Motivo: ${reason}` : ''}`) },
      },
      { new: true },
    );
    if (!closed) return false;

    const user = await guild.client.users.fetch(closed.userId).catch(() => null);
    if (user && !silent) {
      const v = U.vars({ guild, user });
      const emb = new EmbedBuilder()
        .setColor(U.COLORS.closing)
        .setTitle(getMessage(cfg, 'closingTitle', v))
        .setDescription(getMessage(cfg, 'closing', v))
        .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })
        .setTimestamp();
      if (reason) emb.addFields({ name: 'Motivo', value: U.truncate(reason, 1024) });
      await user.send({ embeds: [emb] }).catch(() => {});
    }

    await sendTranscript(guild, cfg, closed, closer);

    if (!channelDeleted) {
      const channel = guild.channels.cache.get(closed.channelId);
      if (channel) await channel.delete(`Ticket cerrado por ${closer?.tag ?? 'sistema'}`).catch(console.error);
    }
    return true;
  });
}

const MAX_AUTO_CLOSE = 30 * 24 * 60 * 60 * 1000;

async function scheduleClose({ message, guild, cfg, ticket, ms, reason, silent }) {
  if (ms < 60 * 1000 || ms > MAX_AUTO_CLOSE) throw new U.UserError('La duración debe estar entre 1 minuto y 30 días.');
  const at = new Date(Date.now() + ms);
  await Ticket.updateOne(
    { _id: ticket._id },
    {
      $set: { scheduledClose: { at, by: message.author.id, byTag: message.author.tag, reason, silent } },
      $push: { log: U.sysLog(`${message.author.tag} programó el cierre automático para ${at.toISOString()}`) },
    },
  );

  let warned = false;
  if (!silent) {
    const user = await message.client.users.fetch(ticket.userId).catch(() => null);
    const text = getMessage(cfg, 'autoClose', { ...U.vars({ guild, user }), time: U.ts(at) });
    warned = Boolean(user && await user.send({
      embeds: [U.embed('closing', text).setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })],
    }).catch(() => null));
  }

  await message.channel.send({
    embeds: [U.embed('info', [
      `⏰ El ticket se cerrará ${U.ts(at)} (${U.ts(at, 'f')}) si el usuario no responde.`,
      reason ? `**Motivo:** ${reason}` : null,
      silent ? '🔇 Cierre silencioso: no se avisará al usuario.' : (warned ? '📨 Se ha avisado al usuario.' : '⚠️ No se pudo avisar al usuario por MD.'),
      `Usa \`${U.cmdPrefix(cfg)}close cancel\` para cancelarlo.`,
    ].filter(Boolean).join('\n'))],
  });
}

async function cancelScheduledClose(message, ticket) {
  if (!ticket.scheduledClose?.at) throw new U.UserError('Este ticket no tiene ningún cierre programado.');
  await Ticket.updateOne(
    { _id: ticket._id },
    { $set: { scheduledClose: null }, $push: { log: U.sysLog(`${message.author.tag} canceló el cierre automático`) } },
  );
  await message.channel.send({ embeds: [U.embed('info', `⏹️ ${message.author} ha cancelado el cierre automático.`)] });
}

/** Revisa cada 30 s los tickets con cierre programado vencido (sobrevive a reinicios: está en la base de datos). */
function startAutoCloseLoop(client) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await Ticket.find({ guildId: process.env.GUILD_ID, open: true, 'scheduledClose.at': { $lte: new Date() } });
      if (!due.length) return;
      const guild = await getGuild(client);
      const cfg = await getConfig(guild.id);
      for (const ticket of due) {
        const { by, reason, silent } = ticket.scheduledClose;
        const closer = by ? await client.users.fetch(by).catch(() => null) : null;
        await closeTicket({ guild, cfg, ticket, closer, reason, silent, auto: true })
          .catch((err) => console.error(`Error en el cierre automático del ticket #${ticket.number}:`, err));
      }
    } catch (err) {
      console.error('Error revisando cierres automáticos:', err);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, 30 * 1000);
}

const LOG_LABELS = { user: 'USUARIO', staff: 'STAFF', anon: 'STAFF (anónimo)', note: 'NOTA INTERNA', system: 'SISTEMA' };
const fmtDate = (d) => (d ? `${new Date(d).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '-');

function buildTranscript(guild, ticket) {
  const lines = [
    `Ticket #${ticket.number} · ${guild.name}`,
    `Usuario: ${ticket.userTag} (${ticket.userId})`,
    `Abierto: ${fmtDate(ticket.createdAt)}`,
    `Cerrado: ${fmtDate(ticket.closedAt)}`,
    `Motivo: ${ticket.closeReason || 'Sin motivo'}`,
    '='.repeat(60),
    '',
  ];
  for (const e of ticket.log) {
    const flags = [e.edited && 'editado', e.deleted && 'eliminado'].filter(Boolean);
    lines.push(`[${fmtDate(e.at)}] [${LOG_LABELS[e.type]}]${e.authorTag ? ` ${e.authorTag}` : ''}`
      + `${flags.length ? ` (${flags.join(', ')})` : ''}:`);
    if (e.content) lines.push(...e.content.split('\n').map((l) => `    ${l}`));
    for (const url of e.attachments) lines.push(`    [adjunto] ${url}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function sendTranscript(guild, cfg, ticket, closer) {
  const count = (type) => ticket.log.filter((e) => e.type === type).length;
  const emb = new EmbedBuilder()
    .setColor(U.COLORS.system)
    .setTitle(`🔒 Ticket #${ticket.number} cerrado`)
    .addFields(
      { name: 'Usuario', value: `<@${ticket.userId}> (\`${ticket.userId}\`)`, inline: true },
      { name: 'Cerrado por', value: closer ? `${closer}` : 'Sistema', inline: true },
      { name: 'Reclamado por', value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Nadie', inline: true },
      { name: 'Mensajes', value: `Usuario: ${count('user')} · Staff: ${count('staff') + count('anon')}`, inline: true },
      { name: 'Abierto', value: U.ts(ticket.createdAt, 'f'), inline: true },
      { name: 'Motivo', value: U.truncate(ticket.closeReason || 'Sin motivo', 1024) },
    )
    .setTimestamp();
  const file = new AttachmentBuilder(Buffer.from(buildTranscript(guild, ticket), 'utf8'), {
    name: `ticket-${ticket.number}.txt`,
  });
  await sendLog(guild, cfg, { embeds: [emb], files: [file], allowedMentions: { parse: [] } });
}

module.exports = {
  getGuild,
  getActiveBlock,
  sendLog,
  addLog,
  handleDM,
  sendStaffReply,
  editLastReply,
  deleteLastReply,
  contactUser,
  closeTicket,
  scheduleClose,
  cancelScheduledClose,
  startAutoCloseLoop,
};
