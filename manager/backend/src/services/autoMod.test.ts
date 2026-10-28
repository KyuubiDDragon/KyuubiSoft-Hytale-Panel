/**
 * Auto-moderation with Hytale 0.7 commands: a kick carries no reason (the
 * reason is only recorded), a "mute" setting warns instead (0.7 has no mute),
 * the warning text cannot break the command, and a command the server
 * refuses records no punishment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Exec = { success: boolean; error?: string };
const h = vi.hoisted(() => ({
  execCommand: vi.fn(async (_command: string): Promise<Exec> => ({ success: true })),
  recordPunishment: vi.fn(),
  config: {
    enabled: true,
    bannedWords: ['badword'],
    blockLinks: false,
    maxCapsPercent: 0,
    maxMessageLength: 0,
    floodCount: 0,
    floodWindowSec: 0,
    action: 'kick' as 'warn' | 'mute' | 'kick',
    muteDurationSec: 0,
  },
}));

vi.mock('./docker.js', () => ({ execCommand: h.execCommand }));
vi.mock('./punishments.js', () => ({ recordPunishment: h.recordPunishment }));
vi.mock('./activityLog.js', () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock('./demoData.js', () => ({ isDemoMode: () => false }));
vi.mock('./configService.js', () => ({ getConfig: async () => ({ automod: h.config }) }));

const { eventBus } = await import('./eventBus.js');
const { startAutoMod, stopAutoMod } = await import('./autoMod.js');

async function chat(player: string, message: string): Promise<void> {
  eventBus.publish('player_chat', { player, message });
  // The handler is async; let it run to the end.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  h.execCommand.mockReset();
  h.execCommand.mockImplementation(async () => ({ success: true }));
  h.recordPunishment.mockClear();
  startAutoMod();
});

afterEach(() => stopAutoMod());

describe('autoMod with Hytale 0.7', () => {
  it('kicks without a reason and records the reason in the panel', async () => {
    h.config.action = 'kick';
    await chat('Steve', 'this is a badword');
    expect(h.execCommand.mock.calls.map(([c]) => c)).toEqual(['/kick Steve']);
    expect(h.recordPunishment).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kick', reason: 'AutoMod: banned word "badword"' }),
    );
  });

  it('warns instead of muting, and records no mute', async () => {
    h.config.action = 'mute';
    await chat('Steve', 'badword');
    const [command] = h.execCommand.mock.calls.map(([c]) => c);
    expect(command).toMatch(/^\/say \[AutoMod\] Steve, please mind the chat rules \(/);
    // The quotes of the detail would be an unbalanced quote for the parser.
    expect(command).not.toContain('"');
    expect(h.recordPunishment).toHaveBeenCalledWith(expect.objectContaining({ type: 'warn' }));
    expect(h.recordPunishment).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.stringMatching(/mute/) }),
    );
  });

  it('records nothing when the server refuses the command', async () => {
    h.config.action = 'kick';
    h.execCommand.mockImplementation(async () => ({
      success: false,
      error: 'No such player "Steve".',
    }));
    await chat('Steve', 'badword');
    expect(h.recordPunishment).not.toHaveBeenCalled();
  });
});
