/**
 * Player data export + erasure (GDPR / DSGVO subject requests).
 *
 * Aggregates everything the panel stores about one player into a single JSON
 * document (Art. 15 / 20 — access & portability), and can erase that data
 * (Art. 17 — right to be forgotten).
 *
 * Sources:
 *   - player_notes      (SQLite)  staff notes
 *   - punishments       (SQLite)  bans/kicks/mutes/warns
 *   - play_sessions     (SQLite)  join/leave sessions + totals
 *   - per-player chat    (files)   chat history + death positions
 *
 * The on-disk Hytale player save file (inventory/stats) is the GAME's data, not
 * the panel's, so it is referenced but not deleted here — removing it would
 * corrupt the world. Operators delete it via the game if required.
 *
 * Both work on one server (the one the request is for), or on every server
 * when the caller passes `null`; the route only does that for accounts with
 * access to every server. A player is matched by name and by the UUIDs that
 * name has on that server, so the records of a renamed player are included,
 * another server's records never are. An earlier name that another player
 * (another UUID) used too only brings in rows with the player's own UUIDs.
 *
 * Erasure also removes the player's lines from the server's daily chat logs.
 * It keeps the audit and activity logs (records of what staff did, the
 * erasure included) and recorded replays, which expire with their retention.
 */
import { getDb } from '../db/index.js';
import { getNote, type PlayerNote } from './playerNotes.js';
import { getPunishment, type Punishment } from './punishments.js';
import {
  getPlayerChatHistory,
  deletePlayerChatData,
  deletePlayerGlobalChatLines,
  type ChatLineFilter,
  type ChatMessage,
} from './chatLog.js';
import { isDemoMode } from './demoData.js';

export interface PlayerSessionRow {
  player_name: string;
  uuid: string | null;
  joined_at: string;
  left_at: string | null;
  duration_ms: number | null;
  server_id: string | null;
}

export interface PlayerDataExport {
  player: string;
  generatedAt: string;
  notes: PlayerNote[];
  punishments: Punishment[];
  playSessions: PlayerSessionRow[];
  playtimeSummary: { totalSessions: number; totalMs: number };
  chat: ChatMessage[];
  uuids: string[];
}

/** One server's id, or `null` for every server. */
export type PlayerDataScope = string | null;

const PLAYER_TABLES = ['play_sessions', 'punishments', 'player_notes'] as const;
const MAX_ROWS = 100_000;

interface PlayerIdentity {
  /** The requested name and earlier names only this player used: every row. */
  names: string[];
  /** Earlier names another player used too: only rows with one of `uuids`. */
  sharedNames: string[];
  uuids: string[];
}

/** Rows of a query on a table that may not exist yet (fresh database): none then. */
function rowsOf<T>(sql: string, params: unknown[]): T[] {
  try {
    return getDb()
      .prepare(sql)
      .all(...params) as T[];
  } catch {
    return [];
  }
}

/** Rows changed by a statement on a table that may not exist yet: none then. */
function changedRows(sql: string, params: unknown[]): number {
  try {
    return getDb()
      .prepare(sql)
      .run(...params).changes;
  } catch {
    return 0;
  }
}

const placeholders = (values: unknown[]) => values.map(() => '?').join(', ');

/** WHERE condition for the rows of `identity` on `scope`. */
function matchPlayer(identity: PlayerIdentity, scope: PlayerDataScope) {
  const who: string[] = [];
  const params: unknown[] = [];
  if (identity.names.length > 0) {
    who.push(`player_name IN (${placeholders(identity.names)})`);
    params.push(...identity.names);
  }
  if (identity.uuids.length > 0) {
    who.push(`uuid IN (${placeholders(identity.uuids)})`);
    params.push(...identity.uuids);
  }
  let sql = who.length > 0 ? `(${who.join(' OR ')})` : '0';
  if (scope !== null) {
    sql += ' AND server_id = ?';
    params.push(scope);
  }
  return { sql, params };
}

/** Whether rows on `scope` carry `name` with a UUID that is not one of `uuids`. */
function usedByAnother(name: string, uuids: string[], scope: PlayerDataScope): boolean {
  let sql = `player_name = ? AND uuid IS NOT NULL AND uuid NOT IN (${placeholders(uuids)})`;
  const params: unknown[] = [name, ...uuids];
  if (scope !== null) {
    sql += ' AND server_id = ?';
    params.push(scope);
  }
  return PLAYER_TABLES.some(
    (table) => rowsOf(`SELECT 1 FROM ${table} WHERE ${sql} LIMIT 1`, params).length > 0,
  );
}

/**
 * The UUIDs the name has on `scope`, and every name recorded there under one
 * of those UUIDs; an earlier name that rows of another UUID carry too is a
 * shared one.
 */
function resolveIdentity(playerName: string, scope: PlayerDataScope): PlayerIdentity {
  const byName = matchPlayer({ names: [playerName], sharedNames: [], uuids: [] }, scope);
  const uuids = new Set<string>();
  for (const table of PLAYER_TABLES) {
    const rows = rowsOf<{ uuid: string }>(
      `SELECT DISTINCT uuid FROM ${table} WHERE ${byName.sql} AND uuid IS NOT NULL`,
      byName.params,
    );
    for (const row of rows) uuids.add(row.uuid);
  }
  const aliases = new Set<string>();
  if (uuids.size > 0) {
    const byUuid = matchPlayer({ names: [], sharedNames: [], uuids: [...uuids] }, scope);
    for (const table of PLAYER_TABLES) {
      const rows = rowsOf<{ player_name: string }>(
        `SELECT DISTINCT player_name FROM ${table} WHERE ${byUuid.sql}`,
        byUuid.params,
      );
      for (const row of rows) if (row.player_name !== playerName) aliases.add(row.player_name);
    }
  }
  const names = [playerName];
  const sharedNames: string[] = [];
  for (const alias of aliases) {
    (usedByAnother(alias, [...uuids], scope) ? sharedNames : names).push(alias);
  }
  return { names, sharedNames, uuids: [...uuids] };
}

const chatName = (name: string) => name.toLowerCase();

/**
 * The chat lines of `identity` under `name`: all under the requested name,
 * under an earlier name the lines without a UUID or with one of the player's
 * (only the latter for a shared name).
 */
function linesUnder(identity: PlayerIdentity, name: string): ChatLineFilter | undefined {
  if (name === identity.names[0]) return undefined;
  const shared = identity.sharedNames.includes(name);
  return (m) => (m.uuid ? identity.uuids.includes(m.uuid) : !shared);
}

/** The lines of `identity` in a server's daily chat log. */
function linesOf(identity: PlayerIdentity): ChatLineFilter {
  const requested = chatName(identity.names[0]);
  const earlier = new Set(identity.names.slice(1).map(chatName));
  return (m) => {
    const name = chatName(m.player);
    if (name === requested) return true;
    if (m.uuid) return identity.uuids.includes(m.uuid);
    return earlier.has(name);
  };
}

function rowIds(table: string, identity: PlayerIdentity, scope: PlayerDataScope): number[] {
  const match = matchPlayer(identity, scope);
  return rowsOf<{ id: number }>(
    `SELECT id FROM ${table} WHERE ${match.sql} ORDER BY created_at DESC LIMIT ${MAX_ROWS}`,
    match.params,
  ).map((r) => r.id);
}

function querySessions(identity: PlayerIdentity, scope: PlayerDataScope): PlayerSessionRow[] {
  const match = matchPlayer(identity, scope);
  return rowsOf<PlayerSessionRow>(
    'SELECT player_name, uuid, joined_at, left_at, duration_ms, server_id FROM play_sessions ' +
      `WHERE ${match.sql} ORDER BY joined_at DESC LIMIT ${MAX_ROWS}`,
    match.params,
  );
}

async function chatOf(identity: PlayerIdentity, scope: PlayerDataScope): Promise<ChatMessage[]> {
  const all: ChatMessage[] = [];
  for (const name of [...identity.names, ...identity.sharedNames]) {
    all.push(...(await getPlayerChatHistory(name, scope, linesUnder(identity, name))));
  }
  return all.sort((x, y) => y.timestamp.localeCompare(x.timestamp)).slice(0, MAX_ROWS);
}

export async function exportPlayerData(
  playerName: string,
  scope: PlayerDataScope,
): Promise<PlayerDataExport> {
  if (isDemoMode()) {
    return {
      player: playerName,
      generatedAt: new Date().toISOString(),
      notes: [],
      punishments: [],
      playSessions: [],
      playtimeSummary: { totalSessions: 0, totalMs: 0 },
      chat: [],
      uuids: [],
    };
  }

  const identity = resolveIdentity(playerName, scope);
  const notes = rowIds('player_notes', identity, scope)
    .map(getNote)
    .filter((n): n is PlayerNote => n !== null);
  const punishments = rowIds('punishments', identity, scope)
    .map(getPunishment)
    .filter((p): p is Punishment => p !== null);
  const playSessions = querySessions(identity, scope);
  // Each message carries its server id.
  const chat = await chatOf(identity, scope);

  const totalMs = playSessions.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
  return {
    player: playerName,
    generatedAt: new Date().toISOString(),
    notes,
    punishments,
    playSessions,
    playtimeSummary: { totalSessions: playSessions.length, totalMs },
    chat,
    uuids: identity.uuids,
  };
}

export interface ErasureResult {
  player: string;
  deleted: { notes: number; punishments: number; playSessions: number; chat: boolean };
  /**
   * Punishments still in effect stay: a running tempban needs its record to
   * be lifted when it ends, a ban to be lifted at all.
   */
  kept: { activePunishments: number };
}

/**
 * Erase the panel's personal data for a player on `scope` (every server for
 * null): notes, sessions, chat, and the punishments no longer in effect.
 * Idempotent.
 */
export async function deletePlayerData(
  playerName: string,
  scope: PlayerDataScope,
): Promise<ErasureResult> {
  if (isDemoMode()) {
    return {
      player: playerName,
      deleted: { notes: 0, punishments: 0, playSessions: 0, chat: true },
      kept: { activePunishments: 0 },
    };
  }
  const identity = resolveIdentity(playerName, scope);
  const match = matchPlayer(identity, scope);
  const notes = changedRows(`DELETE FROM player_notes WHERE ${match.sql}`, match.params);
  const punishments = changedRows(
    `DELETE FROM punishments WHERE ${match.sql} AND active = 0`,
    match.params,
  );
  const activePunishments =
    rowsOf<{ n: number }>(
      `SELECT COUNT(*) AS n FROM punishments WHERE ${match.sql} AND active = 1`,
      match.params,
    )[0]?.n ?? 0;
  const playSessions = changedRows(`DELETE FROM play_sessions WHERE ${match.sql}`, match.params);
  let chat = true;
  for (const name of [...identity.names, ...identity.sharedNames]) {
    if (!(await deletePlayerChatData(name, scope, linesUnder(identity, name)))) chat = false;
  }
  if (!(await deletePlayerGlobalChatLines(scope, linesOf(identity)))) chat = false;

  return {
    player: playerName,
    deleted: { notes, punishments, playSessions, chat },
    kept: { activePunishments },
  };
}
