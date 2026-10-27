/**
 * `/update status` replies as the KyuubiSoft API plugin returns them (one
 * field per line, the server's own wording). "Staged: none" is in every reply,
 * so a keyword search reported every server as having an update ready.
 *
 * Also the refusals of `/update download|apply|cancel`, which the server
 * answers with a message while the command itself ends normally.
 */
import { describe, it, expect } from 'vitest';
import { parseUpdateStatusReply, updateCommandRefusal } from './updateStatusReply.js';

const reply = (staged: string, latest: string, downloading = 'no', version = '0.7.3') =>
  [
    `Version: ${version}`,
    'Patchline: release',
    `Staged: ${staged}`,
    `Latest: ${latest}`,
    `Downloading: ${downloading}`,
  ].join('\n');

describe('parseUpdateStatusReply', () => {
  it('reports nothing staged and nothing checked as idle, not ready', () => {
    const status = parseUpdateStatusReply(reply('none', 'not checked'));
    expect(status).toMatchObject({
      state: 'IDLE',
      available: false,
      currentVersion: '0.7.3',
      latestVersion: 'unknown',
      patchline: 'release',
    });
    expect(status?.stagedVersion).toBeUndefined();
    expect(status?.progress).toBeUndefined();
  });

  it('reports an up-to-date server with latest = current', () => {
    const status = parseUpdateStatusReply(reply('none', 'up to date'));
    expect(status).toMatchObject({
      state: 'IDLE',
      available: false,
      currentVersion: '0.7.3',
      latestVersion: '0.7.3',
    });
  });

  it('reports an offered but not yet downloaded update as available, still idle', () => {
    const status = parseUpdateStatusReply(reply('none', '0.7.4 available'));
    expect(status).toMatchObject({ state: 'IDLE', available: true, latestVersion: '0.7.4' });
  });

  it('reports a staged update as ready', () => {
    const status = parseUpdateStatusReply(reply('0.7.4', '0.7.4 available'));
    expect(status).toMatchObject({
      state: 'READY',
      available: true,
      stagedVersion: '0.7.4',
      latestVersion: '0.7.4',
    });
  });

  it('takes the staged version as target when the check result is gone', () => {
    const status = parseUpdateStatusReply(reply('0.7.4', 'not checked'));
    expect(status).toMatchObject({ state: 'READY', latestVersion: '0.7.4' });
  });

  it('reads a running download with and without ETA', () => {
    expect(
      parseUpdateStatusReply(reply('none', '0.7.4 available', '42% (420 MB / 1.0 GB)')),
    ).toMatchObject({ state: 'DOWNLOADING', progress: 42, available: true });
    expect(
      parseUpdateStatusReply(reply('none', '0.7.4 available', '7% (70 MB / 1.0 GB) ETA: 3m 10s')),
    ).toMatchObject({ state: 'DOWNLOADING', progress: 7 });
    expect(parseUpdateStatusReply(reply('none', '0.7.4 available', 'starting...'))).toMatchObject({
      state: 'DOWNLOADING',
      progress: 0,
    });
  });

  it('keeps "unknown" placeholders out of the versions', () => {
    const status = parseUpdateStatusReply(reply('none', 'unknown', 'no', 'unknown'));
    expect(status).toMatchObject({
      currentVersion: 'unknown',
      latestVersion: 'unknown',
      state: 'IDLE',
      available: false,
    });
  });

  it('tolerates CRLF line ends and surrounding blanks', () => {
    const text =
      '  Version: 0.7.3 \r\nPatchline: pre-release\r\nStaged: none\r\nLatest: up to date\r\n';
    expect(parseUpdateStatusReply(text)).toMatchObject({
      state: 'IDLE',
      latestVersion: '0.7.3',
      patchline: 'pre-release',
    });
  });

  it('returns null for text that is not a status reply', () => {
    expect(parseUpdateStatusReply('Command executed: /update status')).toBeNull();
    expect(parseUpdateStatusReply('Update commands are disabled by the server host.')).toBeNull();
    expect(parseUpdateStatusReply('')).toBeNull();
  });
});

describe('updateCommandRefusal', () => {
  it('reads "nothing staged" from the reply to /update apply --confirm', () => {
    expect(updateCommandRefusal({ messageIds: ['server.commands.update.no_staged'] })).toBe(
      'nothing_staged',
    );
  });

  it('reads the refusals of /update download', () => {
    const cases = [
      ['server.commands.update.not_authenticated', 'not_authenticated'],
      ['server.commands.update.no_update', 'no_update'],
      ['server.commands.update.download_in_progress', 'download_in_progress'],
      ['server.commands.update.invalid_layout_download', 'invalid_layout'],
      ['server.commands.update.check_failed', 'check_failed'],
    ] as const;
    for (const [id, reason] of cases) {
      expect(updateCommandRefusal({ messageIds: [id] })).toBe(reason);
    }
  });

  it('reads a failed pre-update backup, a failed discard and disabled updates', () => {
    expect(updateCommandRefusal({ messageIds: ['server.commands.update.backup_failed'] })).toBe(
      'backup_failed',
    );
    expect(updateCommandRefusal({ messageIds: ['server.commands.update.cancel_failed'] })).toBe(
      'cancel_failed',
    );
    expect(updateCommandRefusal({ messageIds: ['server.commands.update.disabled'] })).toBe(
      'updates_disabled',
    );
  });

  it('finds the refusal behind other lines of the same reply', () => {
    expect(
      updateCommandRefusal({
        messageIds: [
          'server.commands.update.downloading',
          'server.commands.update.download_failed',
        ],
      }),
    ).toBe('download_failed');
  });

  it('does not count the answers of commands that went ahead', () => {
    for (const id of [
      'server.commands.update.applying',
      'server.commands.update.downloading',
      'server.commands.update.cancelled',
      'server.commands.update.download_cancelled',
      'server.commands.update.nothing_to_cancel',
    ]) {
      expect(updateCommandRefusal({ messageIds: [id] })).toBeNull();
    }
  });

  it('has nothing to read from a stdin result', () => {
    expect(updateCommandRefusal({})).toBeNull();
    expect(updateCommandRefusal({ messageIds: [] })).toBeNull();
  });
});
