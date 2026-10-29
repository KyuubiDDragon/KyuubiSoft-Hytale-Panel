/**
 * Mod downloads of the stores: each store only downloads from its own hosts,
 * passes the size and hashes the store states for the file, and an update
 * removes the old file only after the new one is in place. The store APIs
 * are answered by a stubbed https module, the download itself by a stubbed
 * safeDownload that puts the file where the store asks for it (saveTo).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { serverContextIn } from '../test/serverContextStub.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-mod-downloads-')));
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
process.env.CURSEFORGE_API_KEY = 'test-key';

const { api, safeDownload, safeRequest } = vi.hoisted(() => ({
  api: new Map<string, unknown>(),
  safeDownload: vi.fn(),
  safeRequest: vi.fn(),
}));

vi.mock('https', () => {
  const request = (opts: { hostname?: string; path?: string }, cb: (res: EventEmitter) => void) => {
    const body = JSON.stringify(api.get(`${opts.hostname}${opts.path}`) ?? null);
    const res = Object.assign(new EventEmitter(), {
      statusCode: api.has(`${opts.hostname}${opts.path}`) ? 200 : 404,
      headers: {},
      resume: () => undefined,
    });
    setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    return Object.assign(new EventEmitter(), { write: () => true, end: () => undefined });
  };
  return { default: { request, get: request }, request, get: request };
});
vi.mock('../utils/safeFetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/safeFetch.js')>()),
  safeDownload,
  safeRequest,
}));

const curseforge = await import('./curseforge.js');
const modtale = await import('./modtale.js');
const stackmart = await import('./stackmart.js');
const modStore = await import('./modStore.js');

const server = serverContextIn(root);
const JAR = Buffer.from('PK\u0003\u0004 new');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  for (const dir of Object.values(server.paths)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  api.clear();
  safeDownload.mockReset();
  safeRequest.mockReset();
  curseforge.clearCurseForgeCache();
  modtale.clearModtaleCache();
  stackmart.clearStackMartCache();
});

const files = (dir: string) => fs.readdirSync(dir).sort();
const optionsOf = (call: number) => safeDownload.mock.calls[call][1];
const delivers = (content: Buffer) => async (_url: string, opts: { saveTo: string }) => {
  fs.writeFileSync(opts.saveTo, content);
  return { size: content.length };
};

describe('CurseForge', () => {
  const file = {
    id: 77,
    fileName: 'Evil-2.0.jar',
    displayName: '2.0',
    releaseType: 1,
    fileLength: JAR.length,
    hashes: [
      { value: 'AABBCC', algo: 1 },
      { value: 'md5value', algo: 2 },
    ],
    downloadUrl: 'https://edge.forgecdn.net/files/77/Evil-2.0.jar',
    gameVersions: [],
  };
  const installedAs = (filename: string) =>
    fs.writeFileSync(
      path.join(server.paths.data, 'curseforge-installed.json'),
      JSON.stringify({ mods: { '4242': { modId: 4242, filename, version: '1.0' } } }),
    );

  beforeEach(() => {
    api.set('api.curseforge.com/v1/mods/4242', {
      data: { id: 4242, name: 'Evil', allowModDistribution: true, latestFiles: [file] },
    });
    fs.writeFileSync(path.join(server.paths.mods, 'Evil-1.0.jar'), 'OLD');
    installedAs('Evil-1.0.jar');
  });

  it('downloads from the CurseForge CDN and checks size and SHA-1', async () => {
    safeDownload.mockImplementation(delivers(JAR));
    const result = await curseforge.installModFromCurseForge(server, 4242);

    expect(result.success).toBe(true);
    expect(safeDownload.mock.calls[0][0]).toBe(file.downloadUrl);
    expect(optionsOf(0).allowedHosts).toEqual(['forgecdn.net', 'curseforge.com']);
    expect(optionsOf(0).expected).toEqual({ size: JAR.length, sha1: 'AABBCC' });
    expect(optionsOf(0).saveTo).toBe(path.join(server.paths.mods, 'Evil-2.0.jar'));
    expect(files(server.paths.mods)).toEqual(['Evil-2.0.jar']);
  });

  it('keeps the old version when the download fails', async () => {
    safeDownload.mockRejectedValue(new Error('checksum mismatch'));
    const result = await curseforge.installModFromCurseForge(server, 4242);

    expect(result.success).toBe(false);
    expect(files(server.paths.mods)).toEqual(['Evil-1.0.jar']);
  });

  it('keeps the new file when the update has the same file name', async () => {
    installedAs('Evil-2.0.jar');
    fs.renameSync(
      path.join(server.paths.mods, 'Evil-1.0.jar'),
      path.join(server.paths.mods, 'Evil-2.0.jar'),
    );
    safeDownload.mockImplementation(delivers(JAR));

    expect((await curseforge.installModFromCurseForge(server, 4242)).success).toBe(true);
    expect(fs.readFileSync(path.join(server.paths.mods, 'Evil-2.0.jar'))).toEqual(JAR);
  });
});

describe('Modtale', () => {
  beforeEach(() => {
    api.set('api.modtale.net/api/v1/projects/p1', {
      id: 'p1',
      title: 'Tool',
      classification: 'PLUGIN',
      versions: [
        {
          id: 'v2',
          versionNumber: '2.0',
          fileUrl: 'https://cdn.modtale.net/files/plugin/tool-2.jar',
          channel: 'RELEASE',
        },
      ],
    });
    fs.writeFileSync(path.join(server.paths.mods, 'Tool-1.0.jar'), 'OLD');
    fs.writeFileSync(
      path.join(server.paths.data, 'modtale-installed.json'),
      JSON.stringify({
        mods: {
          p1: {
            projectId: 'p1',
            filename: 'Tool-1.0.jar',
            classification: 'PLUGIN',
            version: '1.0',
          },
        },
      }),
    );
  });

  it('downloads only from Modtale hosts and replaces the old version afterwards', async () => {
    safeDownload.mockImplementation(delivers(JAR));
    expect((await modtale.installModFromModtale(server, 'p1')).success).toBe(true);
    expect(optionsOf(0).allowedHosts).toEqual(['modtale.net']);
    expect(files(server.paths.mods)).toEqual(['Tool-2.0.jar']);
  });

  it('keeps the old version when the download fails', async () => {
    safeDownload.mockRejectedValue(new Error('host not allowed'));
    expect((await modtale.installModFromModtale(server, 'p1')).success).toBe(false);
    expect(files(server.paths.mods)).toEqual(['Tool-1.0.jar']);
  });
});

describe('StackMart', () => {
  it('starts the download on StackMart and keeps the old version on failure', async () => {
    safeRequest.mockResolvedValue({
      status: 200,
      headers: {},
      url: 'https://stackmart.org/api/public/resources/r1',
      truncated: false,
      body: Buffer.from(
        JSON.stringify({
          resource: {
            id: 'r1',
            name: 'Res',
            version: '2.0',
            category: 'mods',
            downloadUrl: '/download/r1',
          },
        }),
      ),
    });
    fs.writeFileSync(path.join(server.paths.mods, 'Res-1.0.jar'), 'OLD');
    fs.writeFileSync(
      path.join(server.paths.data, 'stackmart-installed.json'),
      JSON.stringify({
        resources: { r1: { resourceId: 'r1', filename: 'Res-1.0.jar', category: 'mods' } },
      }),
    );
    safeDownload.mockRejectedValue(new Error('timeout'));

    expect((await stackmart.installResourceFromStackMart(server, 'r1')).success).toBe(false);
    expect(safeDownload.mock.calls[0][0]).toBe('https://stackmart.org/download/r1');
    expect(optionsOf(0).allowedHosts).toEqual(['stackmart.org']);
    expect(files(server.paths.mods)).toEqual(['Res-1.0.jar']);
    expect(safeRequest.mock.calls[0][1].allowedHosts).toEqual(['stackmart.org']);
  });
});

describe('Mod store (GitHub releases)', () => {
  it('checks the size and SHA-256 GitHub states for the asset', async () => {
    const sha256 = 'ab'.repeat(32);
    safeRequest.mockImplementation(async (url: string) => ({
      status: url.includes('api.github.com') ? 200 : 404,
      headers: {},
      url,
      truncated: false,
      body: Buffer.from(
        JSON.stringify({
          tag_name: 'v1.0.22',
          assets: [
            {
              name: 'EasyWebMap-v1.0.22.jar',
              size: JAR.length,
              digest: `sha256:${sha256}`,
              browser_download_url:
                'https://github.com/cryptobench/EasyWebMap/releases/download/v1.0.22/EasyWebMap-v1.0.22.jar',
            },
          ],
        }),
      ),
    }));
    safeDownload.mockImplementation(delivers(JAR));

    const result = await modStore.installMod(server, 'easywebmap');

    expect(result.success).toBe(true);
    expect(optionsOf(0).allowedHosts).toEqual(['github.com', 'githubusercontent.com']);
    expect(optionsOf(0).expected).toEqual({ size: JAR.length, sha256 });
    expect(files(server.paths.mods)).toContain('EasyWebMap-v1.0.22.jar');
  });
});
