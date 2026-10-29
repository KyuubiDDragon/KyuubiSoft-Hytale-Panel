/**
 * Backup routes: a restore answers 202 with a job right away (the request no
 * longer stays open for the whole restore), `?wait=true` keeps the blocking
 * behaviour for scripts, and the native routes validate their parameters.
 * Auth and the services are mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    startRestore: vi.fn(),
    waitForBackupJob: vi.fn(),
    getBackupJob: vi.fn(),
    audit: vi.fn(),
  },
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../services/demoData.js', () => ({ isDemoMode: () => false, getDemoBackups: () => [] }));
vi.mock('../services/audit.js', () => ({ audit: mocks.audit }));
vi.mock('../services/backup.js', () => ({}));
vi.mock('../services/backupRestore.js', () => ({ startRestore: mocks.startRestore }));
vi.mock('../services/backupJobs.js', () => ({
  getBackupJob: mocks.getBackupJob,
  listBackupJobs: () => [],
  runningBackupJob: () => null,
  startBackupJob: vi.fn(),
  waitForBackupJob: mocks.waitForBackupJob,
}));

const { default: backupRoutes } = await import('./backup.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/backups', backupRoutes);
  // What serverScopeMiddleware does for the per-server mount.
  app.use(
    '/api/servers/:serverId/backups',
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.serverId = req.params.serverId;
      next();
    },
    backupRoutes,
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/backups`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  type: 'restore',
  // Jobs carry the resolved id; the legacy routes act on the default server.
  serverId: 'default',
  target: 'manual_x',
  state: 'running',
  step: 'queued',
  message: null,
  error: null,
  ...over,
});

describe('POST /api/backups/:id/restore', () => {
  it('starts a job and answers 202 immediately', async () => {
    mocks.startRestore.mockResolvedValue({ ok: true, job: job() });
    const res = await fetch(`${base}/manual_x/restore`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      success: true,
      job: { id: 'job-1', state: 'running' },
    });
    expect(mocks.startRestore).toHaveBeenCalledWith(
      { kind: 'panel', backupId: 'manual_x' },
      undefined,
      'alice',
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'backup.restore',
      expect.anything(),
    );
    expect(mocks.waitForBackupJob).not.toHaveBeenCalled();
  });

  it('waits for the result with ?wait=true', async () => {
    mocks.startRestore.mockResolvedValue({ ok: true, job: job() });
    mocks.waitForBackupJob.mockResolvedValue(job({ state: 'failed', error: 'Restore failed: x' }));
    const res = await fetch(`${base}/manual_x/restore?wait=true`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, error: 'Restore failed: x' });
  });

  it('passes 404 and 409 from the service through', async () => {
    mocks.startRestore.mockResolvedValue({ ok: false, status: 404, error: 'Backup not found' });
    expect((await fetch(`${base}/nope/restore`, { method: 'POST' })).status).toBe(404);
    mocks.startRestore.mockResolvedValue({ ok: false, status: 409, error: 'busy' });
    expect((await fetch(`${base}/manual_x/restore`, { method: 'POST' })).status).toBe(409);
  });
});

describe('native backup routes', () => {
  it('restores a native zip by scope and name', async () => {
    mocks.startRestore.mockResolvedValue({ ok: true, job: job({ type: 'native-restore' }) });
    const res = await fetch(`${base}/native/archive/2026-10-22_03-00-00.zip/restore`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    expect(mocks.startRestore).toHaveBeenCalledWith(
      { kind: 'native', scope: 'archive', name: '2026-10-22_03-00-00.zip' },
      undefined,
      'alice',
    );
  });

  it('rejects an unknown scope without calling the service', async () => {
    const res = await fetch(`${base}/native/other/x.zip/restore`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(mocks.startRestore).not.toHaveBeenCalled();
  });
});

describe('GET /api/backups/jobs/:jobId', () => {
  it('returns the job or 404', async () => {
    mocks.getBackupJob.mockReturnValueOnce(job({ state: 'succeeded' })).mockReturnValueOnce(null);
    expect(await (await fetch(`${base}/jobs/job-1`)).json()).toMatchObject({ state: 'succeeded' });
    expect((await fetch(`${base}/jobs/missing`)).status).toBe(404);
  });

  it("answers 404 for another server's job, like the job list", async () => {
    const serverBase = base.replace('/api/backups', '/api/servers/srv-b/backups');
    mocks.getBackupJob.mockReturnValue(job({ serverId: 'srv-a' }));
    expect((await fetch(`${serverBase}/jobs/job-1`)).status).toBe(404);
    expect((await fetch(`${base}/jobs/job-1`)).status).toBe(404);
    mocks.getBackupJob.mockReturnValue(job({ serverId: 'srv-b' }));
    expect((await fetch(`${serverBase}/jobs/job-1`)).status).toBe(200);
  });
});
