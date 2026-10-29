/**
 * Installing the bundled KyuubiSoft API plugin: the panel ships exactly one
 * plugin jar, built as the version the panel expects, and installing puts a
 * byte-identical copy of it into the server's mods folder in place of older
 * versions.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const modsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-plugin-install-'));

const ensurePluginAuthConfig = vi.fn(async (_id?: string) => ({ ok: true, changed: true }));
vi.mock('./servers.js', () => ({
  getDefaultId: async () => 'default',
  getServer: async (id: string) => ({ id, paths: { mods: modsDir } }),
  resolveServerId: async (id?: string) => id ?? 'default',
}));
vi.mock('./pluginAuth.js', () => ({
  ensurePluginAuthConfig: (id?: string) => ensurePluginAuthConfig(id),
  getPluginToken: async () => 'test-token',
}));
vi.mock('./demoData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./demoData.js')>()),
  isDemoMode: () => false,
}));

const api = await import('./kyuubiApi.js');

const assetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'plugins',
);

afterAll(() => {
  fs.rmSync(modsDir, { recursive: true, force: true });
});

const sha256 = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** One file of a jar (a zip): the central directory gives its local entry. */
function readJarEntry(jar: Buffer, name: string): Buffer | null {
  const eocd = jar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  let at = jar.readUInt32LE(eocd + 16);
  const count = jar.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const nameLength = jar.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + jar.readUInt16LE(at + 30) + jar.readUInt16LE(at + 32);
    if (jar.toString('utf-8', at + 46, at + 46 + nameLength) === name) {
      const method = jar.readUInt16LE(at + 10);
      const size = jar.readUInt32LE(at + 20);
      const local = jar.readUInt32LE(at + 42);
      const start = local + 30 + jar.readUInt16LE(local + 26) + jar.readUInt16LE(local + 28);
      const data = jar.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    }
    at = next;
  }
  return null;
}

describe('the bundled plugin jar', () => {
  it('is the one jar in the assets, named and built as the version the panel expects', () => {
    expect(api.PLUGIN_JAR_NAME).toBe(`KyuubiSoftAPI-${api.PLUGIN_VERSION}.jar`);
    const jars = fs
      .readdirSync(assetsDir)
      .filter((f) => f.toLowerCase().startsWith('kyuubisoftapi'));
    expect(jars).toEqual([api.PLUGIN_JAR_NAME]);
    const bundled = api.getBundledPluginPath();
    expect(path.resolve(bundled)).toBe(path.join(assetsDir, api.PLUGIN_JAR_NAME));
    const jar = fs.readFileSync(bundled);
    const manifest = readJarEntry(jar, 'manifest.json');
    expect(manifest).not.toBeNull();
    expect(JSON.parse(manifest!.toString('utf-8'))).toMatchObject({
      Name: 'KyuubiSoftAPI',
      Version: api.PLUGIN_VERSION,
    });
    // The version compiled into the plugin's main class, not only the manifest.
    const main = readJarEntry(jar, 'com/kyuubisoft/api/KyuubiSoftAPI.class');
    expect(main).not.toBeNull();
    expect(main!.includes(Buffer.from(api.PLUGIN_VERSION, 'utf-8'))).toBe(true);
  });

  it('replaces older versions in the mods folder with an exact copy and writes the token config', async () => {
    fs.writeFileSync(path.join(modsDir, 'KyuubiSoftAPI-2.1.0.jar'), 'old');
    fs.writeFileSync(path.join(modsDir, 'kyuubisoftapi-1.4.0.jar'), 'older');
    fs.writeFileSync(path.join(modsDir, 'OtherMod-1.0.0.jar'), 'keep');
    expect(await api.installPlugin()).toEqual({ success: true });
    expect(fs.readdirSync(modsDir).sort()).toEqual(
      [api.PLUGIN_JAR_NAME, 'OtherMod-1.0.0.jar'].sort(),
    );
    expect(sha256(path.join(modsDir, api.PLUGIN_JAR_NAME))).toBe(
      sha256(api.getBundledPluginPath()),
    );
    expect(ensurePluginAuthConfig).toHaveBeenCalledTimes(1);
    expect(await api.getInstalledVersion()).toBe(api.PLUGIN_VERSION);
  });
});
