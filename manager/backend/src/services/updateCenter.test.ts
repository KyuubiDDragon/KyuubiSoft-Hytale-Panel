/**
 * Unit tests for the pure parts of the Update Center: downloader output,
 * capability matrix, `.hytale-version` format, pending history entries and
 * the per-filesystem disk check.
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import { parseDownloaderOutput } from './updateCenter.js';
import { capabilitiesFor } from './hytaleAdapter.js';
import { parseVersionFile, checkDiskSpace } from './serverInstall.js';
import { reconcilePendingUpdates, type UpdateHistoryEntry } from './updateHistory.js';
import { DOWNLOADER_BUSY_MARKER } from '../routes/server/shared.js';

describe('parseDownloaderOutput', () => {
  it('reads current and newer version from -version / -check-update', () => {
    const out =
      '2026.01.09-49e5904\nA new version of hytale-downloader is available: 2026.05.13-99ade04 (current: 2026.01.09-49e5904)Download it from: https://downloader.hytale.com/hytale-downloader.zip';
    expect(parseDownloaderOutput(out)).toEqual({
      installed: true,
      version: '2026.01.09-49e5904',
      latestVersion: '2026.05.13-99ade04',
      updateAvailable: true,
      busy: false,
    });
  });

  it('treats a missing update notice as up to date', () => {
    // Real output of -version + -check-update of an up-to-date downloader
    expect(
      parseDownloaderOutput(
        '2026.05.13-99ade04\nhytale-downloader is up to date (2026.05.13-99ade04)\n',
      ),
    ).toMatchObject({
      version: '2026.05.13-99ade04',
      latestVersion: '2026.05.13-99ade04',
      updateAvailable: false,
    });
  });

  it('reports a missing binary and a held lock', () => {
    expect(parseDownloaderOutput('__NO_DOWNLOADER__').installed).toBe(false);
    expect(parseDownloaderOutput(`${DOWNLOADER_BUSY_MARKER}\n`)).toMatchObject({
      busy: true,
      latestVersion: null,
    });
  });
});

describe('capabilitiesFor', () => {
  it('has native updates for every 0.x release (the old check said false for 0.7)', () => {
    expect(capabilitiesFor('0.7.3').supportsNativeUpdates).toBe(true);
    expect(capabilitiesFor('0.5.0').supportsNativeUpdates).toBe(true);
  });

  it('dates the features for the older date-based versions', () => {
    expect(capabilitiesFor('2026.01.13-abc').supportsNativeUpdates).toBe(false);
    expect(capabilitiesFor('2026.01.24-abc').supportsNativeUpdates).toBe(true);
    expect(capabilitiesFor('2026.03.01').supportsServerBrowser).toBe(false);
    expect(capabilitiesFor('2026.05.28').supportsServerBrowser).toBe(true);
  });

  it('server browser from Update 5 (0.5) on; unknown versions get current defaults', () => {
    expect(capabilitiesFor('0.4.9').supportsServerBrowser).toBe(false);
    expect(capabilitiesFor('0.6.1').supportsServerBrowser).toBe(true);
    expect(capabilitiesFor(null)).toMatchObject({
      supportsNativeUpdates: true,
      supportsServerBrowser: true,
    });
  });
});

describe('parseVersionFile', () => {
  it('reads version and patchline, and the old one-line format', () => {
    expect(parseVersionFile('0.7.3\nrelease\n')).toEqual({
      version: '0.7.3',
      patchline: 'release',
    });
    expect(parseVersionFile('0.7.2\r\n')).toEqual({ version: '0.7.2', patchline: null });
    expect(parseVersionFile('')).toEqual({ version: null, patchline: null });
  });
});

describe('reconcilePendingUpdates', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const pending = (minutesAgo: number): UpdateHistoryEntry => ({
    id: 'x',
    at: new Date(now - minutesAgo * 60_000).toISOString(),
    action: 'apply',
    fromVersion: '0.7.2',
    toVersion: '0.7.3',
    by: 'admin',
    success: false,
    pending: true,
  });

  it('confirms once the target version is installed', () => {
    const [e] = reconcilePendingUpdates(
      [pending(2)],
      { installedVersion: '0.7.3', stagedPresent: false },
      now,
    );
    expect(e).toMatchObject({ pending: false, success: true });
  });

  it('stays pending while the staged update waits, fails when it vanished without effect', () => {
    expect(
      reconcilePendingUpdates(
        [pending(2)],
        { installedVersion: '0.7.2', stagedPresent: true },
        now,
      )[0].pending,
    ).toBe(true);
    const [failed] = reconcilePendingUpdates(
      [pending(2)],
      { installedVersion: '0.7.2', stagedPresent: false },
      now,
    );
    expect(failed).toMatchObject({ pending: false, success: false });
    expect(failed.note).toMatch(/0\.7\.2/);
  });

  it('gives up after the timeout', () => {
    const [e] = reconcilePendingUpdates(
      [pending(45)],
      { installedVersion: '0.7.2', stagedPresent: true },
      now,
    );
    expect(e).toMatchObject({ pending: false, success: false });
  });

  it('leaves finished entries alone', () => {
    const done = { ...pending(500), pending: false, success: true };
    expect(
      reconcilePendingUpdates([done], { installedVersion: null, stagedPresent: false }, now)[0],
    ).toBe(done);
  });
});

describe('checkDiskSpace', () => {
  it('sums the needs of one filesystem and compares with its free space', async () => {
    const dir = os.tmpdir();
    const small = await checkDiskSpace([
      { purpose: 'a', dir, bytes: 1 },
      { purpose: 'b', dir, bytes: 1 },
    ]);
    expect(small.checked).toBe(true);
    expect(small.volumes).toHaveLength(1);
    expect(small.sufficient).toBe(true);
    const huge = await checkDiskSpace([{ purpose: 'a', dir, bytes: Number.MAX_SAFE_INTEGER / 2 }]);
    expect(huge.sufficient).toBe(false);
  });

  it('does not block when a directory cannot be inspected', async () => {
    const r = await checkDiskSpace([{ purpose: 'a', dir: '/does/not/exist/anywhere', bytes: 10 }]);
    expect(r).toMatchObject({ checked: false, sufficient: true });
  });
});
