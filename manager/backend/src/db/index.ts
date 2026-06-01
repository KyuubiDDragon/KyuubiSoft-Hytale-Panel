/**
 * SQLite database initialization.
 *
 * Holds runtime data that outgrew JSON snapshots: audit events, webhooks,
 * webhook deliveries, notifications. Lives next to users.json and config.json
 * in the manager-data volume so a single `docker volume rm` wipes everything.
 *
 * Single connection per process, opened lazily, WAL mode for concurrent reads
 * while a writer holds the journal.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
const DB_PATH = path.join(DATA_DIR, 'panel.sqlite');

let db: Database.Database | null = null;

function ensureSchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      actor_username TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'user',
      action TEXT NOT NULL,
      target TEXT,
      ip TEXT,
      user_agent TEXT,
      metadata TEXT,
      success INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_username);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      type TEXT NOT NULL,
      events TEXT NOT NULL,
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      response_code INTEGER,
      response_body_truncated TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_status ON webhook_deliveries(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_username TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      link TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT,
      dismissed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_username, created_at DESC);

    CREATE TABLE IF NOT EXISTS notification_prefs (
      username TEXT NOT NULL,
      event_name TEXT NOT NULL,
      in_app INTEGER NOT NULL DEFAULT 1,
      email INTEGER NOT NULL DEFAULT 0,
      webhook INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (username, event_name)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      owner_username TEXT NOT NULL,
      name TEXT NOT NULL,
      scopes TEXT NOT NULL,
      hashed_token TEXT NOT NULL,
      prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_username);
    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

    CREATE TABLE IF NOT EXISTS punishments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT,
      player_name TEXT NOT NULL,
      uuid TEXT,
      type TEXT NOT NULL,            -- ban | tempban | kick | mute | tempmute | warn
      reason TEXT,
      by_user TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,              -- null = permanent / not applicable
      active INTEGER NOT NULL DEFAULT 1, -- 1 while in effect; kicks/warns are historical (0)
      revoked_at TEXT,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_punish_player ON punishments(player_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_punish_active ON punishments(active, expires_at);

    CREATE TABLE IF NOT EXISTS event_actions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      server_id TEXT,                 -- null = all servers
      event_pattern TEXT NOT NULL,    -- 'player.joined' | 'server.*' | '*'
      action_type TEXT NOT NULL,      -- command | announce | backup
      action_payload TEXT,            -- JSON: { command?, message? }
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_actions_enabled ON event_actions(enabled);

    CREATE TABLE IF NOT EXISTS play_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT,
      uuid TEXT NOT NULL,
      player_name TEXT NOT NULL,
      joined_at TEXT NOT NULL,         -- ISO timestamp
      left_at TEXT,                    -- null = still online
      duration_ms INTEGER              -- filled when the session ends
    );
    CREATE INDEX IF NOT EXISTS idx_play_sessions_uuid ON play_sessions(uuid, joined_at DESC);
    CREATE INDEX IF NOT EXISTS idx_play_sessions_open ON play_sessions(left_at);
  `);
}

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
