/**
 * Staff notes per player. Name-keyed to match the existing punishment system.
 */
import { getDb } from '../db/index.js';

export interface PlayerNote {
  id: number;
  serverId: string | null;
  playerName: string;
  uuid: string | null;
  note: string;
  byUser: string;
  createdAt: string;
}

export function addNote(opts: { playerName: string; note: string; byUser: string; serverId?: string; uuid?: string }): PlayerNote {
  const db = getDb();
  const info = db
    .prepare('INSERT INTO player_notes (server_id, player_name, uuid, note, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(opts.serverId ?? null, opts.playerName, opts.uuid ?? null, opts.note, opts.byUser, new Date().toISOString());
  return getNote(Number(info.lastInsertRowid))!;
}

export function getNote(id: number): PlayerNote | null {
  const r = getDb().prepare('SELECT * FROM player_notes WHERE id = ?').get(id) as
    | { id: number; server_id: string | null; player_name: string; uuid: string | null; note: string; by_user: string; created_at: string }
    | undefined;
  if (!r) return null;
  return { id: r.id, serverId: r.server_id, playerName: r.player_name, uuid: r.uuid, note: r.note, byUser: r.by_user, createdAt: r.created_at };
}

export function listNotes(playerName: string, limit = 100): PlayerNote[] {
  const rows = getDb()
    .prepare('SELECT * FROM player_notes WHERE player_name = ? ORDER BY created_at DESC LIMIT ?')
    .all(playerName, Math.max(1, limit)) as Array<{
      id: number; server_id: string | null; player_name: string; uuid: string | null; note: string; by_user: string; created_at: string;
    }>;
  return rows.map((r) => ({ id: r.id, serverId: r.server_id, playerName: r.player_name, uuid: r.uuid, note: r.note, byUser: r.by_user, createdAt: r.created_at }));
}

export function deleteNote(id: number): boolean {
  return getDb().prepare('DELETE FROM player_notes WHERE id = ?').run(id).changes > 0;
}
