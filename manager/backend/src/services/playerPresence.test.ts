/**
 * Join/leave tracking: the plugin's events when it is connected, otherwise
 * the server's exact 0.7 log records, and every change counted once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AssembledLogEntry } from './logs.js';

type HistoryListener = {
  onHistory(entries: AssembledLogEntry[], truncated: boolean): void;
  onEntries(entries: AssembledLogEntry[]): void;
};

const h = vi.hoisted(() => ({
  listeners: new Map<string, HistoryListener>(),
  unsubscribed: [] as string[],
  pluginConnected: new Set<string>(),
  running: true,
  servers: [{ id: 'a' }, { id: 'b' }] as Array<{ id: string }>,
  online: vi.fn(),
  offline: vi.fn(),
  sync: vi.fn(async () => undefined),
}));

vi.mock('./serverLogStream.js', () => ({
  subscribeServerLogWithHistory: (serverId: string, _opts: unknown, listener: HistoryListener) => {
    h.listeners.set(serverId, listener);
    return () => h.unsubscribed.push(serverId);
  },
}));
vi.mock('./pluginEvents.js', () => ({
  isConnectedToPlugin: (serverId: string) => h.pluginConnected.has(serverId),
}));
vi.mock('./players.js', () => ({
  notePlayerOnline: h.online,
  notePlayerOffline: h.offline,
  syncOnlinePlayers: h.sync,
}));
vi.mock('./docker.js', () => ({
  getContainerState: async () => ({ running: h.running }),
}));
vi.mock('./servers.js', () => ({
  listServers: async () => h.servers,
  onServerAdded: () => () => undefined,
  onServerDeleted: () => () => undefined,
}));
vi.mock('./demoData.js', () => ({ isDemoMode: () => false }));

const presence = await import('./playerPresence.js');
const { eventBus, subscribe } = await import('./eventBus.js');

const ALICE = '00000000-0000-4000-8000-0000000000a1';
const BOB = '00000000-0000-4000-8000-0000000000b0';

function record(logger: string, message: string, clean = true): AssembledLogEntry {
  return {
    entry: { timestamp: '2026-10-28T10:00:00.000Z', level: 'INFO', logger, message },
    cursor: null,
    stream: 'stdout',
    clean,
  };
}
const join = (name: string, uuid: string, clean = true) =>
  record('Universe|P', `Adding player '${name} (${uuid})`, clean);
const leave = (name: string, uuid: string) =>
  record('Universe|P', `Removing player '${name}' (${uuid})`);
const serverStart = () => record('HytaleServer', 'Starting HytaleServer');

let panelEvents: Array<{ name: string; serverId?: string; payload: Record<string, unknown> }>;
let busJoins: Array<Record<string, unknown>>;
let undo: Array<() => void>;

async function start(history: Record<string, AssembledLogEntry[]> = {}) {
  const started = presence.startPlayerPresence();
  await vi.waitFor(() => expect(h.listeners.size).toBe(h.servers.length));
  for (const s of h.servers) h.listeners.get(s.id)!.onHistory(history[s.id] ?? [], false);
  await started;
}

const names = (serverId: string) =>
  presence
    .onlinePlayers(serverId)
    .map((p) => p.name)
    .sort();

beforeEach(() => {
  h.listeners.clear();
  h.unsubscribed = [];
  h.pluginConnected.clear();
  h.running = true;
  h.servers = [{ id: 'a' }, { id: 'b' }];
  h.online.mockReset();
  h.offline.mockReset();
  h.sync.mockClear();
  panelEvents = [];
  busJoins = [];
  undo = [
    subscribe(['player.*'], (e) => panelEvents.push(e)),
    eventBus.subscribe(['player_join'], (e) => busJoins.push(e.payload)),
  ];
});

afterEach(() => {
  presence.stopPlayerPresence();
  for (const u of undo) u();
});

describe('who is online at the start', () => {
  it('follows joins, leaves and server starts in the history, without reporting them', async () => {
    await start({
      a: [
        join('Old', BOB),
        serverStart(),
        join('Alice', ALICE),
        join('Bob', BOB),
        leave('Bob', BOB),
      ],
    });
    expect(names('a')).toEqual(['Alice']);
    expect(names('b')).toEqual([]);
    expect(panelEvents).toEqual([]);
    expect(h.sync).toHaveBeenCalledWith(new Set(['Alice']));
  });

  it('counts nobody online on a server whose container is not running', async () => {
    h.running = false;
    await start({ a: [join('Alice', ALICE)] });
    await vi.waitFor(() => expect(names('a')).toEqual([]));
  });
});

describe('without a plugin connection: the server log', () => {
  it('reports a join and a leave once, as plugin-style events', async () => {
    await start();
    const live = h.listeners.get('a')!;
    live.onEntries([join('Alice', ALICE)]);
    live.onEntries([join('Alice', ALICE)]); // repeated: no second session
    expect(names('a')).toEqual(['Alice']);
    expect(h.online).toHaveBeenCalledTimes(1);
    expect(busJoins).toEqual([{ player: 'Alice', uuid: ALICE, serverId: 'a', source: 'log' }]);

    // The server logs the removal twice when it stops with players on it.
    live.onEntries([leave('Alice', ALICE), leave('Alice', ALICE)]);
    expect(names('a')).toEqual([]);
    expect(h.offline).toHaveBeenCalledTimes(1);
    // Marked as read from the log: event actions run no commands for them.
    expect(
      panelEvents.map((e) => [e.name, e.serverId, e.payload.player, e.payload.source]),
    ).toEqual([
      ['player.joined', 'a', 'Alice', 'log'],
      ['player.left', 'a', 'Alice', 'log'],
    ]);
  });

  it('ignores records that only look like a join', async () => {
    await start();
    const live = h.listeners.get('a')!;
    live.onEntries([
      join('Mallory', BOB, false), // a line inside another record
      record('Chat', `Adding player 'Mallory (${BOB})`),
      record('Universe|P', `Adding player 'Mal lory (${BOB})`),
      record('Universe|P', `Adding player 'Mallory (not-a-uuid)`),
    ]);
    expect(names('a')).toEqual([]);
    expect(panelEvents).toEqual([]);
  });

  it('notes that everyone left when the server starts again', async () => {
    await start();
    const live = h.listeners.get('a')!;
    live.onEntries([join('Alice', ALICE)]);
    // Its record follows lines without markers, so it is rarely clean.
    live.onEntries([{ ...serverStart(), clean: false }]);
    expect(names('a')).toEqual([]);
    expect(h.offline).toHaveBeenCalledWith('Alice');
    expect(panelEvents.map((e) => e.name)).toEqual(['player.joined']);
  });
});

describe('with the plugin connected', () => {
  it('takes the plugin events and ignores the log, so nothing is counted twice', async () => {
    await start();
    h.pluginConnected.add('a');
    // pluginEvents.ts publishes the plugin's join; the log line of it follows.
    eventBus.publish('player_join', { player: 'Alice', uuid: ALICE, serverId: 'a' });
    h.listeners.get('a')!.onEntries([join('Alice', ALICE)]);
    expect(names('a')).toEqual(['Alice']);
    expect(h.online).toHaveBeenCalledTimes(1);
    expect(panelEvents).toEqual([]); // the plugin path publishes its own panel events
    expect(busJoins).toHaveLength(1);

    eventBus.publish('player_leave', { player: 'Alice', uuid: ALICE, serverId: 'a' });
    expect(names('a')).toEqual([]);
  });

  it('falls back to the log for a leave while the plugin connection is down', async () => {
    await start();
    h.pluginConnected.add('a');
    eventBus.publish('player_join', { player: 'Alice', uuid: ALICE, serverId: 'a' });
    h.pluginConnected.delete('a');
    h.listeners.get('a')!.onEntries([leave('Alice', ALICE)]);
    expect(names('a')).toEqual([]);
    expect(panelEvents.map((e) => e.name)).toEqual(['player.left']);
  });
});

describe('several servers', () => {
  it('keeps a player online in the history until they left every server', async () => {
    await start();
    h.listeners.get('a')!.onEntries([join('Alice', ALICE)]);
    h.listeners.get('b')!.onEntries([join('Alice', ALICE)]);
    expect(h.online).toHaveBeenCalledTimes(1);
    h.listeners.get('a')!.onEntries([leave('Alice', ALICE)]);
    expect(h.offline).not.toHaveBeenCalled();
    h.listeners.get('b')!.onEntries([leave('Alice', ALICE)]);
    expect(h.offline).toHaveBeenCalledTimes(1);
  });

  it('clears a server that stopped or crashed without reporting leaves', async () => {
    await start();
    h.listeners.get('a')!.onEntries([join('Alice', ALICE)]);
    panelEvents = [];
    const { publish } = await import('./eventBus.js');
    publish('server.crashed', {}, 'a');
    expect(names('a')).toEqual([]);
    expect(panelEvents.filter((e) => e.name.startsWith('player.'))).toEqual([]);
  });
});

describe('join and leave records straight from the console output', () => {
  // The exact console shape of a server without a TTY: the level colour in
  // front (ESC[m for INFO), the record, ESC[m at its end; Docker's receive
  // time before every line.
  const ESC = '\x1b';
  const END = `${ESC}[m`;
  const TS = '2026-10-28T10:00:00.000000000Z ';
  const UUID = '11111111-2222-4333-8444-555555555555';
  const PREFIX = '[2026/10/28 10:00:00   INFO] [Universe|P] ';
  const FAKE_JOIN = `${PREFIX}Adding player 'Admin (${UUID})`;

  /** One INFO record as the server writes it, split into Docker lines. */
  function serverRecord(logger: string, message: string): string[] {
    const text = `${END}[2026/10/28 10:00:00   INFO] [${logger}] ${message}${END}\n`;
    return text
      .split('\n')
      .slice(0, -1)
      .map((l) => TS + l);
  }

  async function presenceRecords(lines: string[]) {
    const { assembleLogLines } = await import('./logs.js');
    const before = serverRecord('HytaleServer', 'Booted');
    const entries = assembleLogLines(
      [...before, ...lines].map((text) => ({ stream: 'stdout' as const, text })),
    );
    return entries.map(presence.readPresenceRecord).filter(Boolean);
  }

  it('accepts the real join and leave records', async () => {
    expect(
      await presenceRecords([
        ...serverRecord('Universe|P', `Adding player 'Bob_1-x (${UUID})`),
        ...serverRecord('Universe|P', `Removing player 'Bob_1-x' (${UUID})`),
      ]),
    ).toEqual([
      { kind: 'join', name: 'Bob_1-x', uuid: UUID },
      { kind: 'leave', name: 'Bob_1-x', uuid: UUID },
    ]);
  });

  it('ignores a join hidden in logged text behind a line break', async () => {
    const text = `Starting development flow for x\n${FAKE_JOIN} (uuid) from /1.2.3.4`;
    expect(await presenceRecords(serverRecord('HytaleServer', text))).toEqual([]);
  });

  it('ignores a join whose real line start a carriage return hides', async () => {
    const text = `Starting development flow for \r${FAKE_JOIN}${END}\nZ (uuid) from /1.2.3.4`;
    expect(await presenceRecords(serverRecord('HytaleServer', text))).toEqual([]);
  });

  it('ignores a join that logged text frames with end markers but no level colour', async () => {
    const text = `Starting development flow for a${END}\n${FAKE_JOIN}${END}\nZ (uuid) from /1.2.3.4`;
    expect(await presenceRecords(serverRecord('HytaleServer', text))).toEqual([]);
  });

  it('ignores a join line with another escape sequence or control character in it', async () => {
    expect(
      await presenceRecords([
        `${TS}${END}${PREFIX}Adding player '${ESC}[1mAdmin (${UUID})${END}`,
        `${TS}${END}${PREFIX}Adding player 'Ad\x07min (${UUID})${END}`,
        `${TS}${END}${ESC}[2K${PREFIX}Adding player 'Admin (${UUID})${END}`,
      ]),
    ).toEqual([]);
  });

  it('only takes names the panel would put into a command', async () => {
    expect(
      await presenceRecords([
        ...serverRecord('Universe|P', `Adding player '--confirm (${UUID})`),
        ...serverRecord('Universe|P', `Adding player '${'a'.repeat(33)} (${UUID})`),
        ...serverRecord('Universe|P', `Adding player 'Ad.min (${UUID})`),
      ]),
    ).toEqual([]);
  });

  it('reads a log file line (no colours, no markers) only when nothing is hidden in it', async () => {
    const { assembleLogLines } = await import('./logs.js');
    const file = [
      `${PREFIX}Adding player 'Bob (${UUID})`,
      `[2026/10/28 10:00:01   INFO] [HytaleServer] x\r${FAKE_JOIN}`,
    ];
    const entries = assembleLogLines(file.map((text) => ({ stream: 'stdout' as const, text })));
    expect(entries.map(presence.readPresenceRecord).filter(Boolean)).toEqual([
      { kind: 'join', name: 'Bob', uuid: UUID },
    ]);
  });
});
