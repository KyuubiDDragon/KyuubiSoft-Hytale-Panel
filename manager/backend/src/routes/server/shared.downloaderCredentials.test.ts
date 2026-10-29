/**
 * checkDownloaderCredentials(): the downloader token lives only in the game
 * container's downloader volume (the entrypoint no longer copies it into the
 * auth volume). The manager reads it through its read-only mount and falls
 * back to asking the game container when that mount is missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-downloader-creds-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const access = vi.fn();
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  access: (...args: unknown[]) => access(...args),
}));

const execInContainer = vi.fn();
vi.mock('../../services/docker.js', () => ({
  execInContainer: (...args: unknown[]) => execInContainer(...args),
}));

const { checkDownloaderCredentials, DOWNLOADER_CREDENTIALS_PATH } = await import('./shared.js');

describe('checkDownloaderCredentials', () => {
  beforeEach(() => {
    access.mockReset();
    execInContainer.mockReset();
  });

  it('finds the token through the manager mount without asking the game container', async () => {
    access.mockResolvedValue(undefined);

    await expect(checkDownloaderCredentials()).resolves.toEqual({ exists: true });
    expect(access).toHaveBeenCalledWith(DOWNLOADER_CREDENTIALS_PATH, fs.constants.R_OK);
    expect(execInContainer).not.toHaveBeenCalled();
  });

  it('never treats the old auth-volume copies as credentials', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    execInContainer.mockResolvedValue({ success: true, output: 'missing' });

    await checkDownloaderCredentials();
    const checkedPaths = access.mock.calls.map((call) => call[0]);
    expect(checkedPaths).toEqual([DOWNLOADER_CREDENTIALS_PATH]);
  });

  it('asks the game container when the downloader volume is not mounted', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    execInContainer.mockResolvedValue({ success: true, output: 'present' });

    await expect(checkDownloaderCredentials()).resolves.toEqual({ exists: true });
    expect(execInContainer).toHaveBeenCalledWith(
      expect.stringContaining(`test -f '${DOWNLOADER_CREDENTIALS_PATH}'`),
    );
  });

  it('reports missing credentials when neither the mount nor the container has them', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    execInContainer.mockResolvedValue({ success: true, output: 'missing' });

    const result = await checkDownloaderCredentials();
    expect(result.exists).toBe(false);
    expect(result.error).toMatch(/Re-authentication required/);
  });

  it('reports missing credentials when the game container cannot be asked', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    execInContainer.mockResolvedValue({ success: false, error: 'Container not running' });

    await expect(checkDownloaderCredentials()).resolves.toMatchObject({ exists: false });
  });
});
