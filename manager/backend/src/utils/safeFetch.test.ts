/**
 * Outbound requests with the same checks on every hop: address class, host
 * list, redirects, a size and a time limit, and the integrity check of a
 * download. A local HTTP server stands in for the remote side (loopback, so
 * most cases allow private addresses explicitly).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http, { type Server } from 'http';
import crypto from 'crypto';
import dns from 'dns';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { guardedLookup, OutboundRequestError, safeDownload, safeRequest } from './safeFetch.js';
import { UnsafeUrlError } from './urlGuard.js';

const PAYLOAD = Buffer.from('PK\u0003\u0004 a mod jar');
const FIRST_PART = Buffer.from(`PK\u0003\u0004${'a'.repeat(1000)}`);
const LAST_PART = Buffer.from('b'.repeat(1000));
const sha = (algo: string, data: Buffer) => crypto.createHash(algo).update(data).digest('hex');

let server: Server;
let base: string;
const seen: Array<{ method?: string; url?: string; body: string }> = [];
let finishSlow: (() => void) | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      const url = req.url ?? '/';
      if (url === '/file') {
        res.writeHead(200, { 'Content-Length': PAYLOAD.length });
        res.end(PAYLOAD);
      } else if (url === '/relative') {
        res.writeHead(302, { Location: '/file' });
        res.end();
      } else if (url === '/to-metadata') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else if (url === '/to-localhost') {
        res.writeHead(301, {
          Location: `http://localhost:${(server.address() as AddressInfo).port}/file`,
        });
        res.end();
      } else if (url === '/to-file-scheme') {
        res.writeHead(302, { Location: 'file:///etc/passwd' });
        res.end();
      } else if (url === '/loop') {
        res.writeHead(302, { Location: '/loop' });
        res.end();
      } else if (url === '/see-other') {
        res.writeHead(303, { Location: '/echo' });
        res.end();
      } else if (url === '/echo') {
        res.writeHead(200);
        res.end(`${req.method} ${body}`);
      } else if (url === '/big') {
        res.writeHead(200);
        res.end(Buffer.alloc(4096, 0x61));
      } else if (url === '/missing') {
        res.writeHead(404);
        res.end('not here');
      } else if (url === '/hang') {
        // never answers
      } else if (url === '/slow') {
        // the first part now, the rest when the test says so
        res.writeHead(200);
        res.write(FIRST_PART);
        finishSlow = () => res.end(LAST_PART);
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('safeRequest', () => {
  it('refuses a private target unless private addresses are allowed', async () => {
    await expect(safeRequest(`${base}/file`)).rejects.toThrow(UnsafeUrlError);
    const res = await safeRequest(`${base}/file`, { allowPrivate: true });
    expect(res.status).toBe(200);
    expect(res.body.equals(PAYLOAD)).toBe(true);
  });

  it('refuses schemes other than http and https', async () => {
    await expect(safeRequest('ftp://example.com/x', { allowPrivate: true })).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(
      safeRequest(`${base}/file`, { allowPrivate: true, httpsOnly: true }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it('follows a relative redirect and checks every hop', async () => {
    const res = await safeRequest(`${base}/relative`, { allowPrivate: true });
    expect(res.body.equals(PAYLOAD)).toBe(true);
    expect(res.url).toBe(`${base}/file`);

    await expect(safeRequest(`${base}/to-metadata`, { allowPrivate: true })).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(safeRequest(`${base}/to-file-scheme`, { allowPrivate: true })).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it('keeps redirects on the allowed hosts', async () => {
    const opts = { allowPrivate: true, allowedHosts: ['127.0.0.1'] };
    await expect(safeRequest(`${base}/relative`, opts)).resolves.toMatchObject({ status: 200 });
    await expect(safeRequest(`${base}/to-localhost`, opts)).rejects.toThrow(UnsafeUrlError);
    await expect(
      safeRequest(`${base}/file`, { ...opts, allowedHosts: ['example.com'] }),
    ).rejects.toThrow(UnsafeUrlError);
    // redirectHosts: null lets a redirect go to any host the address rules allow
    await expect(
      safeRequest(`${base}/to-localhost`, { ...opts, redirectHosts: null }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('stops after too many redirects', async () => {
    const err = await safeRequest(`${base}/loop`, { allowPrivate: true, maxRedirects: 3 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OutboundRequestError);
    expect(err.reason).toBe('redirects');
  });

  it('turns a POST into a GET without body on 303', async () => {
    const res = await safeRequest(`${base}/see-other`, {
      allowPrivate: true,
      method: 'POST',
      body: '{"a":1}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.body.toString()).toBe('GET ');
  });

  it('refuses or truncates an answer over the size limit', async () => {
    const err = await safeRequest(`${base}/big`, { allowPrivate: true, maxBytes: 1024 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OutboundRequestError);
    expect(err.reason).toBe('too-large');

    const cut = await safeRequest(`${base}/big`, {
      allowPrivate: true,
      maxBytes: 1024,
      truncate: true,
    });
    expect(cut.body.length).toBe(1024);
    expect(cut.truncated).toBe(true);
  });

  it('gives up after the time limit', async () => {
    const err = await safeRequest(`${base}/hang`, { allowPrivate: true, timeoutMs: 200 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OutboundRequestError);
    expect(err.reason).toBe('timeout');
  });

  it('opens a new connection for every request, so the address check always runs', async () => {
    // A name of a storage server in the LAN: reachable for a request that
    // allows private targets, refused for one that does not.
    const name = 'storage.lan-test';
    const realLookup = dns.lookup;
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((
      host: string,
      options: dns.LookupOptions,
      callback: (err: Error | null, addresses: dns.LookupAddress[]) => void,
    ) => {
      if (host === name) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
      return (realLookup as (...args: unknown[]) => void).call(dns, host, options, callback);
    }) as unknown as typeof dns.lookup);
    try {
      const url = `http://${name}:${(server.address() as AddressInfo).port}/file`;
      expect((await safeRequest(url, { allowPrivate: true })).status).toBe(200);
      // The server keeps the first connection open meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const err = await safeRequest(url).catch((e) => e);

      expect(err).toBeInstanceOf(UnsafeUrlError);
      expect(err.reason).toBe('private-ip');
    } finally {
      lookup.mockRestore();
    }
  });
});

describe('guardedLookup', () => {
  const lookupAll = (allowPrivate: boolean, host: string) =>
    new Promise<unknown>((resolve, reject) =>
      guardedLookup(allowPrivate)(host, { all: true }, (err, addresses) =>
        err ? reject(err) : resolve(addresses),
      ),
    );

  it('refuses a name that resolves to a private address', async () => {
    await expect(lookupAll(false, 'localhost')).rejects.toThrow(UnsafeUrlError);
    await expect(lookupAll(true, 'localhost')).resolves.toBeTruthy();
  });
});

describe('safeDownload', () => {
  const opts = { allowPrivate: true };
  // The staging folder lies in the manager volume, which no game server mounts.
  const staging = () => path.join(process.env.MANAGER_DATA_PATH!, 'staging');
  let modsDir: string;
  const saveTo = (name: string) => path.join(modsDir, name);

  beforeEach(() => {
    modsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-safe-download-'));
  });
  afterEach(() => fs.rmSync(modsDir, { recursive: true, force: true }));

  it('puts the file in place when size and hashes match', async () => {
    const result = await safeDownload(`${base}/file`, {
      ...opts,
      saveTo: saveTo('Mod.jar'),
      expected: {
        size: PAYLOAD.length,
        sha1: sha('sha1', PAYLOAD).toUpperCase(),
        sha256: sha('sha256', PAYLOAD),
      },
    });
    expect(result.size).toBe(PAYLOAD.length);
    expect(fs.readFileSync(saveTo('Mod.jar')).equals(PAYLOAD)).toBe(true);
    expect(fs.readdirSync(modsDir)).toEqual(['Mod.jar']);
    expect(fs.readdirSync(staging())).toEqual([]);
  });

  it('refuses a file whose hash or size differs', async () => {
    for (const expected of [
      { sha1: sha('sha1', Buffer.from('other')) },
      { sha256: sha('sha256', Buffer.from('other')) },
      { size: PAYLOAD.length + 1 },
    ]) {
      const err = await safeDownload(`${base}/file`, {
        ...opts,
        saveTo: saveTo('Mod.jar'),
        expected,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(OutboundRequestError);
      expect(err.reason).toBe('integrity');
    }
  });

  it('refuses an answer other than 200', async () => {
    const err = await safeDownload(`${base}/missing`, { ...opts, saveTo: saveTo('Mod.jar') }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OutboundRequestError);
    expect(err.reason).toBe('status');
  });

  it('keeps the installed file and leaves nothing behind when a download is refused', async () => {
    fs.writeFileSync(saveTo('Mod.jar'), 'OLD');
    const refused = [
      [`${base}/file`, { expected: { sha256: sha('sha256', Buffer.from('other')) } }],
      [`${base}/missing`, {}],
      [`${base}/big`, { maxBytes: 1024 }],
    ] as const;
    for (const [url, extra] of refused) {
      const err = await safeDownload(url, { ...opts, ...extra, saveTo: saveTo('Mod.jar') }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(OutboundRequestError);
      expect(fs.readFileSync(saveTo('Mod.jar'), 'utf-8')).toBe('OLD');
      expect(fs.readdirSync(modsDir)).toEqual(['Mod.jar']);
      expect(fs.readdirSync(staging())).toEqual([]);
    }
  });

  it('writes the answer to the staging folder while it arrives instead of holding it', async () => {
    const download = safeDownload(`${base}/slow`, { ...opts, saveTo: saveTo('Big.jar') });

    // Part of the file is on disk before the server has sent the rest.
    await vi.waitFor(() => {
      const names = fs.readdirSync(staging());
      expect(names).toHaveLength(1);
      expect(fs.statSync(path.join(staging(), names[0])).size).toBeGreaterThan(0);
      expect(finishSlow).not.toBeNull();
    });
    expect(fs.readdirSync(modsDir)).toEqual([]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(staging()).mode & 0o777).toBe(0o700);
    }
    finishSlow!();

    await download;
    expect(fs.readFileSync(saveTo('Big.jar'))).toEqual(Buffer.concat([FIRST_PART, LAST_PART]));
    expect(fs.readdirSync(staging())).toEqual([]);
  });
});
