/**
 * The refusals of `/update download|apply|cancel`, which the server answers
 * with a message while the command itself ends normally.
 */
import { describe, it, expect } from 'vitest';
import { updateCommandRefusal } from './updateStatusReply.js';

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
