const { Schema, model } = require('mongoose');

const configSchema = new Schema({
  guildId: { type: String, required: true, unique: true },
  prefix: { type: String, default: '!' },
  staffRoles: { type: [String], default: [] },
  notifyRoleId: { type: String, default: null },
  logChannelId: { type: String, default: null },
  defaultCategoryId: { type: String, default: null },
  ticketCount: { type: Number, default: 0 },
  // Mensajes personalizados; las claves que falten usan los valores por defecto de config.js
  messages: { type: Map, of: String, default: {} },
  // Colores personalizados de los embeds (clave -> número); las que falten usan util.DEFAULT_COLORS
  colors: { type: Map, of: Number, default: {} },
});

const logEntrySchema = new Schema({
  type: { type: String, enum: ['user', 'staff', 'anon', 'note', 'system'], required: true },
  authorId: String,
  authorTag: String,
  content: { type: String, default: '' },
  attachments: { type: [String], default: [] },
  dmMessageId: String,
  channelMessageId: String,
  edited: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
  at: { type: Date, default: Date.now },
}, { _id: false });

const ticketSchema = new Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  userTag: String,
  channelId: { type: String, required: true, index: true },
  number: Number,
  open: { type: Boolean, default: true },
  claimedBy: { type: String, default: null },
  subscribers: { type: [String], default: [] },
  category: { type: String, default: null },
  openedBy: { type: String, default: null },
  closedBy: String,
  closeReason: String,
  closedAt: Date,
  // Cierre automático programado con "close <duración>"; se cancela si el usuario responde
  scheduledClose: {
    type: new Schema({
      at: { type: Date, required: true },
      by: String,
      byTag: String,
      reason: String,
      silent: { type: Boolean, default: false },
    }, { _id: false }),
    default: null,
  },
  log: { type: [logEntrySchema], default: [] },
}, { timestamps: true });

ticketSchema.index({ open: 1, 'scheduledClose.at': 1 });

// Un usuario solo puede tener un ticket abierto a la vez
ticketSchema.index({ guildId: 1, userId: 1 }, { unique: true, partialFilterExpression: { open: true } });

const categorySchema = new Schema({
  guildId: { type: String, required: true },
  name: { type: String, required: true },
  discordCategoryId: { type: String, required: true },
});
categorySchema.index({ guildId: 1, name: 1 }, { unique: true });

const blockSchema = new Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  reason: String,
  blockedBy: String,
}, { timestamps: true });
blockSchema.index({ guildId: 1, userId: 1 }, { unique: true });

const snippetSchema = new Schema({
  guildId: { type: String, required: true },
  name: { type: String, required: true },
  content: { type: String, required: true },
  createdBy: String,
});
snippetSchema.index({ guildId: 1, name: 1 }, { unique: true });

module.exports = {
  Config: model('Config', configSchema),
  Ticket: model('Ticket', ticketSchema),
  Category: model('Category', categorySchema),
  Block: model('Block', blockSchema),
  Snippet: model('Snippet', snippetSchema),
};
