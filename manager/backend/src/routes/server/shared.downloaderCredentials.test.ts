/**
 * checkDownloaderCredentials(): the downloader token lives only in the game
 * container's downloader volume (the entrypoint no longer copies it into the
 * auth volume). The manager reads it through its read-only mount and falls
 * back to asking the game container when that mount is missing. Each server
 * has its own: an additional server's lies in its instance folder and is
 * probed in its own container. findPendingDeviceLogin() reads a login the
 * container's downloader waits for from its log.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-downloader-creds-'));
const instancesRoot = path.join(tmpDir, 'instances');
process.env.MANAGER_DATA_PATH = path.join(tmpDir, 'manager');
process.env.INSTANCES_PATH = instancesRoot;
fs.mkdirSync(process.env.MANAGER_DATA_PATH, { recursive: true });
delete process.env.DEMO_MODE;
// The compose layout: the downloader folder at the container path (access is stubbed).
delete process.env.DOWNLOADER_PATH;

const instanceRoot = path.join(instancesRoot, 'bbbb0002');
const instancePaths = Object.fromEntries(
  ['server', 'data', 'backups', 'mods', 'plugins', 'assets', 'auth'].map((dir) => [
    dir,
    path.join(instanceRoot, dir),
  ]),
);
fs.writeFileSync(
  path.join(process.env.MANAGER_DATA_PATH, 'servers.json'),
  JSON.stringify({
    schemaVersion: 2,
    defaultId: 'default',
    servers: [
      {
        id: 'default',
        name: 'Primary',
        containerName: 'hytale',
        status: 'ready',
        network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082 },
        paths: instancePaths,
        createdAt: '2026-10-01T00:00:00.000Z',
        createdBy: 'system',
      },
      {
        id: 'bbbb0002',
        name: 'Server B',
        containerName: 'hytale-srv-bbbb0002',
        status: 'ready',
        network: { serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084 },
        paths: instancePaths,
        createdAt: '2026-10-01T00:00:00.000Z',
        createdBy: 'system',
      },
    ],
  }),
);

// The manager checks the token with lstat (a planted link does not count).
const access = vi.fn();
const tokenFile = { isFile: () => true };
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  lstat: async (...args: unknown[]) => {
    await access(...args);
    return tokenFile;
  },
}));

const execInContainer = vi.fn();
vi.mock('../../services/docker.js', () => ({
  execInContainer: (...args: unknown[]) => execInContainer(...args),
}));

const { checkDownloaderCredentials, findPendingDeviceLogin, DOWNLOADER_CREDENTIALS_PATH } =
  await import('./shared.js');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('checkDownloaderCredentials', () => {
  beforeEach(() => {
    access.mockReset();
    execInContainer.mockReset();
  });

  it('finds the token through the manager mount without asking the game container', async () => {
    access.mockResolvedValue(undefined);

    await expect(checkDownloaderCredentials()).resolves.toEqual({ exists: true });
    expect(access).toHaveBeenCalledWith(DOWNLOADER_CREDENTIALS_PATH);
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
      'default',
    );
  });

  it("checks an additional server's own token in its instance folder and container", async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    execInContainer.mockResolvedValue({ success: true, output: 'missing' });

    await expect(checkDownloaderCredentials('bbbb0002')).resolves.toMatchObject({
      exists: false,
    });
    expect(access.mock.calls.map((call) => call[0])).toEqual([
      path.join(instanceRoot, 'downloader', '.hytale-downloader-credentials.json'),
    ]);
    expect(execInContainer).toHaveBeenCalledWith(
      expect.stringContaining(`test -f '${DOWNLOADER_CREDENTIALS_PATH}'`),
      'bbbb0002',
    );
  });

  it('refuses an unknown server instead of checking the default one', async () => {
    await expect(checkDownloaderCredentials('nope')).rejects.toMatchObject({
      code: 'unknown_server',
    });
    expect(access).not.toHaveBeenCalled();
    expect(execInContainer).not.toHaveBeenCalled();
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

describe('findPendingDeviceLogin', () => {
  const now = Date.parse('2026-10-28T12:05:00Z');
  const prompt = [
    '2026-10-28T12:00:00.000000000Z [INFO] Attempting download (attempt 1)...',
    '2026-10-28T12:00:01.000000000Z Visit: https://oauth.accounts.hytale.com/oauth2/device/verify',
    '2026-10-28T12:00:01.000000000Z Enter code: \x1B[1mAbCd1234\x1B[0m',
    '2026-10-28T12:00:01.000000000Z Or visit: https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=AbCd1234',
  ];

  it('finds the link and code the waiting downloader printed', () => {
    expect(findPendingDeviceLogin(prompt.join('\n'), now)).toEqual({
      verificationUrl: 'https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=AbCd1234',
      userCode: 'AbCd1234',
      shownAt: '2026-10-28T12:00:01.000000000Z',
    });
  });

  it('reads the code the downloader prints after its plain link', () => {
    const downloader = [
      '2026-10-28T12:00:00.000000000Z [INFO] Attempting download (attempt 1)...',
      '2026-10-28T12:00:01.000000000Z Please visit the following URL to authenticate:',
      '2026-10-28T12:00:01.000000000Z https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=qpQCCwFj',
      '2026-10-28T12:00:01.000000000Z Or visit the following URL and enter the code:',
      '2026-10-28T12:00:01.000000000Z https://oauth.accounts.hytale.com/oauth2/device/verify',
      '2026-10-28T12:00:01.000000000Z Authorization code: qpQCCwFj',
    ];
    expect(findPendingDeviceLogin(downloader.join('\n'), now)).toMatchObject({
      verificationUrl: 'https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=qpQCCwFj',
      userCode: 'qpQCCwFj',
    });
    // Without the link that carries it, the code comes from its own line.
    const plain = downloader.filter((line) => !line.includes('?user_code='));
    expect(findPendingDeviceLogin(plain.join('\n'), now)?.userCode).toBe('qpQCCwFj');
  });

  it('takes the newest of several prompts and its own code', () => {
    const older = prompt.map((line) => line.replace(/AbCd1234/g, 'Old11111'));
    const newer = prompt.map((line) =>
      line.replace(/AbCd1234/g, 'New22222').replace('12:00:0', '12:03:0'),
    );
    expect(findPendingDeviceLogin([...older, ...newer].join('\n'), now)).toMatchObject({
      userCode: 'New22222',
      verificationUrl: expect.stringContaining('user_code=New22222'),
    });
  });

  it('reads a log without timestamps and skips lines from before the container started', () => {
    const bare = prompt.map((line) => line.replace(/^\S+ /, ''));
    expect(findPendingDeviceLogin(bare.join('\n'), now)).toMatchObject({
      userCode: 'AbCd1234',
      shownAt: null,
    });
    // An earlier run of the container printed this prompt.
    const started = Date.parse('2026-10-28T12:02:00Z');
    expect(findPendingDeviceLogin(prompt.join('\n'), now, started)).toBeNull();
    const earlier = Date.parse('2026-10-28T11:59:00Z');
    expect(findPendingDeviceLogin(prompt.join('\n'), now, earlier)).not.toBeNull();
  });

  it('ignores a prompt that a finished download or an expired code left behind', () => {
    const done = [...prompt, '2026-10-28T12:01:00.000000000Z [INFO] Download successful!'];
    expect(findPendingDeviceLogin(done.join('\n'), now)).toBeNull();
    expect(findPendingDeviceLogin(prompt.join('\n'), now + 20 * 60 * 1000)).toBeNull();
    expect(findPendingDeviceLogin('[WAIT] Waiting for server files...', now)).toBeNull();
  });
});
