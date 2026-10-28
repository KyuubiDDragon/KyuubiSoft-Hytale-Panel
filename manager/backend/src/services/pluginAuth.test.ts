import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Route MANAGER_DATA_PATH to a temp dir before the modules capture it.
const tmpDir = path.join(os.tmpdir(), `kp-pluginauth-${Date.now()}`);
const serverDir = path.join(tmpDir, 'srv-default');
const modsDir = path.join(tmpDir, 'mods-default');
const linkedServerDir = path.join(tmpDir, 'srv-linked');
const linkedModsDir = path.join(tmpDir, 'mods-linked');
const legacyServerDir = path.join(tmpDir, 'srv-legacy');
const legacyModsDir = path.join(tmpDir, 'mods-legacy');
const oldJarServerDir = path.join(tmpDir, 'srv-oldjar');
const oldJarModsDir = path.join(tmpDir, 'mods-oldjar');
for (const dir of [
  serverDir,
  modsDir,
  linkedServerDir,
  linkedModsDir,
  legacyServerDir,
  legacyModsDir,
  oldJarServerDir,
  oldJarModsDir,
]) {
  fs.mkdirSync(dir, { recursive: true });
}
// Creating symlinks needs extra rights on Windows; the CI/containers run Linux.
const noSymlinks = process.platform === 'win32';
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const DATA_DIR = 'KyuubiDDragon_KyuubiSoftAPI';

function serverEntry(id: string, server: string, mods: string, pluginPort: number) {
  return {
    id,
    name: id,
    containerName: `hytale-${id}`,
    status: 'ready',
    network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort },
    paths: {
      server,
      data: `/tmp/d-${id}`,
      backups: `/tmp/b-${id}`,
      mods,
      plugins: `/tmp/p-${id}`,
      assets: `/tmp/a-${id}`,
      auth: `/tmp/au-${id}`,
    },
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  };
}

const seed = {
  schemaVersion: 1,
  defaultId: 'default',
  servers: [
    serverEntry('default', serverDir, modsDir, 18085),
    // Instance dirs live outside the manager container: not reachable here.
    serverEntry(
      'unmounted',
      path.join(tmpDir, 'does-not-exist', 'server'),
      path.join(tmpDir, 'does-not-exist', 'mods'),
      18086,
    ),
    // Its plugin data dir gets replaced by a symlink in a test below.
    serverEntry('linked', linkedServerDir, linkedModsDir, 18089),
    // Still has the config of a 2.0 plugin.
    serverEntry('legacy', legacyServerDir, legacyModsDir, 18090),
    // Runs a 2.0.0 jar that has not created its config yet.
    serverEntry('oldjar', oldJarServerDir, oldJarModsDir, 18091),
  ],
};
fs.writeFileSync(path.join(tmpDir, 'servers.json'), JSON.stringify(seed));

type PluginAuth = typeof import('./pluginAuth.js');
let auth: PluginAuth;

beforeAll(async () => {
  auth = await import('./pluginAuth.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

function legacyFile(dir: string): string {
  return path.join(dir, 'config', 'kyuubisoft-api', 'config.json');
}

function dataDirFile(dir: string): string {
  return path.join(dir, DATA_DIR, 'config.json');
}

describe('plugin token store', () => {
  it('generates 32 random bytes as hex', () => {
    const a = auth.generatePluginToken();
    const b = auth.generatePluginToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('issues one token per server and persists it in plugin-tokens.json', async () => {
    const first = await auth.getPluginToken('store-a');
    expect(await auth.getPluginToken('store-a')).toBe(first);
    expect(await auth.getPluginToken('store-b')).not.toBe(first);

    const file = readJson(path.join(tmpDir, 'plugin-tokens.json')) as {
      tokens: Record<string, string>;
    };
    expect(file.tokens['store-a']).toBe(first);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(tmpDir, 'plugin-tokens.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the token across a panel restart (fresh module, same file)', async () => {
    const before = await auth.getPluginToken('restart-me');
    vi.resetModules();
    const reloaded: PluginAuth = await import('./pluginAuth.js');
    expect(await reloaded.getPluginToken('restart-me')).toBe(before);
  });

  it('hands concurrent first callers the same token', async () => {
    const tokens = await Promise.all(Array.from({ length: 5 }, () => auth.getPluginToken('race')));
    expect(new Set(tokens).size).toBe(1);
  });

  it('never puts the token into servers.json', async () => {
    const token = await auth.getPluginToken('default');
    expect(fs.readFileSync(path.join(tmpDir, 'servers.json'), 'utf-8')).not.toContain(token);
  });

  it('deletes a server token', async () => {
    const old = await auth.getPluginToken('gone');
    await auth.deletePluginToken('gone');
    const file = readJson(path.join(tmpDir, 'plugin-tokens.json')) as {
      tokens: Record<string, string>;
    };
    expect(file.tokens.gone).toBeUndefined();
    expect(await auth.getPluginToken('gone')).not.toBe(old);
  });
});

describe('config locations', () => {
  it('puts the 2.1 config into the plugin data dir below mods', () => {
    expect(auth.pluginConfigPath('/opt/hytale/mods')).toBe(
      path.join('/opt/hytale/mods', DATA_DIR, 'config.json'),
    );
    expect(auth.legacyPluginConfigPath('/opt/hytale/server')).toBe(
      path.join('/opt/hytale/server', 'config', 'kyuubisoft-api', 'config.json'),
    );
  });

  it('reads the version from the jar name', () => {
    expect(auth.pluginJarVersion('KyuubiSoftAPI-2.1.0.jar')).toEqual([2, 1, 0]);
    expect(auth.pluginJarVersion('kyuubisoftapi-1.4.3.jar')).toEqual([1, 4, 3]);
    expect(auth.pluginJarVersion('KyuubiSoftAPI.jar')).toBeNull();
  });

  it('needs the old config only for jars older than 2.1.0', () => {
    expect(auth.needsLegacyConfig(['KyuubiSoftAPI-2.1.0.jar', 'Other.jar'])).toBe(false);
    expect(auth.needsLegacyConfig(['KyuubiSoftAPI-2.1.1.jar'])).toBe(false);
    expect(auth.needsLegacyConfig(['KyuubiSoftAPI-2.10.0.jar'])).toBe(false);
    expect(auth.needsLegacyConfig(['KyuubiSoftAPI-3.0.0.jar'])).toBe(false);
    expect(auth.needsLegacyConfig(['KyuubiSoftAPI-2.0.0.jar'])).toBe(true);
    expect(auth.needsLegacyConfig(['kyuubisoftapi-1.4.3.jar'])).toBe(true);
    // Unknown version: keep the old path alive to be safe.
    expect(auth.needsLegacyConfig(['KyuubiSoftAPI.jar'])).toBe(true);
    // Disabled jars and plain folders do not count.
    expect(auth.needsLegacyConfig(['KyuubiSoftAPI-2.0.0.jar.disabled', DATA_DIR])).toBe(false);
  });
});

describe('writePluginAuthConfig', () => {
  const token = 'a'.repeat(64);

  /** Fresh mods dir; optionally with an existing plugin config. */
  function newMods(name: string, configContent?: string): { dir: string; file: string } {
    const dir = path.join(tmpDir, name);
    const file = dataDirFile(dir);
    fs.mkdirSync(dir, { recursive: true });
    if (configContent !== undefined) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, configContent);
    }
    return { dir, file };
  }

  it('creates the plugin config when none exists', async () => {
    const { dir, file } = newMods('cfg-new');
    expect(await auth.writePluginAuthConfig(dir, token)).toEqual({ changed: true });
    expect(readJson(file)).toEqual({ authEnabled: true, authToken: token });
  });

  it('starts a new config from the seed (keys of the old config)', async () => {
    const { dir, file } = newMods('cfg-seed');
    await auth.writePluginAuthConfig(dir, token, { httpPort: 18099, authToken: 'old' });
    expect(readJson(file)).toEqual({ httpPort: 18099, authEnabled: true, authToken: token });
  });

  it('ignores the seed when the config already exists', async () => {
    const { dir, file } = newMods('cfg-seed-existing', JSON.stringify({ httpPort: 18100 }));
    await auth.writePluginAuthConfig(dir, token, { httpPort: 18099 });
    expect(readJson(file)).toEqual({ httpPort: 18100, authEnabled: true, authToken: token });
  });

  it('keeps every other key the operator set', async () => {
    const { dir, file } = newMods(
      'cfg-keep',
      JSON.stringify({
        httpPort: 18099,
        authEnabled: false,
        authToken: '',
        corsAllowedOrigins: ['https://panel.example.com'],
        positionBroadcastIntervalMs: 0,
      }),
    );

    await auth.writePluginAuthConfig(dir, token);

    expect(readJson(file)).toEqual({
      httpPort: 18099,
      authEnabled: true,
      authToken: token,
      corsAllowedOrigins: ['https://panel.example.com'],
      positionBroadcastIntervalMs: 0,
    });
  });

  it('keeps an explicit insecureDisableAuth but warns about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dir, file } = newMods('cfg-insecure', JSON.stringify({ insecureDisableAuth: true }));

    await auth.writePluginAuthConfig(dir, token);

    expect(readJson(file)).toEqual({
      insecureDisableAuth: true,
      authEnabled: true,
      authToken: token,
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('insecureDisableAuth'))).toBe(true);
  });

  it('leaves an up-to-date file untouched', async () => {
    const { dir, file } = newMods('cfg-same');
    await auth.writePluginAuthConfig(dir, token);
    const mtime = fs.statSync(file).mtimeMs;
    expect(await auth.writePluginAuthConfig(dir, token)).toEqual({ changed: false });
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('replaces a broken file and keeps its copy in the panel volume, not in the server dir', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = '{ "httpPort": 18085, "authToken": "old-token-old-token", ';
    const { dir, file } = newMods('cfg-broken', broken);

    expect(await auth.writePluginAuthConfig(dir, token)).toEqual({ changed: true });

    expect(readJson(file)).toEqual({ authEnabled: true, authToken: token });
    // Nothing that could hold the old token stays next to the config.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['config.json']);
    const backupDir = path.join(tmpDir, 'plugin-config-backups');
    const copies = fs.readdirSync(backupDir).filter((f) => f.startsWith('config.json.corrupt-'));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, copies[0]), 'utf-8')).toBe(broken);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(backupDir, copies[0])).mode & 0o777).toBe(0o600);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses when a path segment is not a directory', async () => {
    const { dir } = newMods('cfg-notdir');
    fs.writeFileSync(path.join(dir, DATA_DIR), 'not a directory');
    await expect(auth.writePluginAuthConfig(dir, token)).rejects.toBeInstanceOf(
      auth.UnsafePluginConfigPathError,
    );
  });

  it('writes the pre-2.1 config for old plugins', async () => {
    const dir = path.join(tmpDir, 'cfg-legacy-write');
    fs.mkdirSync(dir, { recursive: true });
    expect(await auth.writeLegacyPluginAuthConfig(dir, token)).toEqual({ changed: true });
    expect(readJson(legacyFile(dir))).toEqual({ authEnabled: true, authToken: token });
  });

  it.skipIf(noSymlinks)(
    'refuses a data dir symlinked out of the mods dir and writes nothing there',
    async () => {
      const { dir } = newMods('cfg-link-out');
      const outside = path.join(tmpDir, 'outside-config');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(dir, DATA_DIR), 'dir');

      await expect(auth.writePluginAuthConfig(dir, token)).rejects.toBeInstanceOf(
        auth.UnsafePluginConfigPathError,
      );
      expect(fs.readdirSync(outside)).toEqual([]);
    },
  );

  it.skipIf(noSymlinks)(
    'refuses a symlinked data dir even when it stays inside the mods dir',
    async () => {
      const { dir } = newMods('cfg-link-in');
      fs.mkdirSync(path.join(dir, 'elsewhere'), { recursive: true });
      fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, DATA_DIR), 'dir');

      await expect(auth.writePluginAuthConfig(dir, token)).rejects.toBeInstanceOf(
        auth.UnsafePluginConfigPathError,
      );
      expect(fs.readdirSync(path.join(dir, 'elsewhere'))).toEqual([]);
    },
  );

  it.skipIf(noSymlinks)(
    'neither reads nor replaces a secret the config file is linked to',
    async () => {
      const { dir, file } = newMods('cfg-link-file');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const secret = path.join(tmpDir, 'panel-secret.json');
      fs.writeFileSync(secret, JSON.stringify({ passwordHash: 'x' }));
      fs.symlinkSync(secret, file, 'file');

      await expect(auth.writePluginAuthConfig(dir, token)).rejects.toBeInstanceOf(
        auth.UnsafePluginConfigPathError,
      );
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(readJson(secret)).toEqual({ passwordHash: 'x' });
    },
  );
});

describe('ensurePluginAuthConfig', () => {
  it('writes the default server token into <mods>/KyuubiDDragon_KyuubiSoftAPI/config.json', async () => {
    const result = await auth.ensurePluginAuthConfig();
    const expectedPath = dataDirFile(modsDir);

    expect(result).toEqual({ ok: true, changed: true, path: expectedPath });
    expect(readJson(expectedPath).authToken).toBe(await auth.getPluginToken('default'));
    // No old plugin and no old file: the pre-2.1 path stays untouched.
    expect(fs.existsSync(legacyFile(serverDir))).toBe(false);
  });

  it('moves an old config: new file starts from its keys, old file gets the token too', async () => {
    fs.mkdirSync(path.dirname(legacyFile(legacyServerDir)), { recursive: true });
    fs.writeFileSync(
      legacyFile(legacyServerDir),
      JSON.stringify({ httpPort: 18111, authToken: 'stale', corsAllowedOrigins: ['https://x.y'] }),
    );

    const result = await auth.ensurePluginAuthConfig('legacy');
    const token = await auth.getPluginToken('legacy');

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      path: dataDirFile(legacyModsDir),
      legacyPath: legacyFile(legacyServerDir),
    });
    expect(readJson(dataDirFile(legacyModsDir))).toEqual({
      httpPort: 18111,
      corsAllowedOrigins: ['https://x.y'],
      authEnabled: true,
      authToken: token,
    });
    // A 2.0 plugin still reads the old file until it is replaced.
    expect(readJson(legacyFile(legacyServerDir)).authToken).toBe(token);
  });

  it('stops writing the old path once the 2.1 plugin has moved it away', async () => {
    fs.rmSync(path.join(legacyServerDir, 'config'), { recursive: true, force: true });
    fs.writeFileSync(path.join(legacyModsDir, 'KyuubiSoftAPI-2.1.0.jar'), '');

    const result = await auth.ensurePluginAuthConfig('legacy');

    expect(result.legacyPath).toBeUndefined();
    expect(fs.existsSync(legacyFile(legacyServerDir))).toBe(false);
  });

  it('writes the old path for an installed 2.0 jar even before it created its config', async () => {
    fs.writeFileSync(path.join(oldJarModsDir, 'KyuubiSoftAPI-2.0.0.jar'), '');

    const result = await auth.ensurePluginAuthConfig('oldjar');
    const token = await auth.getPluginToken('oldjar');

    expect(result).toMatchObject({ ok: true, legacyPath: legacyFile(oldJarServerDir) });
    expect(readJson(legacyFile(oldJarServerDir)).authToken).toBe(token);
    expect(readJson(dataDirFile(oldJarModsDir)).authToken).toBe(token);
  });

  it('reports instead of throwing when the mods dir is not reachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await auth.ensurePluginAuthConfig('unmounted');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not reachable/);
    expect(fs.existsSync(path.join(tmpDir, 'does-not-exist'))).toBe(false);
  });

  it.skipIf(noSymlinks)(
    'refuses a redirected config loudly, without throwing (start goes on)',
    async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const outside = path.join(tmpDir, 'outside-linked');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(linkedModsDir, DATA_DIR), 'dir');

      const result = await auth.ensurePluginAuthConfig('linked');

      expect(result).toMatchObject({ ok: false, changed: false });
      expect(result.error).toMatch(/symlink/);
      expect(error.mock.calls.some((c) => String(c[0]).includes('SECURITY'))).toBe(true);
      expect(fs.readdirSync(outside)).toEqual([]);
    },
  );

  it('reports an unknown server id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await auth.ensurePluginAuthConfig('nope')).toMatchObject({ ok: false, changed: false });
  });

  it('never logs the token', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);

    // Force a write so the success line is printed, then a failure line.
    fs.rmSync(path.join(modsDir, DATA_DIR), { recursive: true, force: true });
    await auth.ensurePluginAuthConfig('default');
    await auth.ensurePluginAuthConfig('unmounted');

    const token = await auth.getPluginToken('default');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(token);
  });
});

describe('isPluginJarFile', () => {
  it('matches any KyuubiSoftAPI jar version, not disabled jars or other mods', () => {
    expect(auth.isPluginJarFile('KyuubiSoftAPI-2.0.0.jar')).toBe(true);
    expect(auth.isPluginJarFile('kyuubisoftapi-1.4.3.jar')).toBe(true);
    expect(auth.isPluginJarFile('KyuubiSoftAPI-1.4.3.jar.disabled')).toBe(false);
    expect(auth.isPluginJarFile('EasyWebMap-v1.0.9.jar')).toBe(false);
  });
});
