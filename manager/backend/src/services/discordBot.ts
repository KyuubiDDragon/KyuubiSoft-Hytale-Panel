/**
 * Discord bot — optional chat bridge + slash commands.
 *
 * OFF by default. Enabled via config.discord { enabled, token, channelId }.
 * Provides:
 *   - in-game chat → Discord (mirrors player_chat events to the channel)
 *   - Discord → in-game chat (messages in the channel become /say broadcasts)
 *   - /status and /players slash commands
 *
 * Everything is wrapped defensively: a Discord outage or bad token must never
 * take down the panel. `discord.js` is only imported when the bot is enabled,
 * so installs that never use it don't pay the startup cost.
 */
import { logger } from '../utils/logger.js';
import { eventBus, type PanelEvent } from './eventBus.js';
import { getConfig } from './configService.js';
import { isDemoMode } from './demoData.js';

// Loose typing for the lazily-imported discord.js client so the rest of the
// codebase doesn't hard-depend on the types at module load.
type AnyClient = {
  login: (token: string) => Promise<string>;
  destroy: () => Promise<void> | void;
  once: (event: string, cb: (...args: unknown[]) => void) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  channels: { fetch: (id: string) => Promise<unknown> };
  user: { id: string; tag?: string } | null;
  application: { id: string } | null;
};

let client: AnyClient | null = null;
let unsubscribeChat: (() => void) | null = null;
let running = false;

async function sendToChannel(channelId: string, content: string): Promise<void> {
  if (!client) return;
  try {
    const ch = await client.channels.fetch(channelId) as { isTextBased?: () => boolean; send?: (c: string) => Promise<unknown> } | null;
    if (ch && typeof ch.isTextBased === 'function' && ch.isTextBased() && typeof ch.send === 'function') {
      await ch.send(content.slice(0, 1900));
    }
  } catch (err) {
    logger.warn(`[Discord] send failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function startDiscordBot(): Promise<void> {
  if (running || isDemoMode()) return;

  let cfg: Awaited<ReturnType<typeof getConfig>> | null = null;
  try { cfg = await getConfig(); } catch { /* config not ready */ }
  const d = cfg?.discord;
  if (!d?.enabled || !d.token || !d.channelId) {
    logger.info('[Discord] bot disabled (set config.discord.enabled + token + channelId to enable)');
    return;
  }

  let discord: typeof import('discord.js');
  try {
    discord = await import('discord.js');
  } catch (err) {
    logger.error('[Discord] discord.js not installed:', err);
    return;
  }
  const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = discord;

  const c = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client = c as unknown as AnyClient;
  running = true;

  c.once(Events.ClientReady, async (ready) => {
    logger.info(`[Discord] logged in as ${ready.user.tag}`);
    // Register slash commands (guild-scoped if a guildId is set = instant).
    try {
      const rest = new REST({ version: '10' }).setToken(d.token);
      const body = [
        new SlashCommandBuilder().setName('status').setDescription('Show the Hytale server status').toJSON(),
        new SlashCommandBuilder().setName('players').setDescription('List online players').toJSON(),
      ];
      if (d.guildId) {
        await rest.put(Routes.applicationGuildCommands(ready.user.id, d.guildId), { body });
      } else {
        await rest.put(Routes.applicationCommands(ready.user.id), { body });
      }
    } catch (err) {
      logger.warn(`[Discord] slash command registration failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  // In-game chat → Discord
  unsubscribeChat = eventBus.subscribe(['player_chat'], (evt: PanelEvent) => {
    const p = evt.payload as { player?: string; message?: string };
    if (p.player && p.message) void sendToChannel(d.channelId, `**${p.player}**: ${p.message}`);
  });

  // Discord → in-game chat
  c.on(Events.MessageCreate, async (msg) => {
    try {
      if (msg.author.bot || msg.channelId !== d.channelId || !msg.content) return;
      const { execCommand } = await import('./docker.js');
      const safe = msg.content.replace(/[\r\n]+/g, ' ').slice(0, 200);
      await execCommand(`/say [Discord] ${msg.author.username}: ${safe}`);
    } catch (err) {
      logger.warn(`[Discord] relay-to-game failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  // Slash commands
  c.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === 'status') {
        const { getStatus } = await import('./docker.js');
        const status = await getStatus();
        let line = status.running ? '🟢 Server is **online**' : '🔴 Server is **offline**';
        if (status.running) {
          try {
            const kyuubi = await import('./kyuubiApi.js');
            const info = await kyuubi.getServerInfoFromPlugin();
            const data = info.success ? info.data as { playerCount?: number; version?: string } : undefined;
            if (data) line += ` — ${data.playerCount ?? 0} players${data.version ? ` · v${data.version}` : ''}`;
          } catch { /* plugin not available */ }
        }
        await interaction.reply({ content: line, ephemeral: true });
      } else if (interaction.commandName === 'players') {
        const players = await import('./players.js');
        const list = await players.getOnlinePlayers();
        await interaction.reply({
          content: list.length ? `Online (${list.length}): ${list.map(p => p.name).join(', ')}` : 'No players online.',
          ephemeral: true,
        });
      }
    } catch (err) {
      logger.warn(`[Discord] interaction failed: ${err instanceof Error ? err.message : err}`);
      try { if (!interaction.replied) await interaction.reply({ content: 'Error handling command.', ephemeral: true }); } catch { /* ignore */ }
    }
  });

  c.on(Events.Error, (err) => logger.warn(`[Discord] client error: ${err instanceof Error ? err.message : err}`));

  try {
    await c.login(d.token);
  } catch (err) {
    logger.error(`[Discord] login failed: ${err instanceof Error ? err.message : err}`);
    await stopDiscordBot();
  }
}

export async function stopDiscordBot(): Promise<void> {
  if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
  if (client) {
    try { await client.destroy(); } catch { /* ignore */ }
    client = null;
  }
  running = false;
}

/** Whether the bot is currently connected. */
export function isDiscordRunning(): boolean {
  return running;
}

/** Apply config changes live: tear down the current bot and re-read config. */
export async function restartDiscordBot(): Promise<void> {
  await stopDiscordBot();
  await startDiscordBot();
}
