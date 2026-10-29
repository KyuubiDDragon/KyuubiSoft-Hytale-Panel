/**
 * The off-site backup target is a URL the admin configures. A storage server
 * in the LAN (MinIO) stays reachable; a cloud metadata address never is.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';

const cfg = vi.hoisted(() => ({
  offsiteBackup: {
    enabled: true,
    endpoint: '',
    region: 'us-east-1',
    bucket: 'backups',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    prefix: '',
  },
}));
vi.mock('./configService.js', () => ({ getConfig: async () => cfg }));

const { testConnection } = await import('./offsiteBackup.js');

let server: Server;
const puts: string[] = [];
let connections = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    puts.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      res.writeHead(200);
      res.end();
    });
  });
  server.on('connection', () => connections++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('off-site backup target', () => {
  it('uploads to a storage server in the LAN', async () => {
    cfg.offsiteBackup.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await testConnection();
    expect(result.success).toBe(true);
    expect(puts).toEqual(['PUT /backups/.kyuubisoft-connection-test']);
  });

  // A pooled connection to a storage server in the LAN would be open for
  // other requests to the same name, which then skip the address check.
  it('opens a new connection for every upload and keeps none open', async () => {
    cfg.offsiteBackup.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const before = connections;

    expect((await testConnection()).success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await testConnection()).success).toBe(true);

    expect(connections - before).toBe(2);
  });

  it('never connects to a cloud metadata address', async () => {
    cfg.offsiteBackup.endpoint = 'http://169.254.169.254';
    const result = await testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/metadata/i);
  });
});
