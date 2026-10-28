/**
 * Who is online on which server, and the join/leave events for it.
 *
 * Sources, best first:
 *  - the KyuubiSoft API plugin's player_join / player_leave events, which
 *    services/pluginEvents.ts already publishes on the event bus;
 *  - while a server has no plugin connection, the server's own log records
 *    for a player entering and leaving the universe. They are read from the
 *    shared log stream (services/serverLogStream.ts) all the time, not only
 *    while someone has the console open, and published like the plugin's.
 *
 * A player is online once per server: the join of someone already online or
 * the leave of someone already gone changes nothing and is not reported again
 * (the server logs the removal twice when it stops with players on it). Both
 * sources never report the same change: log records only count while the
 * plugin is not connected.
 *
 * Only these exact records count, one line each, logged at INFO by the
 * universe, with the time and the logger at the very start of the line:
 *   Adding player '<name> (<uuid>)
 *   Removing player '<name>' (<uuid>)
 * The name has the form the panel puts into commands (utils/sanitize.ts). A
 * record that only looks like one (a line inside another record's message,
 * or a line whose visible start a carriage return or an escape sequence
 * moved, see AssembledLogEntry.clean) is ignored. Logged text that copies the
 * whole console form of a record, escape bytes and line break included, can
 * still pass. Chat and commands from players do not carry such characters,
 * so that needs a mod that logs text from clients as it is.
 */
import { eventBus, publish as publishPanelEvent, subscribe } from './eventBus.js';
import { getContainerState } from './docker.js';
import { isConnectedToPlugin } from './pluginEvents.js';
import { notePlayerOffline, notePlayerOnline, syncOnlinePlayers } from './players.js';
import { listServers, onServerAdded, onServerDeleted } from './servers.js';
import { subscribeServerLogWithHistory } from './serverLogStream.js';
import { isDemoMode } from './demoData.js';
import type { AssembledLogEntry } from './logs.js';
import { PLAYER_NAME_SOURCE } from '../utils/sanitize.js';

const UNIVERSE_LOGGER = 'Universe|P';
const PLAYER_NAME = `(${PLAYER_NAME_SOURCE})`;
const PLAYER_UUID = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
const JOIN_RECORD = new RegExp(`^Adding player '${PLAYER_NAME} \\(${PLAYER_UUID}\\)$`);
const LEAVE_RECORD = new RegExp(`^Removing player '${PLAYER_NAME}' \\(${PLAYER_UUID}\\)$`);
// The first record of every server run; nobody is online before it.
const SERVER_START = { logger: 'HytaleServer', message: 'Starting HytaleServer' };

// Read once per server when watching starts, to know who is online already.
const HISTORY = { tail: 5_000, maxBytes: 4 * 1024 * 1024, maxEntries: 5_000 };

export type PresenceSource = 'plugin' | 'log';

export interface OnlinePlayer {
  name: string;
  uuid: string;
  /** ISO time the panel saw the join (or the panel start for earlier joins). */
  since: string;
}

export interface PresenceChange {
  serverId: string;
  event: 'join' | 'leave';
  player: string;
  uuid: string;
  source: PresenceSource;
  timestamp: string;
}

type PresenceRecord =
  { kind: 'join' | 'leave'; name: string; uuid: string } | { kind: 'server_start' };

/** The join, leave or server start a log entry stands for, if any. */
export function readPresenceRecord(e: AssembledLogEntry): PresenceRecord | null {
  const { logger, message } = e.entry;
  // The start often follows lines without markers, so its record is rarely
  // clean; a false one could only make the panel forget who is online.
  if (logger === SERVER_START.logger && message === SERVER_START.message) {
    return { kind: 'server_start' };
  }
  if (!e.clean || logger !== UNIVERSE_LOGGER || e.entry.level !== 'INFO') return null;
  const join = JOIN_RECORD.exec(message);
  if (join) return { kind: 'join', name: join[1], uuid: join[2].toLowerCase() };
  const leave = LEAVE_RECORD.exec(message);
  if (leave) return { kind: 'leave', name: leave[1], uuid: leave[2].toLowerCase() };
  return null;
}

interface ServerPresence {
  online: Map<string, OnlinePlayer>;
  unsubscribe: () => void;
  /** Settles watch(); also when the server is removed before its history came. */
  ready: () => void;
}

const servers = new Map<string, ServerPresence>();
const listeners = new Set<(change: PresenceChange) => void>();
const teardown: Array<() => void> = [];
let started = false;

/** Players online on a server, as far as the panel knows. */
export function onlinePlayers(serverId: string): OnlinePlayer[] {
  return [...(servers.get(serverId)?.online.values() ?? [])];
}

/** Whether the panel follows this server's joins and leaves (false before the start, in demo mode). */
export function isWatching(serverId: string): boolean {
  return servers.has(serverId);
}

/** Called for every join and leave on any server. Returns the unsubscribe function. */
export function onPresenceChange(listener: (change: PresenceChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Applies a join or leave. Returns false when it changes nothing (the player
 * was online already, or was not).
 */
function apply(
  serverId: string,
  kind: 'join' | 'leave',
  name: string,
  uuid: string,
  source: PresenceSource,
): boolean {
  const presence = servers.get(serverId);
  if (!presence) return false;
  const key = uuid.toLowerCase();
  const timestamp = new Date().toISOString();
  // Each server keeps its own player list (sessions and playtime per server).
  if (kind === 'join') {
    if (presence.online.has(key)) return false;
    presence.online.set(key, { name, uuid: key, since: timestamp });
    notePlayerOnline(serverId, name, { uuid: key });
  } else {
    if (!presence.online.delete(key)) return false;
    notePlayerOffline(serverId, name);
  }
  const change: PresenceChange = {
    serverId,
    event: kind,
    player: name,
    uuid: key,
    source,
    timestamp,
  };
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (err) {
      console.error('[Presence] listener failed:', err);
    }
  }
  return true;
}

/** Everyone on a server is gone (a new server run, a stop or a crash); reported to nobody. */
function clearServer(serverId: string): void {
  const presence = servers.get(serverId);
  if (!presence) return;
  const gone = [...presence.online.values()];
  presence.online.clear();
  for (const player of gone) notePlayerOffline(serverId, player.name);
}

function onLogEntries(serverId: string, entries: AssembledLogEntry[]): void {
  for (const e of entries) {
    const record = readPresenceRecord(e);
    if (!record) continue;
    if (record.kind === 'server_start') {
      clearServer(serverId);
      continue;
    }
    // With the plugin connected its events are the source; see onPluginSignal.
    if (isConnectedToPlugin(serverId)) continue;
    if (!apply(serverId, record.kind, record.name, record.uuid, 'log')) continue;
    const payload = { player: record.name, uuid: record.uuid, serverId, source: 'log' };
    eventBus.publish(record.kind === 'join' ? 'player_join' : 'player_leave', payload);
    // `source: 'log'` tells consumers the change was read from the log, not
    // reported by the plugin; event actions run no commands for it.
    publishPanelEvent(
      record.kind === 'join' ? 'player.joined' : 'player.left',
      { player: record.name, uuid: record.uuid, source: 'log' },
      serverId,
    );
  }
}

/**
 * Who was online when watching started, from the end of the log. Reports
 * nothing. Runs before the live entries that arrived while it was read.
 */
function onHistory(serverId: string, entries: AssembledLogEntry[]): Promise<void> {
  const presence = servers.get(serverId);
  if (!presence) return Promise.resolve();
  const online = new Map<string, OnlinePlayer>();
  const since = new Date().toISOString();
  for (const e of entries) {
    const record = readPresenceRecord(e);
    if (!record) continue;
    if (record.kind === 'server_start') online.clear();
    else if (record.kind === 'join') {
      online.set(record.uuid, { name: record.name, uuid: record.uuid, since });
    } else online.delete(record.uuid);
  }
  // Joins the plugin reported meanwhile are kept.
  for (const [uuid, player] of online) {
    if (!presence.online.has(uuid)) presence.online.set(uuid, player);
  }
  // A crashed server leaves no removals behind.
  return getContainerState(serverId)
    .catch(() => null)
    .then((state) => {
      if (servers.get(serverId) === presence && state && !state.running) clearServer(serverId);
    });
}

function watch(serverId: string): Promise<void> {
  if (servers.has(serverId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const presence: ServerPresence = {
      online: new Map(),
      unsubscribe: () => undefined,
      ready: resolve,
    };
    servers.set(serverId, presence);
    presence.unsubscribe = subscribeServerLogWithHistory(serverId, HISTORY, {
      onHistory: (entries) => {
        onHistory(serverId, entries)
          .catch((err) => console.error(`[Presence:${serverId}] history failed:`, err))
          .finally(resolve);
      },
      onEntries: (entries) => onLogEntries(serverId, entries),
    });
  });
}

function unwatch(serverId: string): void {
  const presence = servers.get(serverId);
  if (!presence) return;
  clearServer(serverId);
  presence.unsubscribe();
  servers.delete(serverId);
  presence.ready();
}

interface JoinLeavePayload {
  player?: unknown;
  uuid?: unknown;
  serverId?: unknown;
  source?: unknown;
}

function onPluginSignal(kind: 'join' | 'leave', payload: JoinLeavePayload): void {
  // The log path publishes its own events on the same bus.
  if (payload.source === 'log') return;
  const { player, uuid, serverId } = payload;
  if (typeof player !== 'string' || typeof uuid !== 'string' || typeof serverId !== 'string') {
    return;
  }
  apply(serverId, kind, player, uuid, 'plugin');
}

/**
 * Starts watching every registered server (and the ones added later). The
 * returned promise settles once each server's history has been read.
 */
export async function startPlayerPresence(): Promise<void> {
  if (started || isDemoMode()) return;
  started = true;
  teardown.push(
    eventBus.subscribe(['player_join'], (evt) => {
      try {
        onPluginSignal('join', evt.payload);
      } catch (err) {
        console.error('[Presence] join failed:', err);
      }
    }),
    eventBus.subscribe(['player_leave'], (evt) => {
      try {
        onPluginSignal('leave', evt.payload);
      } catch (err) {
        console.error('[Presence] leave failed:', err);
      }
    }),
    subscribe(['server.stopped', 'server.crashed'], (evt) => {
      if (evt.serverId) clearServer(evt.serverId);
    }),
    onServerAdded((server) => void watch(server.id)),
    onServerDeleted((serverId) => unwatch(serverId)),
  );
  const list = await listServers().catch((err) => {
    console.error('[Presence] could not list the servers:', err);
    return [];
  });
  await Promise.all(list.map((s) => watch(s.id)));
  await Promise.all(
    [...servers.entries()].map(([serverId, presence]) =>
      syncOnlinePlayers(serverId, new Set([...presence.online.values()].map((p) => p.name))).catch(
        (err) => console.error(`[Presence:${serverId}] could not sync the player list:`, err),
      ),
    ),
  );
}

/** Stops watching (panel shutdown, tests). Who is online stays as it is in each players.json. */
export function stopPlayerPresence(): void {
  for (const undo of teardown.splice(0)) undo();
  for (const presence of servers.values()) {
    presence.unsubscribe();
    presence.ready();
  }
  servers.clear();
  listeners.clear();
  started = false;
}
