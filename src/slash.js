const {
  SlashCommandBuilder, Collection, PermissionFlagsBits, InteractionContextType, MessageFlags,
} = require('discord.js');
const { Snippet, Category } = require('./models');
const U = require('./util');

/** En las opciones de slash no se pueden escribir saltos de línea: "\n" se convierte en uno. */
const nl = (str) => (str ?? '').replace(/\\n/g, '\n').trim();

/** Añade opciones de archivo (archivo, archivo2, archivo3...). */
function withFiles(builder, count = 3) {
  for (let n = 1; n <= count; n++) {
    builder.addAttachmentOption((o) => o.setName(n === 1 ? 'archivo' : `archivo${n}`).setDescription('Archivo adjunto'));
  }
  return builder;
}

function collectAttachments(options) {
  const out = new Collection();
  const walk = (list) => {
    for (const opt of list ?? []) {
      if (opt.attachment) out.set(opt.attachment.id, opt.attachment);
      walk(opt.options);
    }
  };
  walk(options.data);
  return out;
}

async function snippetChoices(interaction) {
  const snippets = await Snippet.find({ guildId: interaction.guildId }).sort({ name: 1 }).limit(100);
  return snippets.map((s) => ({ name: s.name, value: s.name }));
}

async function categoryChoices(interaction, includeDefault = true) {
  const cats = await Category.find({ guildId: interaction.guildId }).sort({ name: 1 }).limit(100);
  const names = [...(includeDefault ? ['default'] : []), ...cats.map((c) => c.name)];
  return names.map((name) => ({ name, value: name }));
}

function buildDefinition(cmd) {
  const builder = new SlashCommandBuilder()
    .setName(cmd.slash.name ?? cmd.name)
    .setDescription(U.truncate((cmd.slash.description ?? cmd.description).replace(/[`*]/g, ''), 100))
    .setContexts(InteractionContextType.Guild);
  if (cmd.level === 'admin') builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  cmd.slash.build?.(builder);
  return builder.toJSON();
}

/**
 * Envuelve una interacción para que se comporte como un mensaje y así los comandos funcionen igual
 * con prefijo y con slash. Las respuestas del bot al staff son efímeras; lo que se publica en el
 * canal (respuestas al usuario, notas, claim...) sigue siendo público.
 */
function createAdapter(interaction) {
  const state = { replied: false, deleted: false };
  const respond = async (payload) => {
    const data = typeof payload === 'string' ? { content: payload } : { ...payload };
    delete data.allowedMentions?.repliedUser;
    if (!state.replied && !state.deleted) {
      state.replied = true;
      return interaction.editReply(data);
    }
    return interaction.followUp({ ...data, flags: MessageFlags.Ephemeral });
  };

  const message = {
    client: interaction.client,
    guild: interaction.guild,
    guildId: interaction.guildId,
    member: interaction.member,
    author: interaction.user,
    channel: interaction.channel,
    channelId: interaction.channelId,
    content: '',
    attachments: collectAttachments(interaction.options),
    stickers: new Collection(),
    mentions: { roles: new Collection(), channels: new Collection(), users: new Collection() },
    reply: respond,
    react: (emoji) => respond({ content: emoji }),
    // En prefijo se borra el comando; aquí equivale a quitar el "pensando..." sin decir nada
    delete: async () => {
      if (state.replied || state.deleted) return;
      state.deleted = true;
      await interaction.deleteReply();
    },
  };
  return { message, state };
}

module.exports = { nl, withFiles, snippetChoices, categoryChoices, buildDefinition, createAdapter };
