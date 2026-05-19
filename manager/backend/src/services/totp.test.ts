/**
 * Unit tests for TOTP helpers.
 *
 * Uses a temp MANAGER_DATA_PATH so the real users.json isn't touched.
 * Seeded with a single test user before the 2FA helpers run against it.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { authenticator } from 'otplib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const tmpDir = path.join(os.tmpdir(), `kp-totp-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

// Seed a user fixture before the totp module loads.
fs.writeFileSync(
  path.join(tmpDir, 'users.json'),
  JSON.stringify({ users: [{ username: 'alice', passwordHash: 'hash', roleId: 'admin', createdAt: '2026-01-01', tokenVersion: 1 }] }, null, 2),
);

describe('totp service', () => {
  let secret: string;

  it('startTotpEnrollment writes a pending secret', async () => {
    const { startTotpEnrollment } = await import('./totp.js');
    const r = await startTotpEnrollment('alice', 'KP-Tests');
    expect(typeof r.secret).toBe('string');
    expect(r.secret.length).toBeGreaterThan(8);
    expect(r.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(r.qrDataUrl).toMatch(/^data:image\//);
    secret = r.secret;
  });

  it('refuses verify-enable with a wrong code', async () => {
    const { verifyAndEnableTotp } = await import('./totp.js');
    await expect(verifyAndEnableTotp('alice', '000000')).rejects.toThrow();
  });

  it('verifies the right code and returns 10 backup codes', async () => {
    const { verifyAndEnableTotp } = await import('./totp.js');
    const code = authenticator.generate(secret);
    const r = await verifyAndEnableTotp('alice', code);
    expect(Array.isArray(r.backupCodes)).toBe(true);
    expect(r.backupCodes).toHaveLength(10);
    expect(r.backupCodes[0]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('isTotpEnabled reflects state', async () => {
    const { isTotpEnabled } = await import('./totp.js');
    expect(await isTotpEnabled('alice')).toBe(true);
    expect(await isTotpEnabled('nobody')).toBe(false);
  });

  it('verifyTotpOrBackup accepts a fresh TOTP', async () => {
    const { verifyTotpOrBackup } = await import('./totp.js');
    const code = authenticator.generate(secret);
    expect(await verifyTotpOrBackup('alice', code)).toBe(true);
  });

  it('regenerateBackupCodes produces a fresh batch', async () => {
    const { regenerateBackupCodes } = await import('./totp.js');
    const fresh = await regenerateBackupCodes('alice');
    expect(fresh).toHaveLength(10);
    expect(fresh[0]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});
