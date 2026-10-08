# Modmail (discord.js + MongoDB)

Los usuarios escriben al bot por MD y se abre un ticket en un canal privado que **solo ve el staff**.
El staff responde desde ese canal; los mensajes sin prefijo son internos (el usuario no los ve).

## Puesta en marcha

1. **Discord Developer Portal** → tu aplicación → *Bot*:
   - Activa **Message Content Intent**.
   - Invita al bot con los permisos `Administrator` (o como mínimo: Gestionar canales, Gestionar roles,
     Ver canales, Enviar mensajes, Insertar enlaces, Adjuntar archivos, Leer historial, Gestionar mensajes, Añadir reacciones).
2. Copia `.env.example` a `.env` y rellena `DISCORD_TOKEN`, `GUILD_ID` y `MONGODB_URI`.
   Con `SLASH` y `PREFIX` (true/false) eliges qué tipo de comandos usar; si no los pones, están los dos activados.
3. `npm install` y `npm start`.
4. En el servidor (prefijo por defecto `!`):
   ```
   !config staff add @Staff @Moderador
   !setup
   ```
   `setup` crea la categoría **📬 Modmail** y el canal **#modmail-logs**, privados para el staff.

## Comandos

Todos existen con prefijo (`!reply`) y como slash (`/reply`). Con slash:
- Las respuestas del bot al staff son efímeras (solo las ves tú); lo que va al usuario o al canal se publica igual.
- No se pueden escribir saltos de línea en las opciones: escribe `\n` y se convierte en uno.
- Los archivos se adjuntan con las opciones `archivo`, `archivo2` y `archivo3` de `/reply` y `/areply`.
- `s` y `as` se llaman `/snip` y `/asnip`. `/move`, `/snip` y `/snippet` autocompletan los nombres.
- `/close` tiene las opciones `motivo`, `tiempo`, `silencioso` y `cancelar`.

### Dentro de un ticket
| Comando | Qué hace |
|---|---|
| `reply <msg>` (`r`) | Responde con tu nombre y avatar como autor. |
| `areply <msg>` (`ar`) | Responde de forma anónima (autor = `anonName`). En el canal sí se ve quién lo envió. |
| `s <snippet>` / `as <snippet>` | Envía una respuesta guardada (normal / anónima). |
| `edit <texto>` / `delete` | Edita o borra tu última respuesta. |
| `note <texto>` (`n`) | Nota interna, queda en el transcript. |
| `claim` / `unclaim` | Te haces cargo del ticket (recibes mención con cada mensaje del usuario). |
| `subscribe` / `unsubscribe` | Recibir menciones sin necesidad de reclamar. |
| `move <categoría>` | Mueve el ticket a una categoría registrada (`default` para volver). |
| `close [silent] [motivo]` | Cierra, avisa al usuario (salvo `silent`) y envía el transcript a logs. |
| `close [silent] <duración> [motivo]` | Cierre automático si el usuario no responde: `close 24h`, `close en 2d Resuelto`, `close silent 1h30m`. Se cancela solo si el usuario escribe. |
| `close cancel` | Cancela el cierre automático programado. |

Todos admiten archivos adjuntos y texto con `/`, comillas o saltos de línea: solo se separa el nombre del comando,
el resto se envía tal cual.

### Staff
`help`, `contact <@usuario>`, `tickets`, `block [@usuario] [motivo]`, `unblock`, `blocklist`,
`snippet add|edit|remove|list`.

### Administración (requiere *Gestionar servidor*)
- `setup`
- `config` — ver configuración · `config help` para todas las opciones
- `config prefix <x>` · `config staff add|remove|list` · `config logs <#canal|off>`
- `config category <ID>` · `config ping <@rol|off>`
- `config messages` · `config message <clave> <texto|reset>` — personaliza `greeting`, `greetingTitle`,
  `closing`, `closingTitle`, `autoClose`, `anonName`, `blocked`. Variables: `{user}`, `{username}`, `{server}`
  (y `{time}` en `autoClose`).
- `config color` · `config color <clave> <#hex|reset>` — color de cada tipo de embed: `user`, `staff`, `anon`,
  `note`, `greeting`, `closing`, `blocked`, `info`, `success`, `error`, `system`.
- `category create <nombre> [ID categoría existente] [@roles]` · `category delete <nombre>` · `category list`

Ejemplo: `!category create admin @Administrador` crea una categoría solo visible para ese rol; luego `!move admin` en un ticket.

## Archivos adjuntos

Los archivos se **descargan y se vuelven a subir** (no se mandan solo enlaces, que caducan o mueren al borrar el
mensaje original). Si un archivo supera el límite de subida (10 MB en MD; 10/50/100 MB en el servidor según las
mejoras), se manda como enlace.
