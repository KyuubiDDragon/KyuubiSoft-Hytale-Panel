/**
 * Reads the server's replies to `/update` commands.
 *
 * The Update Center takes its state from the installation's files
 * (services/updateCenter.ts); what it needs from a reply is whether the server
 * refused one of the panel's own commands (updateCommandRefusal below).
 */

/**
 * Why the server turned down one of the panel's `/update download|apply|cancel`
 * commands. Where the Update Center has a reason of its own for the same state
 * (nothing_staged, invalid_layout), the same name is used.
 */
export type UpdateCommandRefusal =
  | 'updates_disabled'
  | 'not_authenticated'
  | 'check_failed'
  | 'no_update'
  | 'download_in_progress'
  | 'invalid_layout'
  | 'download_failed'
  | 'nothing_staged'
  | 'confirm_required'
  | 'backup_failed'
  | 'cancel_failed';

// Message ids of the server's answers that mean "not done". They are the same
// in every server language, unlike the text.
const REFUSAL_MESSAGE_IDS: ReadonlyMap<string, UpdateCommandRefusal> = new Map([
  ['server.commands.update.disabled', 'updates_disabled'],
  ['server.commands.update.not_authenticated', 'not_authenticated'],
  ['server.commands.update.check_failed', 'check_failed'],
  ['server.commands.update.no_update', 'no_update'],
  ['server.commands.update.download_in_progress', 'download_in_progress'],
  ['server.commands.update.invalid_layout_download', 'invalid_layout'],
  ['server.commands.update.download_failed', 'download_failed'],
  ['server.commands.update.no_staged', 'nothing_staged'],
  ['server.commands.update.apply_confirm_required', 'confirm_required'],
  ['server.commands.update.backup_failed', 'backup_failed'],
  ['server.commands.update.cancel_failed', 'cancel_failed'],
]);

/**
 * The server's own "no" to an `/update` command, or null. The server answers a
 * refused download or apply with a message and ends the command normally, so
 * through the plugin it counts as done; only the message ids of the reply tell.
 * Over stdin there is no reply and nothing to tell (null).
 */
export function updateCommandRefusal(result: {
  messageIds?: readonly string[];
}): UpdateCommandRefusal | null {
  for (const id of result.messageIds ?? []) {
    const refusal = REFUSAL_MESSAGE_IDS.get(id);
    if (refusal) return refusal;
  }
  return null;
}
