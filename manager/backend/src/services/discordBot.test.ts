/**
 * The Discord bridge posts what players write in the game. A chat line with
 * @everyone, @here or a <@id> mention must reach the channel as text and must
 * not ping anyone.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';

const { clientOptions, sent } = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  sent: [] as unknown[],
}));

vi.mock('discord.js', () => {
  class Client {
    channels = {
      fetch: async () => ({ isTextBased: () => true, send: async (m: unknown) => sent.push(m) }),
    };
    user = null;
    application = null;
    constructor(options: unknown) {
      clientOptions.push(options);
    }
    once() {}
    on() {}
    async login() {
      return 'token';
    }
    async destroy() {}
  }
  return {
    Client,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 3 },
    Events: { ClientReady: 'ready', MessageCreate: 'm', InteractionCreate: 'i', Error: 'e' },
    REST: class {},
    Routes: {},
    SlashCommandBuilder: class {},
  };
});
vi.mock('./configService.js', () => ({
  getConfig: async () => ({ discord: { enabled: true, token: 't', channelId: 'c1' } }),
}));
vi.mock('./demoData.js', () => ({ isDemoMode: () => false }));
vi.mock('./servers.js', () => ({ resolveServerId: async () => 'default' }));
vi.mock('./perServerData.js', () => ({ serverDisplayName: async () => 'Survival' }));

const bot = await import('./discordBot.js');
const { eventBus } = await import('./eventBus.js');

afterAll(async () => {
  await bot.stopDiscordBot();
});

describe('Discord chat bridge', () => {
  it('relays game chat without allowing mentions', async () => {
    await bot.startDiscordBot();
    expect(clientOptions[0]).toMatchObject({ allowedMentions: { parse: [] } });

    eventBus.publish('player_chat', {
      player: 'Steve',
      message: '@everyone free diamonds <@123456789>',
      serverId: 'default',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toEqual({
      content: '**Steve**: @everyone free diamonds <@123456789>',
      allowedMentions: { parse: [] },
    });
  });
});
