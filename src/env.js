/** Lee un interruptor true/false del .env. Si no está definido (o está vacío) vale `def`. */
function flag(name, def = true) {
  const value = process.env[name]?.trim();
  if (!value) return def;
  return /^(true|1|yes|y|si|sí|on)$/i.test(value);
}

module.exports = {
  get SLASH() { return flag('SLASH'); },
  get PREFIX() { return flag('PREFIX'); },
};
