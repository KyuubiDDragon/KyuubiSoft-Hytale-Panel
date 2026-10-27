/**
 * Reads the server's replies to `/update` commands.
 *
 * The Update Center takes its state from the installation's files
 * (services/updateCenter.ts); what it needs from a reply is whether the server
 * refused one of the panel's own commands (updateCommandRefusal below).
 *
 * `/update status` (parseUpdateStatusReply): through the KyuubiSoft API
 * plugin the panel gets the real reply, one field per line, in the server's
 * language file wording:
 *
 *   Version: 0.7.3
 *   Patchline: release
 *   Staged: none                  | <version>
 *   Latest: not checked           | up to date | <version> available | unknown
 *   Downloading: no               | starting... | <percent>% (<done> / <total>)[ ETA: <eta>]
 *
 * "Staged: none" is part of every reply, so the field values have to be read;
 * looking for the word "staged" anywhere reports an update as ready that was
 * never downloaded. Over stdin there is no reply at all (only "Command
 * executed: …"); then parseUpdateStatusReply returns null and the caller keeps
 * its own fallback.
 */

export type UpdateState = 'IDLE' | 'CHECKING' | 'DOWNLOADING' | 'READY' | 'APPLYING' | 'ERROR';

export interface UpdateStatusFromReply {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  state: UpdateState;
  progress?: number;
  message: string;
  /** Version waiting in the staging folder, or undefined when none is staged. */
  stagedVersion?: string;
  patchline?: string;
}

const FIELD = /^\s*(version|patchline|staged|latest|downloading)\s*:\s*(.*?)\s*$/i;
const AVAILABLE = /^(.+?)\s+available$/i;
const PERCENT = /^(\d+(?:[.,]\d+)?)\s*%/;
const MAX_VALUE_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 200;

function fields(output: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = FIELD.exec(line);
    if (match && !found.has(match[1].toLowerCase())) {
      found.set(match[1].toLowerCase(), match[2].slice(0, MAX_VALUE_LENGTH));
    }
  }
  return found;
}

/** A field value the server fills with a placeholder when it has none. */
function versionValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return lower === 'none' || lower === 'unknown' ? undefined : value;
}

/** Download progress in percent, 0 while starting, or undefined when no download runs. */
function downloadProgress(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'no') return undefined;
  if (lower.startsWith('starting')) return 0;
  const percent = PERCENT.exec(value);
  if (!percent) return undefined;
  return Math.max(0, Math.min(100, Math.round(parseFloat(percent[1].replace(',', '.')))));
}

/**
 * The status in the reply, or null when the text is not a `/update status`
 * reply (it needs at least the "Version:" and "Staged:" lines).
 */
export function parseUpdateStatusReply(output: string): UpdateStatusFromReply | null {
  if (typeof output !== 'string' || !output) return null;
  const values = fields(output);
  if (!values.has('version') || !values.has('staged')) return null;

  const currentVersion = versionValue(values.get('version')) ?? 'unknown';
  const stagedVersion = versionValue(values.get('staged'));
  const latest = (values.get('latest') ?? '').trim();
  const latestLower = latest.toLowerCase();
  const offered = AVAILABLE.exec(latest)?.[1];
  const progress = downloadProgress(values.get('downloading'));

  let latestVersion = offered ?? stagedVersion ?? 'unknown';
  if (!offered && !stagedVersion && latestLower === 'up to date') latestVersion = currentVersion;

  let state: UpdateState = 'IDLE';
  if (progress !== undefined) state = 'DOWNLOADING';
  else if (stagedVersion) state = 'READY';

  return {
    available: stagedVersion !== undefined || offered !== undefined,
    currentVersion,
    latestVersion,
    state,
    ...(progress !== undefined ? { progress } : {}),
    message: output.substring(0, MAX_MESSAGE_LENGTH),
    ...(stagedVersion ? { stagedVersion } : {}),
    ...(values.get('patchline') ? { patchline: values.get('patchline') } : {}),
  };
}

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
