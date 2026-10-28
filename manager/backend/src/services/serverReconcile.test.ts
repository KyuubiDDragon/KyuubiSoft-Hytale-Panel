/**
 * Boot-time reconcile: registry statuses follow the containers that exist,
 * panel containers without an entry are only reported, and Docker is never
 * asked to stop or remove anything.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-reconcile-'));
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.GAME_CONTAINER_NAME = 'kptest';
delete process.env.DEMO_MODE;

import type * as ServersModule from './servers.js';
import type * as ReconcileModule from './serverReconcile.js';

let servers: typeof ServersModule;
let reconcile: typeof ReconcileModule;
beforeAll(async () => {
  servers = await import('./servers.js');
  reconcile = await import('./serverReconcile.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const labels = (serverId: string, primary?: string) => ({
  'kyuubisoft.panel.managed': 'true',
  'kyuubisoft.panel.server-id': serverId,
  ...(primary ? { 'kyuubisoft.panel.primary': primary } : {}),
});

function container(name: string, containerLabels: Record<string, string>, state = 'running') {
  return { Id: `id-${name}`, Names: [`/${name}`], Labels: containerLabels, State: state };
}

async function entry(name: string, status: 'ready' | 'creating' | 'broken') {
  const created = await servers.createServerInstance({ name, createdBy: 'tester' });
  return (await servers.updateServerInstance(created.id, { status }))!;
}

describe('reconcileServers', () => {
  it('fixes statuses, reports orphans and touches no container', async () => {
    const pending = await entry('pending', 'creating');
    const vanished = await entry('vanished', 'ready');
    const hijacked = await entry('hijacked', 'creating');
    const recovered = await entry('recovered', 'broken');
    const fine = await entry('fine', 'ready');

    const added: string[] = [];
    const statusChanges: string[] = [];
    const unsubscribeAdded = servers.onServerAdded((s) => {
      added.push(s.id);
    });
    const unsubscribeStatus = servers.onServerStatusChanged((s, from) => {
      statusChanges.push(`${s.id}:${from}->${s.status}`);
    });
    const docker = {
      listContainers: vi.fn(async () => [
        container('kptest', { 'com.docker.compose.service': 'hytale' }),
        container(pending.containerName, labels(pending.id, 'kptest'), 'created'),
        container(hijacked.containerName, { 'com.docker.compose.service': 'manager' }),
        container(recovered.containerName, labels(recovered.id, 'kptest'), 'exited'),
        container(fine.containerName, labels(fine.id)),
        container('hytale-srv-ghost000', labels('ghost000', 'kptest'), 'exited'),
        container('other-srv-1', labels('elsewhere', 'otherstack')),
      ]),
      getContainer: vi.fn(),
    };

    try {
      const report = await reconcile.reconcileServers(docker as never);
      expect(report.checked).toBe((await servers.listServers()).length - 1);
      expect(report.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ serverId: pending.id, from: 'creating', to: 'ready' }),
          expect.objectContaining({ serverId: vanished.id, from: 'ready', to: 'broken' }),
          expect.objectContaining({ serverId: hijacked.id, from: 'creating', to: 'broken' }),
          expect.objectContaining({ serverId: recovered.id, from: 'broken', to: 'ready' }),
        ]),
      );
      expect(report.changes.some((c) => c.serverId === fine.id)).toBe(false);
      expect(report.orphans).toEqual([
        {
          containerId: 'id-hytale-srv-ghost000',
          containerName: 'hytale-srv-ghost000',
          serverId: 'ghost000',
          state: 'exited',
        },
      ]);

      expect((await servers.getServer(pending.id))?.status).toBe('ready');
      expect((await servers.getServer(vanished.id))?.status).toBe('broken');
      expect((await servers.getServer(hijacked.id))?.status).toBe('broken');
      expect((await servers.getServer(recovered.id))?.status).toBe('ready');
      expect((await servers.getServer('default'))?.status).toBe('ready');
      // A changed status fires the status hooks; the add hooks ran at create time.
      expect(added).toEqual([]);
      expect(statusChanges.sort()).toEqual(
        [
          `${pending.id}:creating->ready`,
          `${vanished.id}:ready->broken`,
          `${hijacked.id}:creating->broken`,
          `${recovered.id}:broken->ready`,
        ].sort(),
      );
      expect(docker.getContainer).not.toHaveBeenCalled();
    } finally {
      unsubscribeAdded();
      unsubscribeStatus();
    }
  });

  it('keeps the user and key lists that name a server it finds again', async () => {
    fs.writeFileSync(path.join(tmpDir, 'users.json'), JSON.stringify({ users: [] }));
    const users = await import('./users.js');
    const { installServerListCleanup } = await import('./serverLists.js');
    installServerListCleanup();
    const recovered = await entry('recovered-later', 'broken');
    await users.createUser('alice', 'Sup3r-Secret-Pass!x', 'viewer', [recovered.id]);
    const docker = {
      listContainers: vi.fn(async () => [
        container(recovered.containerName, labels(recovered.id, 'kptest'), 'exited'),
      ]),
    };

    const report = await reconcile.reconcileServers(docker as never);

    expect(report.changes.filter((c) => c.serverId === recovered.id)).toEqual([
      expect.objectContaining({ from: 'broken', to: 'ready' }),
    ]);
    expect(users.allowedServersOf(await users.getUser('alice'))).toEqual([recovered.id]);
  });

  it('changes nothing a second time', async () => {
    const docker = { listContainers: vi.fn(async () => []), getContainer: vi.fn() };
    await reconcile.reconcileServers(docker as never);
    const second = await reconcile.reconcileServers(docker as never);
    expect(second.changes).toEqual([]);
  });

  it('throws and changes nothing when Docker is unreachable', async () => {
    const waiting = await entry('waiting', 'creating');
    const docker = { listContainers: vi.fn().mockRejectedValue(new Error('connect ENOENT')) };
    await expect(reconcile.reconcileServers(docker as never)).rejects.toThrow('connect ENOENT');
    expect((await servers.getServer(waiting.id))?.status).toBe('creating');
  });
});
