import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Route MANAGER_DATA_PATH to a temp dir before the modules capture it.
const tmpDir = path.join(os.tmpdir(), `kp-pluginauth-${Date.now()}`);
const serverDir = path.join(tmpDir, 'srv-default');
const modsDir = path.join(tmpDir, 'mods-default');
const linkedServerDir = path.join(tmpDir, 'srv-linked');
fs.mkdirSync(serverDir, { recursive: true });
fs.mkdirSync(modsDir, { recursive: true });
fs.mkdirSync(linkedServerDir, { recursive: true });
// Creating symlinks needs extra rights on Windows; the CI/containers run Linux.
const noSymlinks = process.platform === 'win32';
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const seed = {
  schemaVersion: 1,
  defaultId: 'default',
  servers: [
    {
      id: 'default',
      name: 'Primary',
      containerName: 'hytale-primary',
      status: 'ready',
      network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: 18085 },
      paths: {
        server: serverDir,
        data: '/tmp/d1',
        backups: '/tmp/b1',
        mods: modsDir,
        plugins: '/tmp/p1',
        assets: '/tmp/a1',
        auth: '/tmp/au1',
      },
      createdAt: new Date().toISOString(),
      createdBy: 'system',
    },
    {
      // Instance dirs live outside the manager container: not reachable here.
      id: 'unmounted',
      name: 'Second',
      containerName: 'hytale-second',
      status: 'ready',
      network: { serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084, pluginPort: 18086 },
      paths: {
        server: path.join(tmpDir, 'does-not-exist', 'server'),
        data: '/tmp/d2',
        backups: '/tmp/b2',
        mods: '/tmp/m2',
        plugins: '/tmp/p2',
        assets: '/tmp/a2',
        auth: '/tmp/au2',
      },
      createdAt: new Date().toISOString(),
      createdBy: 'system',
    },
    {
      // Its config dir gets replaced by a symlink in a test below.
      id: 'linked',
      name: 'Linked',
      containerName: 'hytale-linked',
      status: 'ready',
      network: { serverPort: 5522, webMapPort: 18087, webMapWsPort: 18088, pluginPort: 18089 },
      paths: {
        server: linkedServerDir,
        data: '/tmp/d3',
        backups: '/tmp/b3',
        mods: '/tmp/m3',
        plugins: '/tmp/p3',
        assets: '/tmp/a3',
        auth: '/tmp/au3',
      },
      createdAt: new Date().toISOString(),
      createdBy: 'system',
    },
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

describe('writePluginAuthConfig', () => {
  const token = 'a'.repeat(64);

  /** Fresh server dir; optionally with an existing plugin config. */
  function newServer(name: string, configContent?: string): { dir: string; file: string } {
    const dir = path.join(tmpDir, name);
    const file = path.join(dir, 'config', 'kyuubisoft-api', 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    if (configContent !== undefined) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, configContent);
    }
    return { dir, file };
  }

  it('creates the plugin config when none exists', async () => {
    const { dir, file } = newServer('cfg-new');
    expect(await auth.writePluginAuthConfig(dir, token)).toEqual({ changed: true });
    expect(readJson(file)).toEqual({ authEnabled: true, authToken: token });
  });

  it('keeps every other key the operator set', async () => {
    const { dir, file } = newServer(
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
    const { dir, file } = newServer('cfg-insecure', JSON.stringify({ insecureDisableAuth: true }));

    await auth.writePluginAuthConfig(dir, token);

    expect(readJson(file)).toEqual({
      insecureDisableAuth: true,
      authEnabled: true,
      authToken: token,
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('insecureDisableAuth'))).toBe(true);
  });

  it('leaves an up-to-date file untouched', async () => {
    const { dir, file } = newServer('cfg-same');
    await auth.writePluginAuthConfig(dir, token);
    const mtime = fs.statSync(file).mtimeMs;
    expect(await auth.writePluginAuthConfig(dir, token)).toEqual({ changed: false });
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('replaces a broken file and keeps its copy in the panel volume, not in the server dir', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = '{ "httpPort": 18085, "authToken": "old-token-old-token", ';
    const { dir, file } = newServer('cfg-broken', broken);

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
    const { dir } = newServer('cfg-notdir');
    fs.writeFileSync(path.join(dir, 'config'), 'not a directory');
    await expect(auth.writePluginAuthConfig(dir, token)).rejects.toBeInstanceOf(
      auth.UnsafePluginConfigPathError,
    );
  });

  it.skipIf(noSymlinks)(
    'refuses a config dir symlinked out of the server dir and writes nothing there',
    async () => {
      const { dir } = newServer('cfg-link-out');
      const outside = path.join(tmpDir, 'outside-config');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(dir, 'config'), 'dir');

      await expect(auth.writePluginAuthConfig(dir, token)).rejects.toBeInstanceOf(
        auth.UnsafePluginConfigPathError,
      );
      expect(fs.readdirSync(outside)).toEqual([]);
    },
  );

  it.skipIf(noSymlinks)(
    'refuses a symlinked plugin dir even when it stays inside the server dir',
    async () => {
      const { dir } = newServer('cfg-link-in');
      fs.mkdirSync(path.join(dir, 'config', 'elsewhere'), { recursive: true });
      fs.symlinkSync(
        path.join(dir, 'config', 'elsewhere'),
        path.join(dir, 'config', 'kyuubisoft-api'),
        'dir',
      );

      await expect(auth.writePluginAuthConfig(dir, token)).rejects.toBeInstanceOf(
        auth.UnsafePluginConfigPathError,
      );
      expect(fs.readdirSync(path.join(dir, 'config', 'elsewhere'))).toEqual([]);
    },
  );

  it.skipIf(noSymlinks)(
    'neither reads nor replaces a secret the config file is linked to',
    async () => {
      const { dir, file } = newServer('cfg-link-file');
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
  it('writes the default server token into <server>/config/kyuubisoft-api/config.json', async () => {
    const result = await auth.ensurePluginAuthConfig();
    const expectedPath = path.join(serverDir, 'config', 'kyuubisoft-api', 'config.json');

    expect(result).toEqual({ ok: true, changed: true, path: expectedPath });
    expect(readJson(expectedPath).authToken).toBe(await auth.getPluginToken('default'));
  });

  it('reports instead of throwing when the server dir is not reachable', async () => {
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
      fs.symlinkSync(outside, path.join(linkedServerDir, 'config'), 'dir');

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
    fs.rmSync(path.join(serverDir, 'config'), { recursive: true, force: true });
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
