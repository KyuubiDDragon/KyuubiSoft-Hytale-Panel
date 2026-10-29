/**
 * Instance folders on disk: created as the panel's user before Docker would
 * create them as root, moved to the trash instead of deleted, and only gone
 * for good after an explicit purge of one trash entry.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-idata-'));
const instancesRoot = path.join(tmpDir, 'instances');
fs.mkdirSync(instancesRoot);
process.env.MANAGER_DATA_PATH = path.join(tmpDir, 'manager');
process.env.INSTANCES_PATH = instancesRoot;
process.env.HOST_DATA_PATH = '/srv/hytale';
delete process.env.DEMO_MODE;

// Whether INSTANCES_ROOT is mounted is a property of the manager container;
// here it is a switch.
const mount = vi.hoisted(() => ({ present: true }));
vi.mock('./serverContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./serverContext.js')>()),
  isInstancesMountPresent: () => mount.present,
}));

import type * as InstanceDataModule from './instanceData.js';
import type { ServerInstance } from './servers.js';

let data: typeof InstanceDataModule;
beforeAll(async () => {
  data = await import('./instanceData.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mount.present = true;
});

/** Remove a link (Windows junctions only go with rmdir) without touching its target. */
function removeLink(link: string): void {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return;
  } catch {
    return;
  }
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link);
  }
}

let counter = 0;
function makeInstance(overrides: Partial<ServerInstance> = {}): ServerInstance {
  const id = `inst${String(++counter).padStart(4, '0')}`;
  const root = path.join(instancesRoot, id);
  return {
    id,
    name: `Server ${id}`,
    containerName: `hytale-srv-${id}`,
    status: 'ready',
    network: { serverPort: 5521, webMapPort: 18081, webMapWsPort: 18082, publishWebMap: false },
    paths: {
      server: path.join(root, 'server'),
      data: path.join(root, 'data'),
      backups: path.join(root, 'backups'),
      mods: path.join(root, 'mods'),
      plugins: path.join(root, 'plugins'),
      assets: path.join(root, 'assets'),
      auth: path.join(root, 'auth'),
    },
    hostRoot: `/srv/hytale/instances/${id}`,
    createdAt: '2026-10-28T00:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

describe('prepareInstanceDirs', () => {
  it('creates every bound folder of the instance', async () => {
    const instance = makeInstance();
    expect(await data.prepareInstanceDirs(instance)).toBeNull();
    for (const dir of ['server', 'data', 'prefabs', 'downloader', 'updater', 'auth']) {
      expect(fs.statSync(path.join(instancesRoot, instance.id, dir)).isDirectory()).toBe(true);
    }
  });

  it('only warns while the instances folder is not mounted', async () => {
    mount.present = false;
    const instance = makeInstance();
    expect(await data.prepareInstanceDirs(instance)).toMatch(/is not mounted/);
    expect(fs.existsSync(path.join(instancesRoot, instance.id))).toBe(false);
  });

  it('leaves the compose server alone', async () => {
    expect(await data.prepareInstanceDirs(makeInstance({ id: 'default' }))).toBeNull();
  });
});

describe('moveInstanceToTrash', () => {
  it('moves the instance folder into the trash and keeps its content', async () => {
    const instance = makeInstance();
    await data.prepareInstanceDirs(instance);
    fs.writeFileSync(path.join(instance.paths.data, 'world.dat'), 'keep me');

    const result = await data.moveInstanceToTrash(instance);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.entry) throw new Error('not moved');
    expect(result.entry).toMatch(new RegExp(`^${instance.id}-\\d{4}-\\d{2}-\\d{2}T`));
    expect(result.hostPath).toBe(`/srv/hytale/instances/.trash/${result.entry}`);
    expect(fs.existsSync(path.join(instancesRoot, instance.id))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(instancesRoot, '.trash', result.entry, 'data', 'world.dat'),
        'utf-8',
      ),
    ).toBe('keep me');
  });

  it('moves nothing when the folder never existed', async () => {
    expect(await data.moveInstanceToTrash(makeInstance())).toEqual({
      ok: true,
      entry: null,
      hostPath: null,
    });
  });

  it('refuses folders outside the panel layout and the compose server', async () => {
    const outside = makeInstance();
    const custom = {
      ...outside,
      paths: { ...outside.paths, data: path.join(tmpDir, 'elsewhere') },
    };
    expect(await data.moveInstanceToTrash(custom)).toMatchObject({ ok: false, code: 'layout' });
    expect(await data.checkInstanceDataMovable(makeInstance({ id: 'default' }))).toMatchObject({
      ok: false,
      code: 'layout',
    });
  });

  it('refuses while the instances folder is not mounted', async () => {
    mount.present = false;
    expect(await data.moveInstanceToTrash(makeInstance())).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
  });

  it('never follows a link in place of the instance folder', async () => {
    const instance = makeInstance();
    const target = fs.mkdtempSync(path.join(tmpDir, 'link-target-'));
    try {
      fs.symlinkSync(target, path.join(instancesRoot, instance.id), 'junction');
    } catch {
      return; // no link support on this file system
    }
    expect(await data.moveInstanceToTrash(instance)).toMatchObject({ ok: false, code: 'layout' });
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('trash listing and purge', () => {
  async function trashed(): Promise<string> {
    const instance = makeInstance();
    await data.prepareInstanceDirs(instance);
    const result = await data.moveInstanceToTrash(instance);
    if (!result.ok || !result.entry) throw new Error('not moved');
    return result.entry;
  }

  it('lists trash entries with server id and time', async () => {
    const entry = await trashed();
    fs.mkdirSync(path.join(instancesRoot, '.trash', 'not-an-entry'));
    const entries = await data.listInstanceTrash();
    const found = entries.find((e) => e.name === entry);
    expect(found).toBeDefined();
    expect(found!.serverId).toBe(entry.split('-')[0]);
    expect(Number.isNaN(Date.parse(found!.deletedAt))).toBe(false);
    expect(entries.some((e) => e.name === 'not-an-entry')).toBe(false);
  });

  it('deletes exactly one entry on purge', async () => {
    const keep = await trashed();
    const purge = await trashed();
    expect(await data.purgeInstanceTrashEntry(purge)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(instancesRoot, '.trash', purge))).toBe(false);
    expect(fs.existsSync(path.join(instancesRoot, '.trash', keep))).toBe(true);
    expect(await data.purgeInstanceTrashEntry(purge)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('refuses names that are no trash entry', async () => {
    for (const name of ['..', '../instances', 'abc', 'x-2026-10-28T00-00-00-000Z/../..']) {
      expect(await data.purgeInstanceTrashEntry(name)).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    }
    expect(fs.existsSync(instancesRoot)).toBe(true);
  });

  it('never moves into or purges from a trash folder that is a link', async () => {
    const entry = await trashed();
    const realTrash = path.join(instancesRoot, '.trash');
    const parked = path.join(tmpDir, 'parked-trash');
    const elsewhere = fs.mkdtempSync(path.join(tmpDir, 'elsewhere-'));
    fs.mkdirSync(path.join(elsewhere, entry));
    fs.renameSync(realTrash, parked);
    try {
      try {
        fs.symlinkSync(elsewhere, realTrash, 'junction');
      } catch {
        return; // no link support on this file system
      }
      const instance = makeInstance();
      await data.prepareInstanceDirs(instance);
      expect(await data.moveInstanceToTrash(instance)).toMatchObject({ ok: false, code: 'layout' });
      expect(fs.existsSync(path.join(instancesRoot, instance.id))).toBe(true);
      expect(await data.purgeInstanceTrashEntry(entry)).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      expect(fs.existsSync(path.join(elsewhere, entry))).toBe(true);
      expect(await data.listInstanceTrash()).toEqual([]);
    } finally {
      removeLink(realTrash);
      fs.renameSync(parked, realTrash);
    }
  });

  it('lists nothing and purges nothing while the instances folder is not mounted', async () => {
    const entry = await trashed();
    mount.present = false;
    expect(await data.listInstanceTrash()).toEqual([]);
    expect(await data.purgeInstanceTrashEntry(entry)).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
  });
});

describe('getServerFilesState', () => {
  it('reports missing game files and present ones', async () => {
    const instance = makeInstance();
    await data.prepareInstanceDirs(instance);
    expect(await data.getServerFilesState(instance)).toBe('missing');
    fs.writeFileSync(path.join(instance.paths.server, 'HytaleServer.jar'), '');
    expect(await data.getServerFilesState(instance)).toBe('missing');
    fs.writeFileSync(path.join(instance.paths.server, 'Assets.zip'), '');
    expect(await data.getServerFilesState(instance)).toBe('present');
  });
});

describe('readPanelJavaMaxRam', () => {
  it("reads the heap from the server's own panel-config.json", async () => {
    const instance = makeInstance();
    await data.prepareInstanceDirs(instance);
    expect(await data.readPanelJavaMaxRam(instance)).toBeUndefined();
    fs.writeFileSync(path.join(instance.paths.data, 'panel-config.json'), '{"javaMaxRam":"5G"}');
    expect(await data.readPanelJavaMaxRam(instance)).toBe('5G');
    fs.writeFileSync(path.join(instance.paths.data, 'panel-config.json'), '{broken');
    expect(await data.readPanelJavaMaxRam(instance)).toBeUndefined();
  });
});
