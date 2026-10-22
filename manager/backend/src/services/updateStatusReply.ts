/**
 * Reads the server's reply to `/update status`.
 *
 * Through the KyuubiSoft API plugin the panel gets the real reply, one field
 * per line, in the server's language file wording:
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
