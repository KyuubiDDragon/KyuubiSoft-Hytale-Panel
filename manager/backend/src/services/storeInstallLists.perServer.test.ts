/**
 * Every server has its own install lists (Modtale, StackMart, CurseForge,
 * CFWidget), kept in its data folder. The lists of the compose server stay
 * where single-server panels always kept them, so an existing list belongs to
 * it without being moved. Only local operations here: no network.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config.js';
import { contextFromServer, type ServerContext } from './serverContext.js';
import { getServer } from './servers.js';
import { serverContextIn } from '../test/serverContextStub.js';
import { getInstalledModtaleInfo, uninstallModtale } from './modtale.js';
import { getInstalledStackMartInfo, uninstallStackMart } from './stackmart.js';
import { getInstalledCurseForgeInfo, uninstallCurseForge } from './curseforge.js';
import { getUpdateStatus, uninstallTrackedMod } from './cfwidget.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-install-lists-'));
const a = serverContextIn(path.join(base, 'a'), 'default');
const b = serverContextIn(path.join(base, 'b'), 'srv-b');

const listFile = (ctx: ServerContext, name: string) => path.join(ctx.paths.data, name);
const writeList = (ctx: ServerContext, name: string, data: unknown) =>
  fs.writeFileSync(listFile(ctx, name), JSON.stringify(data));
const readList = (ctx: ServerContext, name: string) =>
  JSON.parse(fs.readFileSync(listFile(ctx, name), 'utf-8'));

beforeEach(() => {
  for (const ctx of [a, b]) {
    fs.rmSync(path.dirname(ctx.paths.data), { recursive: true, force: true });
    for (const dir of ['mods', 'plugins', 'data'] as const) {
      fs.mkdirSync(ctx.paths[dir], { recursive: true });
    }
  }
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('install lists per server', () => {
  it('keeps the lists of the compose server where they always were', async () => {
    const compose = contextFromServer((await getServer('default'))!);
    expect(compose.paths.data).toBe(config.dataPath);
    fs.mkdirSync(config.dataPath, { recursive: true });
    const legacyList = path.join(config.dataPath, 'modtale-installed.json');
    fs.writeFileSync(
      legacyList,
      JSON.stringify({ mods: { p1: { projectId: 'p1', filename: 'Old.jar' } } }),
    );
    const before = fs.readFileSync(legacyList);

    // Read twice: nothing is moved or rewritten, the compose server owns it as is.
    expect(Object.keys(await getInstalledModtaleInfo(compose))).toEqual(['p1']);
    expect(Object.keys(await getInstalledModtaleInfo(compose))).toEqual(['p1']);
    expect(fs.readFileSync(legacyList)).toEqual(before);
    expect(await getInstalledModtaleInfo(b)).toEqual({});
  });

  it('Modtale: uninstalling on B leaves the file and list of A alone', async () => {
    const list = { mods: { p1: { projectId: 'p1', filename: 'M.jar', classification: 'PLUGIN' } } };
    for (const ctx of [a, b]) {
      fs.writeFileSync(path.join(ctx.paths.mods, 'M.jar'), 'jar');
      writeList(ctx, 'modtale-installed.json', list);
    }

    expect(await uninstallModtale(b, 'p1')).toEqual({ success: true });

    expect(fs.existsSync(path.join(b.paths.mods, 'M.jar'))).toBe(false);
    expect(readList(b, 'modtale-installed.json').mods).toEqual({});
    expect(fs.existsSync(path.join(a.paths.mods, 'M.jar'))).toBe(true);
    expect(Object.keys(await getInstalledModtaleInfo(a))).toEqual(['p1']);
  });

  it('StackMart: a plugin resource is removed from the plugins folder of B only', async () => {
    const list = {
      resources: { r1: { resourceId: 'r1', filename: 'P.jar', category: 'plugins' } },
    };
    for (const ctx of [a, b]) {
      fs.writeFileSync(path.join(ctx.paths.plugins, 'P.jar'), 'jar');
      writeList(ctx, 'stackmart-installed.json', list);
    }

    expect(await uninstallStackMart(b, 'r1')).toEqual({ success: true });

    expect(fs.existsSync(path.join(b.paths.plugins, 'P.jar'))).toBe(false);
    expect(await getInstalledStackMartInfo(b)).toEqual({});
    expect(fs.existsSync(path.join(a.paths.plugins, 'P.jar'))).toBe(true);
    expect(Object.keys(await getInstalledStackMartInfo(a))).toEqual(['r1']);
  });

  it('CurseForge: uninstalling on B also untracks the CFWidget entry of B only', async () => {
    const cf = { mods: { '42': { modId: 42, modName: 'C', filename: 'C.jar', fileId: 1 } } };
    const tracked = {
      mods: {
        'C.jar': {
          filename: 'C.jar',
          curseforgeSlug: 'c',
          hasUpdate: false,
          lastChecked: '',
          installed: true,
        },
      },
      lastGlobalCheck: null,
    };
    for (const ctx of [a, b]) {
      fs.writeFileSync(path.join(ctx.paths.mods, 'C.jar'), 'jar');
      writeList(ctx, 'curseforge-installed.json', cf);
      writeList(ctx, 'cfwidget-tracked.json', tracked);
    }

    expect(await uninstallCurseForge(b, 42)).toEqual({ success: true });

    expect(fs.existsSync(path.join(b.paths.mods, 'C.jar'))).toBe(false);
    expect(await getInstalledCurseForgeInfo(b)).toEqual({});
    expect((await getUpdateStatus(b)).mods).toEqual([]);
    expect(fs.existsSync(path.join(a.paths.mods, 'C.jar'))).toBe(true);
    expect(Object.keys(await getInstalledCurseForgeInfo(a))).toEqual(['42']);
    expect((await getUpdateStatus(a)).mods.map((m) => m.filename)).toEqual(['C.jar']);
  });

  it('CFWidget: a tracked mod of B is uninstalled in B', async () => {
    const tracked = {
      mods: {
        'T.jar': {
          filename: 'T.jar',
          curseforgeSlug: 't',
          hasUpdate: false,
          lastChecked: '',
          installed: true,
        },
      },
      lastGlobalCheck: null,
    };
    for (const ctx of [a, b]) {
      fs.writeFileSync(path.join(ctx.paths.mods, 'T.jar'), 'jar');
      writeList(ctx, 'cfwidget-tracked.json', tracked);
    }

    expect(await uninstallTrackedMod(b, 'T.jar')).toEqual({ success: true });

    expect(fs.existsSync(path.join(b.paths.mods, 'T.jar'))).toBe(false);
    expect(fs.existsSync(path.join(a.paths.mods, 'T.jar'))).toBe(true);
    expect((await getUpdateStatus(a)).totalTracked).toBe(1);
  });
});
