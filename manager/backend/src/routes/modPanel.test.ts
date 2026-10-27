/**
 * Mod status routes: permission gates, validation of what the plugin returns,
 * error mapping and the audit trail of actions. Real router, real kyuubiApi
 * client and real requirePermission; the plugin is a stubbed fetch, roles,
 * authentication and the audit log are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-modpanel-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

function serverEntry(id: string, containerName: string, pluginPort: number) {
  return {
    id,
    name: id,
    containerName,
    status: 'ready',
    network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort },
    paths: {
      server: `/tmp/${id}/s`,
      data: `/tmp/${id}/d`,
      backups: `/tmp/${id}/b`,
      mods: `/tmp/${id}/m`,
      plugins: `/tmp/${id}/p`,
      assets: `/tmp/${id}/a`,
      auth: `/tmp/${id}/au`,
    },
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  };
}

fs.writeFileSync(
  path.join(tmpDir, 'servers.json'),
  JSON.stringify({
    schemaVersion: 1,
    defaultId: 'default',
    servers: [
      serverEntry('default', 'hytale-primary', 18085),
      serverEntry('second', 'hytale-second', 18090),
    ],
  }),
);

const { perms, audit } = vi.hoisted(() => ({
  perms: new Map<string, string[]>(),
  audit: vi.fn(),
}));

vi.mock('../services/roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/roles.js')>()),
  getUserPermissions: async (user: string) => perms.get(user) ?? [],
  getUserPermissionsForServer: async (user: string) => perms.get(user) ?? [],
  hasPermission: async (user: string, permission: string) => {
    const held = perms.get(user) ?? [];
    return held.includes('*') || held.includes(permission);
  },
}));
vi.mock('../services/audit.js', () => ({ audit }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (
    req: ExpressRequest & { user?: string },
    _res: ExpressResponse,
    next: NextFunction,
  ) => {
    req.user = String(req.headers['x-test-user'] ?? '');
    next();
  },
}));

const fetchMock = vi.fn<typeof fetch>();
const realFetch = globalThis.fetch;

const express = (await import('express')).default;
const { default: modPanelRouter } = await import('./modPanel.js');
const { serverScopeMiddleware } = await import('../middleware/serverScope.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mod-panel', modPanelRouter);
  app.use('/api/servers/:serverId/mod-panel', serverScopeMiddleware, modPanelRouter);
  app.use((_err: unknown, _req: ExpressRequest, res: ExpressResponse, _next: NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Only the plugin calls are stubbed; the test's own requests use the real fetch.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith(base) ? realFetch(input, init) : fetchMock(input, init),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  perms.clear();
  perms.set('viewer', ['mods.panel.view']);
  perms.set('operator', ['mods.panel.view', 'mods.panel.action']);
  perms.set('consoleadmin', ['mods.panel.view', 'mods.panel.action', 'console.execute.admin']);
  perms.set('nobody', []);
  fetchMock.mockReset();
  audit.mockReset();
});

function pluginJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  user: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await realFetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function pluginCall(n = 0): { url: string; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[n];
  return {
    url: String(url),
    init: init ?? {},
    headers: ((init ?? {}).headers ?? {}) as Record<string, string>,
  };
}

const petsProvider = {
  id: 'kyuubisoft:pets',
  displayName: 'Pets',
  description: 'Collector pets, combat pets and mounts',
  version: '1.12.0',
  actions: [
    {
      id: 'reload_config',
      label: 'Reload configuration',
      confirmation: 'Apply the files on disk now?',
      requiresConfirmation: true,
      dangerous: false,
      params: [],
    },
    {
      id: 'clean_orphans',
      label: 'Remove orphaned pet NPCs',
      requiresConfirmation: false,
      dangerous: false,
      params: [{ id: 'world', label: 'World', type: 'text', required: false, maxLength: 64 }],
    },
  ],
};

describe('GET /api/mod-panel', () => {
  it('needs mods.panel.view', async () => {
    const r = await call('GET', '/api/mod-panel', 'nobody');
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists the providers and passes token, actor and language to the plugin', async () => {
    fetchMock.mockResolvedValue(
      pluginJson(200, { apiVersion: 1, actionTimeoutMs: 10000, providers: [petsProvider] }),
    );
    const r = await call('GET', '/api/mod-panel?locale=de', 'viewer');
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    expect(r.body.providers).toHaveLength(1);
    expect(r.body.providers[0].actions[0].requiresConfirmation).toBe(true);
    const sent = pluginCall();
    expect(sent.url).toBe('http://hytale-primary:18085/api/mods/panel');
    expect(sent.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(sent.headers['X-Panel-Actor']).toBe('viewer');
    expect(sent.headers['Accept-Language']).toBe('de');
  });

  it('drops an invalid locale instead of forwarding it', async () => {
    fetchMock.mockResolvedValue(pluginJson(200, { apiVersion: 1, providers: [] }));
    await call('GET', '/api/mod-panel?locale=%0D%0AX-Evil:1', 'viewer', undefined, {
      'Accept-Language': 'en-US,en;q=0.9',
    });
    expect(pluginCall().headers['Accept-Language']).toBe('en-US');
  });

  it('uses the selected server when mounted under /api/servers/:id', async () => {
    fetchMock.mockResolvedValue(pluginJson(200, { apiVersion: 1, providers: [] }));
    const r = await call('GET', '/api/servers/second/mod-panel', 'viewer');
    expect(r.status).toBe(200);
    expect(pluginCall().url).toBe('http://hytale-second:18090/api/mods/panel');
  });

  it('reports an older plugin without the registry as unsupported', async () => {
    fetchMock.mockResolvedValue(
      pluginJson(404, { status: 404, error: 'Endpoint not found: /api/mods/panel' }),
    );
    const r = await call('GET', '/api/mod-panel', 'viewer');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: false, reason: 'unsupported', providers: [] });
  });

  it('reports an unreachable plugin as offline', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const r = await call('GET', '/api/mod-panel', 'viewer');
    expect(r.body).toMatchObject({ available: false, reason: 'offline' });
  });

  it('reports a rejected token as an auth problem', async () => {
    fetchMock.mockResolvedValue(pluginJson(401, { status: 401, code: 'auth_invalid' }));
    const r = await call('GET', '/api/mod-panel', 'viewer');
    expect(r.body).toMatchObject({
      available: false,
      reason: 'auth',
      authError: 'token_rejected',
    });
  });

  it('refuses a malformed provider list with 502', async () => {
    fetchMock.mockResolvedValue(
      pluginJson(200, { apiVersion: 1, providers: [{ id: 'Bad Id', displayName: 'x' }] }),
    );
    const r = await call('GET', '/api/mod-panel', 'viewer');
    expect(r.status).toBe(502);
  });
});

describe('GET /api/mod-panel/:id', () => {
  it('rejects an invalid id without asking the plugin', async () => {
    const r = await call('GET', '/api/mod-panel/Bad%20Id', 'viewer');
    expect(r.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an unknown provider to 404', async () => {
    fetchMock.mockResolvedValue(
      pluginJson(404, { status: 404, error: 'Unknown provider', code: 'not_found' }),
    );
    const r = await call('GET', '/api/mod-panel/kyuubisoft:dungeons', 'viewer');
    expect(r.status).toBe(404);
    expect(pluginCall().url).toBe(
      'http://hytale-primary:18085/api/mods/panel/kyuubisoft%3Adungeons',
    );
  });

  it('returns the validated snapshot, drops unknown fields and normalizes tones', async () => {
    fetchMock.mockResolvedValue(
      pluginJson(200, {
        ...petsProvider,
        status: 'ok',
        durationMs: 2,
        evil: '<script>',
        snapshot: {
          notices: [{ tone: 'blinking', text: 'x'.repeat(900) }],
          sections: [
            {
              title: 'Overview',
              metrics: [{ label: 'Active companions', value: 3, tone: 'success', html: '<b>' }],
              tables: [{ columns: ['World', 'Players'], rows: [['default', 3]], totalRows: 1 }],
            },
          ],
        },
      }),
    );
    const r = await call('GET', '/api/mod-panel/kyuubisoft:pets', 'viewer');
    expect(r.status).toBe(200);
    expect(r.body.evil).toBeUndefined();
    expect(r.body.snapshot.notices[0].tone).toBe('neutral');
    expect(r.body.snapshot.notices[0].text).toHaveLength(500);
    expect(r.body.snapshot.sections[0].metrics[0]).toEqual({
      label: 'Active companions',
      value: 3,
      tone: 'success',
    });
    expect(r.body.snapshot.sections[0].tables[0].rows).toEqual([['default', 3]]);
  });

  it('passes a provider error through as status', async () => {
    fetchMock.mockResolvedValue(
      pluginJson(200, {
        ...petsProvider,
        status: 'timeout',
        error: 'No answer within the time limit',
      }),
    );
    const r = await call('GET', '/api/mod-panel/kyuubisoft:pets', 'viewer');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'timeout', error: 'No answer within the time limit' });
  });

  it('refuses nested objects as table cells', async () => {
    fetchMock.mockResolvedValue(
      pluginJson(200, {
        ...petsProvider,
        status: 'ok',
        snapshot: { sections: [{ title: 'T', tables: [{ columns: ['A'], rows: [[{ a: 1 }]] }] }] },
      }),
    );
    const r = await call('GET', '/api/mod-panel/kyuubisoft:pets', 'viewer');
    expect(r.status).toBe(502);
  });
});

describe('POST /api/mod-panel/:id/actions/:actionId', () => {
  const url = '/api/mod-panel/kyuubisoft:pets/actions/reload_config';

  const economyProvider = {
    id: 'kyuubisoft:economy',
    displayName: 'Economy',
    actions: [
      {
        id: 'reset_balances',
        label: 'Reset all balances',
        requiresConfirmation: true,
        dangerous: true,
        params: [],
      },
    ],
  };

  /**
   * The route first reads the plugin's provider list (to learn whether the
   * action is dangerous), then posts the action. `action` answers the POST.
   */
  function plugin(action: () => Response | Promise<Response>) {
    fetchMock.mockImplementation(async (_input, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? pluginJson(200, { apiVersion: 1, providers: [petsProvider, economyProvider] })
        : action(),
    );
  }

  it('needs mods.panel.action; view alone is not enough', async () => {
    const r = await call('POST', url, 'viewer', { confirmed: true });
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects malformed params before the plugin sees them', async () => {
    const r = await call('POST', url, 'operator', { params: { world: { $gt: 1 } } });
    expect(r.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects parameter names outside the id format (no prototype keys)', async () => {
    const r = await call('POST', url, 'operator', { params: { __proto__x: 'a', ['Bad Key']: 1 } });
    expect(r.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards params and confirmation, returns the result and audits it', async () => {
    plugin(() =>
      pluginJson(200, {
        success: true,
        status: 'ok',
        message: 'Configuration reloaded, 12 pet type(s) loaded',
        data: { petTypes: 12 },
        durationMs: 40,
      }),
    );
    const r = await call('POST', url, 'operator', {
      confirmed: true,
      params: { note: 'x'.repeat(300) },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, status: 'ok', data: { petTypes: 12 } });

    expect(pluginCall(0).url).toBe('http://hytale-primary:18085/api/mods/panel');
    const sent = pluginCall(1);
    expect(sent.init.method).toBe('POST');
    expect(sent.url).toBe(
      'http://hytale-primary:18085/api/mods/panel/kyuubisoft%3Apets/actions/reload_config',
    );
    expect(JSON.parse(String(sent.init.body))).toEqual({
      params: { note: 'x'.repeat(300) },
      confirmed: true,
    });
    expect(sent.headers['X-Panel-Actor']).toBe('operator');

    expect(audit).toHaveBeenCalledTimes(1);
    const [, action, opts] = audit.mock.calls[0];
    expect(action).toBe('mod_panel.action');
    expect(opts.target).toBe('mod:kyuubisoft:pets/reload_config');
    expect(opts.success).toBe(true);
    expect(opts.metadata.status).toBe('ok');
    expect(opts.metadata.confirmed).toBe(true);
    expect(opts.metadata.params.note).toHaveLength(200);
  });

  it('passes the confirmation requirement through as 409 and audits the refusal', async () => {
    plugin(() =>
      pluginJson(409, {
        status: 409,
        error: 'This action has to be confirmed',
        code: 'confirmation_required',
      }),
    );
    const r = await call('POST', url, 'operator', {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('confirmation_required');
    expect(JSON.parse(String(pluginCall(1).init.body)).confirmed).toBe(false);
    expect(audit.mock.calls[0][2]).toMatchObject({
      success: false,
      metadata: { status: 'confirmation_required' },
    });
  });

  it('answers 200 with success false when the mod reports a failure', async () => {
    plugin(() => pluginJson(200, { success: false, status: 'failed', message: 'No worlds loaded' }));
    const r = await call(
      'POST',
      '/api/mod-panel/kyuubisoft:pets/actions/clean_orphans',
      'operator',
      {},
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: false, status: 'failed', message: 'No worlds loaded' });
    expect(audit.mock.calls[0][2].success).toBe(false);
  });

  it('maps invalid params reported by the plugin to 400', async () => {
    plugin(() =>
      pluginJson(400, { status: 400, error: 'world is required', code: 'invalid_params' }),
    );
    const r = await call(
      'POST',
      '/api/mod-panel/kyuubisoft:pets/actions/clean_orphans',
      'operator',
      {},
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'world is required', code: 'invalid_params' });
  });

  it('maps an unreachable plugin to 502 and still audits the attempt', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const r = await call('POST', url, 'operator', { confirmed: true });
    expect(r.status).toBe(502);
    expect(r.body.reason).toBe('offline');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][2].success).toBe(false);
  });

  it('refuses a dangerous action without console.execute.admin and never sends it', async () => {
    plugin(() => pluginJson(200, { success: true, status: 'ok' }));
    const r = await call('POST', '/api/mod-panel/kyuubisoft:economy/actions/reset_balances', 'operator', {
      confirmed: true,
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('admin_required');
    // Only the provider list was read; the action itself never reached the plugin.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pluginCall(0).init.method ?? 'GET').toBe('GET');
    expect(audit.mock.calls[0][2]).toMatchObject({
      success: false,
      metadata: { status: 'admin_required' },
    });
  });

  it('runs a dangerous action for a user with console.execute.admin on that server', async () => {
    plugin(() => pluginJson(200, { success: true, status: 'ok', message: 'Balances reset' }));
    const r = await call(
      'POST',
      '/api/servers/second/mod-panel/kyuubisoft:economy/actions/reset_balances',
      'consoleadmin',
      { confirmed: true },
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, message: 'Balances reset' });
    expect(pluginCall(1).url).toBe(
      'http://hytale-second:18090/api/mods/panel/kyuubisoft%3Aeconomy/actions/reset_balances',
    );
  });

  it('answers 404 for an action the plugin does not list, without posting it', async () => {
    plugin(() => pluginJson(200, { success: true, status: 'ok' }));
    const r = await call('POST', '/api/mod-panel/kyuubisoft:pets/actions/wipe_all', 'consoleadmin', {
      confirmed: true,
    });
    expect(r.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][2].metadata.status).toBe('not_found');
  });

  it('masks secret-looking parameters in the audit log', async () => {
    plugin(() => pluginJson(200, { success: true, status: 'ok' }));
    await call('POST', '/api/mod-panel/kyuubisoft:pets/actions/clean_orphans', 'operator', {
      params: { world: 'default', api_token: 'abc', webhook_url: 'https://example.invalid/x' },
    });
    expect(audit.mock.calls[0][2].metadata.params).toEqual({
      world: 'default',
      api_token: '***',
      webhook_url: '***',
    });
  });
});
