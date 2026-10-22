/**
 * Route tests for the Update Center.
 *
 * Real filesystem (temp server/updater/data dirs, small fake server JARs with a
 * Hytale manifest); Docker, the lifecycle module, auth and permissions are
 * stubbed. Covers: status read from the files instead of console output,
 * `/update apply --confirm`, apply on a stopped server, the `Update` settings
 * block only written with the server stopped, rollback from updater/backup,
 * and pending history entries that are only confirmed by the installed version.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { crc32 } from 'zlib';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-updates-route-'));
const serverDir = path.join(root, 'server');
const updaterDir = path.join(root, 'updater');
const dataDir = path.join(root, 'data');
const backupsDir = path.join(root, 'backups');
for (const d of [serverDir, updaterDir, dataDir, backupsDir]) fs.mkdirSync(d, { recursive: true });
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
process.env.SERVER_PATH = serverDir;
process.env.UPDATER_PATH = updaterDir;
process.env.DATA_PATH = dataDir;
process.env.BACKUPS_PATH = backupsDir;
delete process.env.DEMO_MODE;

const state = { running: true, java: true as boolean | null };
const execCommand = vi.fn(async (_cmd: string, _id?: string) => ({
  success: true,
  message: 'sent',
}));
vi.mock('../../services/docker.js', () => ({
  getContainerState: vi.fn(async () => ({
    running: state.running,
    status: state.running ? 'running' : 'exited',
  })),
  execCommand: (cmd: string, id?: string) => execCommand(cmd, id),
  isServerProcessRunning: vi.fn(async () => (state.running ? state.java : false)),
  execInContainer: vi.fn(async () => ({ success: true, output: 'LAYOUT_OK' })),
  getContainerMemoryLimit: vi.fn(async () => null),
}));
const withServerStopped = vi.fn(async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) =>
  fn(),
);
const startServer = vi.fn(async () => ({ ok: true, method: 'docker' }));
const lifecycle = { active: null as { reason: string; since: number } | null };
vi.mock('../../services/serverLifecycle.js', () => ({
  withServerStopped: (id: unknown, opts: unknown, fn: () => Promise<unknown>) =>
    withServerStopped(id, opts, fn),
  startServer: () => startServer(),
  getActiveOperation: () => lifecycle.active,
  isLifecycleBusy: () => lifecycle.active !== null,
  LifecycleError: class LifecycleError extends Error {},
  LifecycleBusyError: class LifecycleBusyError extends Error {},
}));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'tester';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const express = (await import('express')).default;
const { default: updatesRouter } = await import('./updates.js');

/** Stored-entry zip with a Hytale server manifest (enough for the manifest reader). */
function fakeServerJar(version: string, patchline = 'release'): Buffer {
  const name = Buffer.from('META-INF/MANIFEST.MF');
  const body = Buffer.from(
    `Manifest-Version: 1.0\r\nImplementation-Patchline: ${patchline}\r\nImplementation-Vendor-Id: com.hypixel.hytale\r\nImplementation-Version: ${version}\r\n\r\n`,
  );
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt32LE(crc32(body), 14);
  lfh.writeUInt32LE(body.length, 18);
  lfh.writeUInt32LE(body.length, 22);
  lfh.writeUInt16LE(name.length, 26);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt32LE(crc32(body), 16);
  cdh.writeUInt32LE(body.length, 20);
  cdh.writeUInt32LE(body.length, 24);
  cdh.writeUInt16LE(name.length, 28);
  const cd = Buffer.concat([cdh, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(30 + name.length + body.length, 16);
  return Buffer.concat([lfh, name, body, cd, eocd]);
}

function write(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/server', updatesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/server`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const d of [serverDir, updaterDir, dataDir]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  state.running = true;
  state.java = true;
  lifecycle.active = null;
  execCommand.mockClear();
  withServerStopped.mockClear();
  startServer.mockClear();
  write(path.join(serverDir, 'HytaleServer.jar'), fakeServerJar('0.7.2'));
  write(path.join(serverDir, 'Assets.zip'), 'assets-0.7.2');
});

const stage = (version = '0.7.3', patchline = 'release') => {
  write(
    path.join(updaterDir, 'staging', 'Server', 'HytaleServer.jar'),
    fakeServerJar(version, patchline),
  );
  write(path.join(updaterDir, 'staging', 'Assets.zip'), `assets-${version}`);
};
const stagingExists = () => fs.existsSync(path.join(updaterDir, 'staging'));

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('GET /update-status', () => {
  it('reads installed and staged versions from the files', async () => {
    stage();
    const { status, json } = await call('GET', '/update-status');
    expect(status).toBe(200);
    expect(json.data).toMatchObject({
      currentVersion: '0.7.2',
      state: 'READY',
      available: true,
      staged: { version: '0.7.3', patchline: 'release' },
      serverRunning: true,
      layoutValid: true,
    });
    expect(json.data.actions.apply.allowed).toBe(true);
    expect(json.data.actions.download).toEqual({ allowed: false, reason: 'already_staged' });
  });

  it('reports nothing staged and blocks download while the server is stopped', async () => {
    state.running = false;
    const { json } = await call('GET', '/update-status');
    expect(json.data.state).toBe('IDLE');
    expect(json.data.actions.download).toEqual({ allowed: false, reason: 'server_stopped' });
    expect(json.data.actions.apply).toEqual({ allowed: false, reason: 'nothing_staged' });
  });
});

describe('POST /update-apply', () => {
  it('sends /update apply --confirm and records a pending entry', async () => {
    stage();
    const { status } = await call('POST', '/update-apply');
    expect(status).toBe(200);
    expect(execCommand).toHaveBeenCalledWith('/update apply --confirm', undefined);
    const history = (await call('GET', '/update-history')).json.history;
    expect(history[0]).toMatchObject({
      action: 'apply',
      fromVersion: '0.7.2',
      toVersion: '0.7.3',
      pending: true,
    });
    // A panel snapshot of the replaced JAR (+ Assets.zip link) was taken first.
    expect((await call('GET', '/jar-snapshots')).json.snapshots[0]).toMatchObject({
      version: '0.7.2',
    });
  });

  it('starts a stopped server instead (the start script applies the staged files)', async () => {
    stage();
    state.running = false;
    const { status } = await call('POST', '/update-apply');
    expect(status).toBe(200);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('refuses without a staged update', async () => {
    const { status, json } = await call('POST', '/update-apply');
    expect(status).toBe(409);
    expect(json.reason).toBe('nothing_staged');
  });

  it('refuses while another lifecycle operation runs, even with force', async () => {
    stage();
    lifecycle.active = { reason: 'rollback', since: Date.now() };
    const { status, json } = await call('POST', '/update-apply', { force: true });
    expect(status).toBe(409);
    expect(json.reason).toBe('lifecycle_busy');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('needs a confirmation of its own for a build of another patchline', async () => {
    stage('0.8.0', 'pre-release');
    const refused = await call('POST', '/update-apply');
    expect(refused.status).toBe(409);
    expect(refused.json.reason).toBe('patchline_mismatch');
    // force (disk space, unreadable JAR) does not confirm the switch
    expect((await call('POST', '/update-apply', { force: true })).json.reason).toBe(
      'patchline_mismatch',
    );
    expect(execCommand).not.toHaveBeenCalled();
    const confirmed = await call('POST', '/update-apply', { allowPatchlineSwitch: true });
    expect(confirmed.status).toBe(200);
    expect(execCommand).toHaveBeenCalledWith('/update apply --confirm', undefined);
  });

  it('confirms the pending entry once the installed version is the target', async () => {
    stage();
    await call('POST', '/update-apply');
    // What the start script does after exit code 8:
    fs.rmSync(path.join(updaterDir, 'staging'), { recursive: true, force: true });
    write(path.join(serverDir, 'HytaleServer.jar'), fakeServerJar('0.7.3'));
    const history = (await call('GET', '/update-history')).json.history;
    expect(history[0]).toMatchObject({ toVersion: '0.7.3', success: true, pending: false });
  });
});

describe('PUT /update-config', () => {
  const configFile = () => path.join(serverDir, 'config.json');

  it('refuses to write while the server runs unless a restart is requested', async () => {
    write(configFile(), JSON.stringify({ ServerName: 'A' }));
    const refused = await call('PUT', '/update-config', { autoApplyMode: 'WHEN_EMPTY' });
    expect(refused.status).toBe(409);
    expect(refused.json.requiresRestart).toBe(true);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf-8'))).toEqual({ ServerName: 'A' });

    const saved = await call('PUT', '/update-config', {
      autoApplyMode: 'WHEN_EMPTY',
      restart: true,
    });
    expect(saved.status).toBe(200);
    expect(withServerStopped).toHaveBeenCalledTimes(1);
    expect(withServerStopped.mock.calls[0][1]).toMatchObject({ reason: 'config', actor: 'tester' });
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf-8'))).toEqual({
      ServerName: 'A',
      Update: { AutoApplyMode: 'WhenEmpty' },
    });
    expect(saved.json.data.autoApplyMode).toBe('WHEN_EMPTY');
  });

  it('writes directly when the server is stopped and drops the legacy block', async () => {
    state.running = false;
    write(configFile(), JSON.stringify({ updateConfig: { enabled: true } }));
    const { status } = await call('PUT', '/update-config', {
      enabled: false,
      checkIntervalSeconds: 600,
    });
    expect(status).toBe(200);
    expect(withServerStopped).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf-8'))).toEqual({
      Update: { Enabled: false, CheckIntervalSeconds: 600 },
    });
  });

  it('rejects a patchline change', async () => {
    state.running = false;
    const { status } = await call('PUT', '/update-config', { patchline: 'pre-release' });
    expect(status).toBe(400);
  });

  it('keeps legacy settings the request does not set', async () => {
    state.running = false;
    write(configFile(), JSON.stringify({ updateConfig: { checkIntervalSeconds: 600 } }));
    const { status } = await call('PUT', '/update-config', { enabled: false });
    expect(status).toBe(200);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf-8'))).toEqual({
      Update: { Enabled: false, CheckIntervalSeconds: 600 },
    });
  });
});

describe('POST /update-download and /update-check', () => {
  it('sends /update download only when nothing is staged and the server runs', async () => {
    const ok = await call('POST', '/update-download');
    expect(ok.status).toBe(202);
    expect(execCommand).toHaveBeenCalledWith('/update download', undefined);

    stage();
    const staged = await call('POST', '/update-download');
    expect(staged.status).toBe(409);
    expect(staged.json.reason).toBe('already_staged');

    fs.rmSync(path.join(updaterDir, 'staging'), { recursive: true, force: true });
    state.running = false;
    expect((await call('POST', '/update-download')).json.reason).toBe('server_stopped');
  });

  it('answers a missing downloader login with 409 + authRequired, not 401', async () => {
    // No credentials in the downloader volume (the container probe says missing).
    const { status, json } = await call('POST', '/update-check');
    expect(status).toBe(409);
    expect(json.authRequired).toBe(true);
  });
});

describe('POST /update-cancel', () => {
  it('asks a running server to discard it', async () => {
    stage();
    const { status } = await call('POST', '/update-cancel');
    expect(status).toBe(200);
    expect(execCommand).toHaveBeenCalledWith('/update cancel', undefined);
    expect(stagingExists()).toBe(true);
  });

  it('deletes the staging folder of a stopped server under the lifecycle lock', async () => {
    stage();
    state.running = false;
    const { status, json } = await call('POST', '/update-cancel');
    expect(status).toBe(200);
    expect(json.discarded).toBe(true);
    expect(withServerStopped).toHaveBeenCalledTimes(1);
    expect(execCommand).not.toHaveBeenCalled();
    expect(stagingExists()).toBe(false);
    expect(fs.readdirSync(updaterDir)).toEqual([]);
  });

  it('refuses without a staged update', async () => {
    state.running = false;
    const { status, json } = await call('POST', '/update-cancel');
    expect(status).toBe(409);
    expect(json.reason).toBe('nothing_staged');
  });

  it('refuses while the container runs without Java (start script installing or restarting)', async () => {
    stage();
    state.java = false;
    const { status, json } = await call('POST', '/update-cancel');
    expect(status).toBe(409);
    expect(json.reason).toBe('lifecycle_busy');
    expect(execCommand).not.toHaveBeenCalled();
    expect(stagingExists()).toBe(true);
  });
});

describe('POST /rollback', () => {
  it('restores JAR and Assets.zip from updater/backup with the server stopped', async () => {
    write(path.join(updaterDir, 'backup', 'Server', 'HytaleServer.jar'), fakeServerJar('0.7.1'));
    write(path.join(updaterDir, 'backup', 'Assets.zip'), 'assets-0.7.1');
    write(path.join(updaterDir, 'backup', 'Server', 'Licenses', 'LICENSE.txt'), 'old license');
    const { status, json } = await call('POST', '/rollback', { source: 'native' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ restoredVersion: '0.7.1', restoredAssets: true });
    expect(withServerStopped.mock.calls[0][1]).toMatchObject({ reason: 'rollback' });
    expect(fs.readFileSync(path.join(serverDir, 'Assets.zip'), 'utf-8')).toBe('assets-0.7.1');
    expect(fs.readFileSync(path.join(serverDir, 'Licenses', 'LICENSE.txt'), 'utf-8')).toBe(
      'old license',
    );
    expect(fs.readFileSync(path.join(serverDir, '.hytale-version'), 'utf-8')).toBe(
      '0.7.1\nrelease\n',
    );
    expect((await call('GET', '/update-status')).json.data.currentVersion).toBe('0.7.1');
    // No temporary files left behind
    expect(fs.readdirSync(serverDir).filter((n) => n.endsWith('.rollback-tmp'))).toEqual([]);
  });

  it('restores a JAR snapshot together with its Assets.zip', async () => {
    const snap = (await call('POST', '/jar-snapshot')).json.snapshot;
    expect(snap.hasAssets).toBe(true);
    // An update replaces both files (by rename, like the start script).
    write(path.join(serverDir, 'HytaleServer.jar.new'), fakeServerJar('0.7.3'));
    fs.renameSync(
      path.join(serverDir, 'HytaleServer.jar.new'),
      path.join(serverDir, 'HytaleServer.jar'),
    );
    write(path.join(serverDir, 'Assets.zip.new'), 'assets-0.7.3');
    fs.renameSync(path.join(serverDir, 'Assets.zip.new'), path.join(serverDir, 'Assets.zip'));

    const { status, json } = await call('POST', '/rollback', { snapshotId: snap.id });
    expect(status).toBe(200);
    expect(json).toMatchObject({ restoredVersion: '0.7.2', restoredAssets: true });
    expect(fs.readFileSync(path.join(serverDir, 'Assets.zip'), 'utf-8')).toBe('assets-0.7.2');
    const history = (await call('GET', '/update-history')).json.history;
    expect(history[0]).toMatchObject({
      action: 'rollback',
      fromVersion: '0.7.3',
      toVersion: '0.7.2',
      success: true,
    });
  });

  it('fails cleanly without a backup', async () => {
    const { status, json } = await call('POST', '/rollback', { source: 'native' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/No previous version/);
    expect(fs.readFileSync(path.join(serverDir, 'Assets.zip'), 'utf-8')).toBe('assets-0.7.2');
  });

  it('refuses while an update is staged, and discards it together with the rollback', async () => {
    write(path.join(updaterDir, 'backup', 'Server', 'HytaleServer.jar'), fakeServerJar('0.7.1'));
    write(path.join(updaterDir, 'backup', 'Assets.zip'), 'assets-0.7.1');
    stage('0.7.3');
    // A stopped server cannot discard it itself, the start would install it.
    state.running = false;

    const refused = await call('POST', '/rollback', { source: 'native' });
    expect(refused.status).toBe(409);
    expect(refused.json.reason).toBe('staged_update');
    expect(withServerStopped).not.toHaveBeenCalled();

    const done = await call('POST', '/rollback', { source: 'native', discardStaged: true });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ restoredVersion: '0.7.1', discardedStagedVersion: '0.7.3' });
    expect(stagingExists()).toBe(false);
    const history = (await call('GET', '/update-history')).json.history;
    expect(history[0].note).toMatch(/staged update 0\.7\.3 discarded/);
    expect(fs.readdirSync(updaterDir).filter((n) => n.startsWith('.staging'))).toEqual([]);
  });

  it('keeps the staged update when the rollback fails', async () => {
    stage('0.7.3');
    state.running = false;
    // No updater/backup: the native rollback fails after the update was set aside.
    const { status } = await call('POST', '/rollback', { source: 'native', discardStaged: true });
    expect(status).toBe(400);
    expect(stagingExists()).toBe(true);
    expect((await call('GET', '/update-status')).json.data.staged.version).toBe('0.7.3');
  });

  it('restores the AOT cache of a snapshot with its JAR', async () => {
    write(path.join(serverDir, 'HytaleServer.aot'), 'aot-0.7.2');
    const snap = (await call('POST', '/jar-snapshot')).json.snapshot;
    expect(snap.hasAot).toBe(true);
    for (const [name, content] of [
      ['HytaleServer.jar', fakeServerJar('0.7.3')],
      ['HytaleServer.aot', 'aot-0.7.3'],
    ] as const) {
      write(path.join(serverDir, `${name}.new`), content);
      fs.renameSync(path.join(serverDir, `${name}.new`), path.join(serverDir, name));
    }
    const { status } = await call('POST', '/rollback', { snapshotId: snap.id });
    expect(status).toBe(200);
    expect(fs.readFileSync(path.join(serverDir, 'HytaleServer.aot'), 'utf-8')).toBe('aot-0.7.2');
  });

  it('does not restore a linked Assets.zip that was rewritten in place', async () => {
    const snap = (await call('POST', '/jar-snapshot')).json.snapshot;
    expect(snap.hasAssets).toBe(true);
    // Rewriting the live file changes the hard-linked snapshot copy as well.
    fs.writeFileSync(path.join(serverDir, 'Assets.zip'), 'assets-0.7.3-rewritten');
    const listed = (await call('GET', '/jar-snapshots')).json.snapshots.find(
      (s: { id: string }) => s.id === snap.id,
    );
    expect(listed.hasAssets).toBe(false);
    const { json } = await call('POST', '/rollback', { snapshotId: snap.id });
    expect(json.restoredAssets).toBe(false);
  });

  it('keeps the snapshot it restores when the undo snapshot prunes old ones', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await call('POST', '/jar-snapshot')).json.snapshot.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    write(path.join(serverDir, 'HytaleServer.jar'), fakeServerJar('0.7.3'));
    // The oldest of five: the snapshot taken before the rollback makes it the sixth.
    const { status, json } = await call('POST', '/rollback', { snapshotId: ids[0] });
    expect(status).toBe(200);
    expect(json.restoredVersion).toBe('0.7.2');
  });

  it('refuses a second rollback while one runs, without queueing or recording it', async () => {
    lifecycle.active = { reason: 'rollback', since: Date.now() };
    const { status, json } = await call('POST', '/rollback', { source: 'native' });
    expect(status).toBe(409);
    expect(json.reason).toBe('lifecycle_busy');
    expect(withServerStopped).not.toHaveBeenCalled();
    expect((await call('GET', '/update-history')).json.history).toEqual([]);
  });

  it('answers lifecycle_busy when the lock is taken between the check and the start', async () => {
    write(path.join(updaterDir, 'backup', 'Server', 'HytaleServer.jar'), fakeServerJar('0.7.1'));
    const { LifecycleBusyError } = await import('../../services/serverLifecycle.js');
    withServerStopped.mockImplementationOnce(async () => {
      throw new LifecycleBusyError();
    });
    const { status, json } = await call('POST', '/rollback', { source: 'native' });
    expect(status).toBe(409);
    expect(json.reason).toBe('lifecycle_busy');
    expect((await call('GET', '/update-history')).json.history).toEqual([]);
    expect(fs.readFileSync(path.join(serverDir, 'HytaleServer.jar'))).toEqual(
      fakeServerJar('0.7.2'),
    );
  });
});

describe('lifecycle lock while saving settings or snapshotting', () => {
  it('refuses to save the update settings and to snapshot while an operation runs', async () => {
    state.running = false;
    lifecycle.active = { reason: 'restore', since: Date.now() };
    const saved = await call('PUT', '/update-config', { enabled: false });
    expect(saved.status).toBe(409);
    expect(saved.json.reason).toBe('lifecycle_busy');
    expect(fs.existsSync(path.join(serverDir, 'config.json'))).toBe(false);
    const snap = await call('POST', '/jar-snapshot');
    expect(snap.status).toBe(409);
    expect(fs.existsSync(path.join(serverDir, '.jar-snapshots'))).toBe(false);
    expect((await call('GET', '/update-status')).json.data.lifecycleBusy).toBe(true);
  });
});

describe('updater mount', () => {
  const marker = (dir: string, id: string) => write(path.join(dir, '.updater-mount-id'), `${id}\n`);

  it('counts the folder as shared when both markers match (or none was written yet)', async () => {
    expect((await call('GET', '/update-status')).json.data.updaterMount).toBe('mounted');
    marker(updaterDir, 'same');
    marker(serverDir, 'same');
    const { json } = await call('GET', '/update-status');
    expect(json.data).toMatchObject({ updaterMount: 'mounted', updaterMounted: true });
  });

  it('blocks updates and rollbacks when the game container uses another updater folder', async () => {
    marker(serverDir, 'from-game-container');
    marker(updaterDir, 'stale-or-other');
    stage();
    const { json } = await call('GET', '/update-status');
    expect(json.data).toMatchObject({ updaterMount: 'not_shared', updaterMounted: false });
    // What the panel sees in its folder says nothing about the game container's.
    expect(json.data.staged).toBeNull();
    for (const action of ['download', 'apply', 'cancel', 'rollbackNative', 'rollbackSnapshot']) {
      expect(json.data.actions[action], action).toEqual({ allowed: false, reason: 'no_updater' });
    }
    const rollback = await call('POST', '/rollback', { snapshotId: 'snap-x' });
    expect(rollback.status).toBe(409);
    expect(rollback.json.reason).toBe('no_updater');
    expect((await call('POST', '/update-apply')).json.reason).toBe('no_updater');
    expect(withServerStopped).not.toHaveBeenCalled();
  });

  it('reports a missing updater folder (compose file without the mount)', async () => {
    fs.rmSync(updaterDir, { recursive: true, force: true });
    const { json } = await call('GET', '/update-status');
    expect(json.data).toMatchObject({ updaterMount: 'missing', updaterMounted: false });
    expect(json.data.actions.rollbackSnapshot).toEqual({ allowed: false, reason: 'no_updater' });
  });
});

// Files the game server can write to are never read or copied through a link
// (see utils/noFollowFs). Creating file symlinks on Windows needs extra
// rights, so those cases are skipped there (CI runs on Linux); directory
// links use a junction.
function canCreateLink(type: 'file' | 'junction'): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-link-probe-'));
  try {
    const target = path.join(dir, 'target');
    if (type === 'file') fs.writeFileSync(target, '');
    else fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(dir, 'link'), type);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const CAN_LINK_FILES = canCreateLink('file');
const CAN_LINK_DIRS = canCreateLink('junction');

describe('links planted by the game server', () => {
  // Stands in for the panel's own data (/app/data in the manager container).
  const panelDir = path.join(root, 'panel-data');
  const SECRET = 'TOP-SECRET-JWT';
  const secretJson = path.join(panelDir, 'config.json');
  const secretText = path.join(panelDir, 'panel.sqlite');

  beforeEach(() => {
    fs.rmSync(panelDir, { recursive: true, force: true });
    write(secretJson, JSON.stringify({ jwtSecret: SECRET }));
    write(secretText, `SQLite format 3 ${SECRET}`);
  });

  /** Every regular file below dir (links are not followed) that holds the secret. */
  function leaks(dir: string): string[] {
    const found: string[] = [];
    const walk = (d: string) => {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        const st = fs.lstatSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && fs.readFileSync(full, 'utf-8').includes(SECRET)) found.push(full);
      }
    };
    walk(dir);
    return found;
  }
  const backupJar = () =>
    write(path.join(updaterDir, 'backup', 'Server', 'HytaleServer.jar'), fakeServerJar('0.7.1'));

  it.skipIf(!CAN_LINK_FILES)('does not snapshot a HytaleServer.jar that is a link', async () => {
    fs.rmSync(path.join(serverDir, 'HytaleServer.jar'));
    fs.symlinkSync(secretText, path.join(serverDir, 'HytaleServer.jar'), 'file');
    const { status, json } = await call('POST', '/jar-snapshot');
    expect(status).toBe(400);
    expect(json.error).toMatch(/HytaleServer\.jar.*symbolic link/);
    expect(leaks(serverDir)).toEqual([]);
  });

  it.skipIf(!CAN_LINK_FILES)(
    'refuses a rollback from an Assets.zip in updater/backup that is a link',
    async () => {
      backupJar();
      fs.symlinkSync(secretText, path.join(updaterDir, 'backup', 'Assets.zip'), 'file');
      const { status, json } = await call('POST', '/rollback', { source: 'native' });
      expect(status).toBe(400);
      expect(json.error).toMatch(/Assets\.zip.*symbolic link/);
      expect(fs.readFileSync(path.join(serverDir, 'Assets.zip'), 'utf-8')).toBe('assets-0.7.2');
      expect(leaks(serverDir)).toEqual([]);
      expect(fs.readdirSync(serverDir).filter((n) => n.includes('rollback-tmp'))).toEqual([]);
    },
  );

  it.skipIf(!CAN_LINK_DIRS)('refuses a rollback when Licenses is a linked folder', async () => {
    backupJar();
    fs.symlinkSync(panelDir, path.join(updaterDir, 'backup', 'Server', 'Licenses'), 'junction');
    const { status, json } = await call('POST', '/rollback', { source: 'native' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Licenses.*symbolic link/);
    expect(leaks(serverDir)).toEqual([]);
    expect(fs.readFileSync(path.join(serverDir, 'HytaleServer.jar'))).toEqual(
      fakeServerJar('0.7.2'),
    );
  });

  it.skipIf(!CAN_LINK_DIRS)('refuses a rollback from a linked updater/backup folder', async () => {
    write(path.join(panelDir, 'Server', 'HytaleServer.jar'), fakeServerJar('0.7.1'));
    write(path.join(panelDir, 'Assets.zip'), `assets ${SECRET}`);
    fs.symlinkSync(panelDir, path.join(updaterDir, 'backup'), 'junction');
    const { status, json } = await call('POST', '/rollback', { source: 'native' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/outside the expected folder/);
    expect(leaks(serverDir)).toEqual([]);
  });

  it('refuses a source file with a second hard link', async () => {
    backupJar();
    write(path.join(panelDir, 'hard.zip'), `assets ${SECRET}`);
    fs.linkSync(path.join(panelDir, 'hard.zip'), path.join(updaterDir, 'backup', 'Assets.zip'));
    const { status, json } = await call('POST', '/rollback', { source: 'native' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Assets\.zip.*hard link/);
    expect(leaks(serverDir)).toEqual([]);
  });

  it.skipIf(!CAN_LINK_FILES)(
    'replaces a linked .hytale-version and history file instead of writing through them',
    async () => {
      backupJar();
      write(path.join(updaterDir, 'backup', 'Assets.zip'), 'assets-0.7.1');
      fs.symlinkSync(secretJson, path.join(serverDir, '.hytale-version'), 'file');
      fs.symlinkSync(secretJson, path.join(dataDir, 'update-history.json'), 'file');
      const { status } = await call('POST', '/rollback', { source: 'native' });
      expect(status).toBe(200);
      expect(JSON.parse(fs.readFileSync(secretJson, 'utf-8'))).toEqual({ jwtSecret: SECRET });
      expect(fs.lstatSync(path.join(serverDir, '.hytale-version')).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(serverDir, '.hytale-version'), 'utf-8')).toBe(
        '0.7.1\nrelease\n',
      );
      expect(fs.lstatSync(path.join(dataDir, 'update-history.json')).isFile()).toBe(true);
      expect(leaks(serverDir)).toEqual([]);
      expect(leaks(dataDir)).toEqual([]);
    },
  );

  it.skipIf(!CAN_LINK_FILES)(
    'neither reads nor rewrites a config.json that is a link',
    async () => {
      state.running = false;
      fs.symlinkSync(secretJson, path.join(serverDir, 'config.json'), 'file');
      const saved = await call('PUT', '/update-config', { enabled: false });
      expect(saved.status).toBe(500);
      expect(saved.json.message).toMatch(/config\.json.*symbolic link/);
      expect(fs.lstatSync(path.join(serverDir, 'config.json')).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(secretJson, 'utf-8'))).toEqual({ jwtSecret: SECRET });

      // A corrupt-file copy is not made through the link either.
      fs.rmSync(path.join(serverDir, 'config.json'));
      fs.symlinkSync(secretText, path.join(serverDir, 'config.json'), 'file');
      expect((await call('GET', '/update-config')).status).toBe(500);
      expect((await call('GET', '/update-status')).status).toBe(200);
      expect(leaks(serverDir)).toEqual([]);
    },
  );

  it('ignores a planted snapshot sidecar whose id is a path', async () => {
    const dir = path.join(serverDir, '.jar-snapshots');
    const victim = path.join(root, 'victim.json');
    write(victim, 'keep');
    write(path.join(dir, 'x.jar'), fakeServerJar('0.6.0'));
    write(path.join(dir, 'x.zip'), 'assets');
    write(
      path.join(dir, 'snap-evil.json'),
      JSON.stringify({
        id: '../../victim',
        version: '0.6.0',
        createdAt: '2000-01-01T00:00:00.000Z',
        sizeBytes: 1,
        file: 'x.jar',
        assetsFile: 'x.zip',
      }),
    );
    for (let i = 0; i < 3; i++) {
      await call('POST', '/jar-snapshot');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const ids = (await call('GET', '/jar-snapshots')).json.snapshots.map(
      (s: { id: string }) => s.id,
    );
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('../../victim');
    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep');
    expect((await call('POST', '/rollback', { snapshotId: '../../victim' })).status).toBe(400);
  });
});
