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
