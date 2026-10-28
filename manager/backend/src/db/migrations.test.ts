/**
 * Tests for the schema migration runner: a fresh DB applies every migration
 * and records them, the expected tables exist, and re-running is idempotent.
 * The per-server migration assigns rows from single-server installs to the
 * compose server once, and only those.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

const tmpDir = path.join(os.tmpdir(), `kp-migrations-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

const { getDb, getSchemaVersion, runMigrations, MIGRATIONS } = await import('./index.js');
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

/** A database as a single-server install left it: the baseline only. */
function baselineDb(): Database.Database {
  const conn = new Database(':memory:');
  conn.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  MIGRATIONS.find((m) => m.version === 1)!.up(conn);
  conn
    .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)')
    .run('baseline', new Date().toISOString());
  return conn;
}

describe('db migrations', () => {
  it('applies every migration on a fresh DB', () => {
    const db = getDb();
    expect(getSchemaVersion(db)).toBe(LATEST);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual(
      [...MIGRATIONS]
        .sort((a, b) => a.version - b.version)
        .map((m) => ({ version: m.version, name: m.name })),
    );
    expect(rows[0]).toEqual({ version: 1, name: 'baseline' });
  });

  it('creates the expected baseline tables', () => {
    const db = getDb();
    const exists = (name: string) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    for (const t of [
      'audit_events',
      'api_keys',
      'punishments',
      'notifications',
      'crash_reports',
      'push_subscriptions',
      'play_sessions',
    ]) {
      expect(exists(t), `table ${t} should exist`).toBeTruthy();
    }
  });

  it('is idempotent — re-running does not re-apply or duplicate', () => {
    const db = getDb();
    runMigrations(db);
    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(LATEST);
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(c).toBe(MIGRATIONS.length);
  });
});

describe('db migrations: per-server data', () => {
  it('assigns rows without a server to the compose server, once', () => {
    const conn = baselineDb();
    const now = new Date().toISOString();
    conn
      .prepare(
        "INSERT INTO punishments (server_id, player_name, type, by_user, created_at) VALUES (NULL, 'Old', 'ban', 'admin', ?), ('b1c2d3e4', 'New', 'ban', 'admin', ?)",
      )
      .run(now, now);
    conn
      .prepare('INSERT INTO crash_reports (server_id, detected_at, created_at) VALUES (NULL, ?, ?)')
      .run(now, now);
    conn
      .prepare(
        "INSERT INTO play_sessions (server_id, uuid, player_name, joined_at) VALUES (NULL, 'u1', 'Old', ?)",
      )
      .run(now);
    conn
      .prepare(
        "INSERT INTO webhooks (id, name, url, type, events, enabled, created_by, created_at, updated_at) VALUES ('w1', 'hook', 'https://example.com', 'generic', '[\"*\"]', 1, 'admin', ?, ?)",
      )
      .run(now, now);

    runMigrations(conn);

    const servers = (table: string) =>
      (
        conn.prepare(`SELECT server_id FROM ${table} ORDER BY rowid`).all() as {
          server_id: string | null;
        }[]
      ).map((r) => r.server_id);
    expect(servers('punishments')).toEqual(['default', 'b1c2d3e4']);
    expect(servers('crash_reports')).toEqual(['default']);
    expect(servers('play_sessions')).toEqual(['default']);
    // Existing webhooks keep getting every server's events.
    expect(conn.prepare("SELECT server_ids FROM webhooks WHERE id = 'w1'").get()).toEqual({
      server_ids: null,
    });

    // Forward only: a row written later without a server is not touched again.
    conn
      .prepare(
        "INSERT INTO punishments (server_id, player_name, type, by_user, created_at) VALUES (NULL, 'Late', 'warn', 'admin', ?)",
      )
      .run(now);
    runMigrations(conn);
    expect(servers('punishments')).toEqual(['default', 'b1c2d3e4', null]);
    expect(getSchemaVersion(conn)).toBe(LATEST);
    conn.close();
  });
});
