/**
 * The request log never contains credentials: bearer tokens, cookies, API
 * keys, the refresh cookie the login sets, and tokens or tickets carried in
 * the URL (replay stream, one-shot downloads, SSO callback, map sessions).
 * Runs the real pino-http pipeline into an in-memory pino destination.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import pino from 'pino';
import { createRequestLogger, redactUrl } from './requestLogger.js';

const lines: string[] = [];
const sink = { write: (line: string) => void lines.push(line) };

const BEARER = 'eyJhbGciOiJIUzI1NiJ9.secret-bearer.sig';
const COOKIE = 'refresh_token=secret-cookie-value';
const API_KEY = 'kp_secret_api_key_value';
const QUERY_TOKEN = 'secret-query-jwt';
const DOWNLOAD_TOKEN = 'a1b2c3d4secretdownload';
const SSO_CODE = 'secret-oauth-code';
const SET_COOKIE = 'refresh_token=secret-set-cookie; HttpOnly';
const SECRETS = [
  BEARER,
  'secret-cookie-value',
  API_KEY,
  QUERY_TOKEN,
  DOWNLOAD_TOKEN,
  SSO_CODE,
  'secret-set-cookie',
];

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(createRequestLogger(pino({ level: 'info' }, sink)));
  app.get('/api/auth/refresh', (_req, res) => {
    res.setHeader('Set-Cookie', SET_COOKIE);
    res.json({ ok: true });
  });
  app.get('/api/replay/download/:token', (_req, res) => res.status(404).json({ error: 'x' }));
  app.get('*', (_req, res) => res.json({ ok: true }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Send a request and return the log line pino-http wrote for it. */
async function logged(pathAndQuery: string, headers: Record<string, string> = {}) {
  const before = lines.length;
  await (await fetch(`${base}${pathAndQuery}`, { headers })).text();
  for (let i = 0; i < 50 && lines.length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(lines.length).toBeGreaterThan(before);
  return { text: lines.slice(before).join(''), entry: JSON.parse(lines[before]) };
}

describe('request log redaction', () => {
  it('blanks credential headers and keeps the rest', async () => {
    const { text, entry } = await logged('/api/servers', {
      Authorization: `Bearer ${BEARER}`,
      Cookie: COOKIE,
      'X-API-Key': API_KEY,
      'User-Agent': 'redact-test',
    });
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(entry.req.headers.authorization).toBe('[redacted]');
    expect(entry.req.headers.cookie).toBe('[redacted]');
    expect(entry.req.headers['x-api-key']).toBe('[redacted]');
    expect(entry.req.headers['user-agent']).toBe('redact-test');
  });

  it("blanks the login's Set-Cookie in the response", async () => {
    const { text, entry } = await logged('/api/auth/refresh');
    expect(text).not.toContain('secret-set-cookie');
    expect(entry.res.headers['set-cookie']).toBe('[redacted]');
  });

  it('blanks tokens in query and path, and keeps other parameters', async () => {
    const stream = await logged(`/api/replay/stream?token=${QUERY_TOKEN}&since=10`);
    expect(stream.text).not.toContain(QUERY_TOKEN);
    expect(stream.entry.req.url).toBe('/api/replay/stream?token=[redacted]&since=10');
    expect(stream.entry.req.query).toEqual({ token: '[redacted]', since: '10' });

    const download = await logged(`/api/replay/download/${DOWNLOAD_TOKEN}`);
    expect(download.text).not.toContain(DOWNLOAD_TOKEN);
    expect(download.entry.req.url).toBe('/api/replay/download/[redacted]');

    const sso = await logged(`/api/auth/sso/discord/callback?code=${SSO_CODE}&state=abc`);
    expect(sso.text).not.toContain(SSO_CODE);
  });
});

describe('redactUrl', () => {
  it('leaves URLs without credentials as they are', () => {
    expect(redactUrl('/api/servers/abc/backups?page=2&q=a%20b')).toBe(
      '/api/servers/abc/backups?page=2&q=a%20b',
    );
  });

  it('blanks map sessions, WebSocket tickets and encoded keys', () => {
    expect(redactUrl('/api/webmap/t/0123abcd/tiles/1/2.png')).toBe(
      '/api/webmap/t/[redacted]/tiles/1/2.png',
    );
    expect(redactUrl('/api/console/ws?ticket=t1&serverId=b')).toBe(
      '/api/console/ws?ticket=[redacted]&serverId=b',
    );
    expect(redactUrl('/x?%54oken=abc&TICKET=def')).toBe('/x?%54oken=[redacted]&TICKET=[redacted]');
  });
});
