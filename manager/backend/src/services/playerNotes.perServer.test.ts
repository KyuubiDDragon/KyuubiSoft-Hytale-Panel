/**
 * Staff notes belong to one server: listing and deleting through another
 * server finds nothing, and the migration assigns older rows to the compose server.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

const tmpDir = path.join(os.tmpdir(), `kp-notes-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

const { MIGRATIONS } = await import('../db/index.js');
const notes = await import('./playerNotes.js');

describe('player notes per server', () => {
  it('lists only the notes of the asked server', () => {
    notes.addNote({ playerName: 'Alex', note: 'on A', byUser: 'op', serverId: 'a' });
    notes.addNote({ playerName: 'Alex', note: 'on B', byUser: 'op', serverId: 'b' });
    expect(notes.listServerNotes('a', 'Alex').map((n) => n.note)).toEqual(['on A']);
    expect(notes.listServerNotes('b', 'Alex').map((n) => n.note)).toEqual(['on B']);
  });

  it('does not delete a note of another server or player', () => {
    const created = notes.addNote({ playerName: 'Sam', note: 'x', byUser: 'op', serverId: 'a' });
    expect(notes.deleteNote('b', 'Sam', created.id)).toBe(false);
    expect(notes.deleteNote('a', 'Other', created.id)).toBe(false);
    expect(notes.deleteNote('a', 'Sam', created.id)).toBe(true);
  });

  it('migration gives rows without a server to the compose server, idempotently', () => {
    const conn = new Database(':memory:');
    MIGRATIONS.find((m) => m.version === 1)!.up(conn);
    conn.exec("INSERT INTO player_notes (player_name, note, by_user, created_at) VALUES ('P','n','u','t')");
    const up = MIGRATIONS.find((m) => m.name === 'player_notes_server')!.up;
    up(conn);
    up(conn);
    const row = conn.prepare('SELECT server_id FROM player_notes').get() as { server_id: string };
    expect(row.server_id).toBe('default');
  });
});
