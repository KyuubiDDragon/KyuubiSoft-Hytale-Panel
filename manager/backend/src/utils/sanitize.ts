/**
 * Input Sanitization Utilities
 * Prevents command injection and other security vulnerabilities
 */
import { isKnownCommandLine } from './commandWhitelist.js';

// C0 controls (incl. \t \n \r), DEL, C1 controls and the Unicode line/paragraph
// separators. The game console executes every stdin line with full console
// rights, and because the container runs with a TTY, control bytes act as key
// presses (Ctrl-C shuts the server down, ESC sequences recall history). None of
// them may ever reach the console as part of a command.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_RUNS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * A player name as the panel puts it into a command: letters, digits,
 * underscore and hyphen, but no hyphen first, where the server's command
 * parser would read `--word` as an option.
 */
export const PLAYER_NAME_SOURCE = '[A-Za-z0-9_][A-Za-z0-9_-]{0,31}';

// Valid patterns for different input types
const PATTERNS = {
  playerName: new RegExp(`^${PLAYER_NAME_SOURCE}$`),
  // Item IDs: item_name format (with optional namespace:prefix)
  itemId: /^[a-z][a-z0-9_]*(:[a-z][a-z0-9_/]*)?$/,
  // Numeric values
  integer: /^-?\d+$/,
  float: /^-?\d+(\.\d+)?$/,
  // Coordinates (x, y, z)
  coordinate: /^~?-?\d*\.?\d*$/,
  // Effect names
  effectName: /^[a-z][a-z0-9_]*:?[a-z0-9_]*$/,
  // Gamemode (Hytale only supports creative and adventure)
  gamemode: /^(creative|adventure|c|a)$/i,
  // Backup names: alphanumeric, underscore, hyphen
  backupName: /^[a-zA-Z0-9_-]{1,64}$/,
  // File names (safe)
  fileName: /^[a-zA-Z0-9._-]{1,255}$/,
  // UUID
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

/**
 * Escape a string for safe use in shell commands
 * This should be used sparingly - prefer validation over escaping
 */
export function escapeShellArg(input: string): string {
  if (typeof input !== 'string') {
    return "''";
  }
  // Replace single quotes with escaped version and wrap in single quotes
  return "'" + input.replace(/'/g, "'\\''") + "'";
}

/**
 * True when the string contains a control character or a Unicode line/paragraph
 * separator (see CONTROL_CHARACTERS).
 */
export function containsControlChars(input: string): boolean {
  return typeof input === 'string' && CONTROL_CHARACTERS.test(input);
}

/**
 * Replace every run of control characters with a single space. For free text
 * (reasons, chat relays, announcements) that is embedded into a command.
 */
export function stripControlChars(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  return input.replace(CONTROL_CHARACTER_RUNS, ' ');
}

/**
 * Validate player name
 */
export function isValidPlayerName(name: string): boolean {
  return typeof name === 'string' && PATTERNS.playerName.test(name);
}

/**
 * Validate and sanitize player name
 */
export function sanitizePlayerName(name: string): string | null {
  if (!isValidPlayerName(name)) {
    return null;
  }
  return name;
}

/**
 * Validate item ID (namespace:item format)
 */
export function isValidItemId(itemId: string): boolean {
  return typeof itemId === 'string' && PATTERNS.itemId.test(itemId);
}

/**
 * Validate integer
 */
export function isValidInteger(value: string | number): boolean {
  const str = String(value);
  return PATTERNS.integer.test(str);
}

/**
 * Validate float/coordinate
 */
export function isValidNumber(value: string | number): boolean {
  const str = String(value);
  return PATTERNS.float.test(str) || PATTERNS.coordinate.test(str);
}

/**
 * Validate coordinate (can include ~ for relative)
 */
export function isValidCoordinate(value: string | number): boolean {
  const str = String(value);
  return PATTERNS.coordinate.test(str);
}

/**
 * Validate effect name
 */
export function isValidEffectName(name: string): boolean {
  return typeof name === 'string' && PATTERNS.effectName.test(name);
}

/**
 * Validate gamemode
 */
export function isValidGamemode(mode: string): boolean {
  return typeof mode === 'string' && PATTERNS.gamemode.test(mode);
}

/**
 * Validate backup name
 */
export function isValidBackupName(name: string): boolean {
  return typeof name === 'string' && PATTERNS.backupName.test(name);
}

/**
 * Validate file name (no path traversal)
 */
export function isValidFileName(name: string): boolean {
  if (typeof name !== 'string') return false;
  // Check pattern and ensure no path traversal
  return PATTERNS.fileName.test(name) && !name.includes('..');
}

/**
 * Validate UUID
 */
export function isValidUUID(uuid: string): boolean {
  return typeof uuid === 'string' && PATTERNS.uuid.test(uuid);
}

/**
 * A reason or note as one line of plain text: control characters become a
 * space, nothing else is removed. Text that goes into a console command also
 * needs toCommandText.
 */
export function sanitizeMessage(message: string, maxLength: number = 256): string {
  if (typeof message !== 'string') {
    return '';
  }
  return stripControlChars(message).trim().substring(0, maxLength);
}

/**
 * Free text (announcements, chat relays, reasons) as a command argument the
 * server takes literally. The console is no shell, so < > & ; | $ stay. The
 * Hytale command parser reads the whole line first, though, and rejects the
 * command on an unbalanced " (or ' at the start of a word), a backslash, a
 * stray or nested [ ], two commas in a row or a word starting with "--" (an
 * option name). Those get a look-alike; a comma at the very start (it would
 * make the preceding word a list, e.g. the player of /ban) is dropped. A
 * leading "{" would make /say and /notify parse the text as a formatted
 * (JSON) message.
 */
export function toCommandText(text: string, maxLength: number = 256): string {
  if (typeof text !== 'string') {
    return '';
  }
  return (
    stripControlChars(text)
      .replace(/"/g, '”')
      .replace(/(^|[\s,])'/g, '$1’')
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/\\/g, '/')
      .replace(/,(\s*,)+/g, ',')
      .replace(/(^|[\s,])--/g, '$1–')
      .replace(/\s+/g, ' ')
      .trim()
      // A leading comma would turn the word before the text into a list.
      .replace(/^[,\s]+/, '')
      .replace(/^\{/, '(')
      .slice(0, maxLength)
      .trim()
  );
}

// The plugin refuses longer command lines.
const MAX_COMMAND_LENGTH = 4096;

/**
 * SECURITY: the central check for every line that goes to the game console
 * (docker.execCommand runs it on both delivery paths). A command must be one
 * line without control characters and start with a command that exists: on a
 * vanilla 0.7.3 server or in a server registry the panel has loaded (see
 * utils/commandWhitelist.ts). Which permission tier a command needs, on which
 * server, is decided by services/commandPolicy.ts.
 */
export function validateCommand(command: string): { valid: boolean; error?: string } {
  if (typeof command !== 'string' || !command.trim()) {
    return { valid: false, error: 'Command is required' };
  }

  // Checked on the raw string, before trim() can hide a trailing line break:
  // the console runs every line it receives, so a command must be one line.
  if (containsControlChars(command)) {
    return { valid: false, error: 'Command must be a single line without control characters' };
  }

  if (!command.trim().startsWith('/')) {
    return { valid: false, error: 'Command must start with /' };
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    return { valid: false, error: `Command is longer than ${MAX_COMMAND_LENGTH} characters` };
  }

  if (!isKnownCommandLine(command)) {
    return { valid: false, error: "Unknown command. Use /help for the server's commands." };
  }

  return { valid: true };
}

export default {
  escapeShellArg,
  containsControlChars,
  stripControlChars,
  isValidPlayerName,
  sanitizePlayerName,
  isValidItemId,
  isValidInteger,
  isValidNumber,
  isValidCoordinate,
  isValidEffectName,
  isValidGamemode,
  isValidBackupName,
  isValidFileName,
  isValidUUID,
  sanitizeMessage,
  toCommandText,
  validateCommand,
};
