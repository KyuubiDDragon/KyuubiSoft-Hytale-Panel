/**
 * Tests for the schema migration runner: a fresh DB applies the baseline and
 * records version 1, the expected tables exist, and re-running is idempotent.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { describe, it, expect } from 'vitest';

const tmpDir = path.join(os.tmpdir(), `kp-migrations-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

describe('db migrations', () => {
  it('applies the baseline and records version 1', async () => {
    const { getDb, getSchemaVersion } = await import('./index.js');
    const db = getDb();
    expect(getSchemaVersion(db)).toBe(1);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual([{ version: 1, name: 'baseline' }]);
  });

  it('creates the expected baseline tables', async () => {
    const { getDb } = await import('./index.js');
    const db = getDb();
    const exists = (name: string) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    for (const t of ['audit_events', 'api_keys', 'punishments', 'notifications', 'crash_reports', 'push_subscriptions', 'play_sessions']) {
      expect(exists(t), `table ${t} should exist`).toBeTruthy();
    }
  });

  it('is idempotent — re-running does not re-apply or duplicate', async () => {
    const { getDb, runMigrations, getSchemaVersion } = await import('./index.js');
    const db = getDb();
    runMigrations(db);
    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(1);
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(c).toBe(1);
  });
});
