import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Temp registry with one server whose mods dir holds a plugin jar, so the
// status endpoint reports the plugin as installed.
const tmpDir = path.join(os.tmpdir(), `kp-kyuubi-auth-${Date.now()}`);
const modsDir = path.join(tmpDir, 'mods');
fs.mkdirSync(modsDir, { recursive: true });
fs.writeFileSync(path.join(modsDir, 'KyuubiSoftAPI-2.0.0.jar'), '');
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

fs.writeFileSync(
  path.join(tmpDir, 'servers.json'),
  JSON.stringify({
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
          server: path.join(tmpDir, 'server'),
          data: '/tmp/d',
          backups: '/tmp/b',
          mods: modsDir,
          plugins: '/tmp/p',
          assets: '/tmp/a',
          auth: '/tmp/au',
        },
        createdAt: new Date().toISOString(),
        createdBy: 'system',
      },
    ],
  }),
);

type KyuubiApi = typeof import('./kyuubiApi.js');
let api: KyuubiApi;
let token: string;
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sentHeaders(call = 0): Record<string, string> {
  const init = fetchMock.mock.calls[call][1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  api = await import('./kyuubiApi.js');
  const { getPluginToken } = await import('./pluginAuth.js');
  token = await getPluginToken('default');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe('plugin requests carry the bearer token', () => {
  it('GET requests', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { players: [] }));
    const result = await api.fetchFromPlugin('/api/players');
    expect(result.success).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://hytale-primary:18085/api/players');
    expect(sentHeaders().Authorization).toBe(`Bearer ${token}`);
  });

  it('POST actions, next to the JSON content type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, message: 'ok' }));
    const result = await api.givePlayerViaPlugin('Steve', 'Tool_Pickaxe', 1);
    expect(result.success).toBe(true);
    expect(sentHeaders()).toEqual({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
  });

  it('POST actions without a body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));
    await api.killPlayerViaPlugin('Steve');
    expect(sentHeaders()).toEqual({ Authorization: `Bearer ${token}` });
  });

  it('Prometheus metrics and the status probe', async () => {
    fetchMock.mockResolvedValue(new Response('hytale_tps 30', { status: 200 }));
    await api.getPrometheusMetrics();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api.isPluginRunning();
    expect(sentHeaders(0).Authorization).toBe(`Bearer ${token}`);
    expect(sentHeaders(1).Authorization).toBe(`Bearer ${token}`);
  });
});

describe('plugin auth failures', () => {
  it('401 is reported as token_rejected with a restart hint', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { status: 401, error: 'Unauthorized', code: 'auth_invalid' }),
    );
    const result = await api.fetchFromPlugin('/api/players');
    expect(result).toMatchObject({ success: false, authError: 'token_rejected' });
    expect(result.error).toMatch(/Restart the server/);
  });

  it('503 auth_not_configured is reported as token_missing', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { status: 503, error: 'API locked', code: 'auth_not_configured' }),
    );
    expect(await api.fetchFromPlugin('/api/server/info')).toMatchObject({
      success: false,
      authError: 'token_missing',
    });
  });

  it('other 503s stay plain HTTP errors', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { status: 503, error: 'Metrics not initialized' }),
    );
    const result = await api.fetchFromPlugin('/api/server/info');
    expect(result).toEqual({ success: false, error: 'HTTP 503' });
  });

  it('a refused POST action fails with the auth hint (so routes fall back to the console)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { status: 401, error: 'Unauthorized', code: 'auth_invalid' }),
    );
    expect(await api.healPlayerViaPlugin('Steve')).toMatchObject({
      success: false,
      authError: 'token_rejected',
    });
  });

  it('plugin status explains a token mismatch', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { status: 401, error: 'Unauthorized', code: 'auth_invalid' }),
    );
    expect(await api.getPluginStatus()).toEqual({
      installed: true,
      running: false,
      version: '2.0.0',
      port: 18085,
      authError: 'token_rejected',
    });
  });

  it('plugin status of a healthy plugin has no auth error', async () => {
    // A 1.4.x plugin answers 200 too: it simply ignores the header.
    fetchMock.mockResolvedValue(jsonResponse(200, { tps: 30 }));
    const status = await api.getPluginStatus();
    expect(status.running).toBe(true);
    expect(status.authError).toBeUndefined();
  });
});
