/**
 * Input Sanitization Utilities
 * Prevents command injection and other security vulnerabilities
 */

// Dangerous shell characters that could be used for command injection
const SHELL_METACHARACTERS = /[;&|`$(){}[\]<>\\!#*?~^\n\r]/g;

// Valid patterns for different input types
const PATTERNS = {
  // Player names: alphanumeric, underscore, hyphen (Minecraft/Hytale standard)
  playerName: /^[a-zA-Z0-9_-]{1,32}$/,
  // Item IDs: namespace:item format
  itemId: /^[a-z][a-z0-9_]*:[a-z][a-z0-9_/]*$/,
  // Numeric values
  integer: /^-?\d+$/,
  float: /^-?\d+(\.\d+)?$/,
  // Coordinates (x, y, z)
  coordinate: /^~?-?\d*\.?\d*$/,
  // Effect names
  effectName: /^[a-z][a-z0-9_]*:?[a-z0-9_]*$/,
  // Gamemode
  gamemode: /^(survival|creative|adventure|spectator|0|1|2|3)$/i,
  // Backup names: alphanumeric, underscore, hyphen
  backupName: /^[a-zA-Z0-9_-]{1,64}$/,
  // File names (safe)
  fileName: /^[a-zA-Z0-9._-]{1,255}$/,
  // UUID
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

/**
 * Sanitize a string by removing shell metacharacters
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  return input.replace(SHELL_METACHARACTERS, '').trim();
}

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
 * Sanitize a message/reason (remove dangerous chars but keep spaces)
 */
export function sanitizeMessage(message: string, maxLength: number = 256): string {
  if (typeof message !== 'string') {
    return '';
  }
  // Remove shell metacharacters but keep basic punctuation and spaces
  return message
    .replace(/[;&|`$(){}[\]<>\\!#*~^]/g, '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .trim()
    .substring(0, maxLength);
}

/**
 * Validate a command is safe (no injection attempts)
 */
export function isCommandSafe(command: string): boolean {
  if (typeof command !== 'string') return false;

  // Check for common injection patterns
  const dangerousPatterns = [
    /[;&|`]/,           // Command chaining
    /\$\(/,             // Command substitution
    /\$\{/,             // Variable expansion
    /[<>]/,             // Redirection
    /\\\n/,             // Line continuation
    /\/\.\.\//,         // Path traversal
  ];

  return !dangerousPatterns.some(pattern => pattern.test(command));
}

/**
 * Build a safe command string from validated parts
 */
export function buildSafeCommand(command: string, args: Record<string, string | number>): string | null {
  // Validate base command
  if (!command.startsWith('/')) {
    return null;
  }

  // Build command with validated arguments
  let result = command;

  for (const [key, value] of Object.entries(args)) {
    const strValue = String(value);

    // Each argument must pass safety check
    if (!isCommandSafe(strValue)) {
      return null;
    }

    result += ' ' + sanitizeString(strValue);
  }

  return result;
}

export default {
  sanitizeString,
  escapeShellArg,
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
  isCommandSafe,
  buildSafeCommand,
};
