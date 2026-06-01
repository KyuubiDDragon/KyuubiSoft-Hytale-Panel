import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Tests use a temp directory to avoid polluting the real /app/data.
const tmpDir = path.join(os.tmpdir(), `kp-audit-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

describe('audit log v2', () => {
  beforeAll(async () => {
    // import after the env var is set so getDb() resolves the temp path
    const { audit } = await import('./audit.js');
    audit(null, 'test.event', { actor: 'tester', target: 'thing:1', metadata: { x: 1 } });
    audit(null, 'test.event', { actor: 'tester', target: 'thing:2', success: false });
    audit(null, 'auth.login_success', { actor: 'alice' });
  });

  it('lists events in reverse chronological order', async () => {
    const { listAuditEvents } = await import('./audit.js');
    const { events, nextCursor } = listAuditEvents({});
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].id).toBeGreaterThan(events[events.length - 1].id);
    expect(nextCursor).toBeNull();
  });

  it('filters by actor', async () => {
    const { listAuditEvents } = await import('./audit.js');
    const { events } = listAuditEvents({ actor: 'alice' });
    expect(events.every(e => e.actorUsername === 'alice')).toBe(true);
  });

  it('records success=false explicitly', async () => {
    const { listAuditEvents } = await import('./audit.js');
    const { events } = listAuditEvents({});
    const failed = events.find(e => e.target === 'thing:2');
    expect(failed?.success).toBe(false);
  });

  it('parses metadata back to object', async () => {
    const { listAuditEvents } = await import('./audit.js');
    const { events } = listAuditEvents({});
    const withMeta = events.find(e => e.target === 'thing:1');
    expect(withMeta?.metadata).toEqual({ x: 1 });
  });
});
