/**
 * What a game server exit code means.
 *
 * Hytale 0.7 exits with a fixed code per shutdown reason; the start script
 * passes it through as the container's exit code (and prints the same
 * diagnosis, see scripts/start-server.sh). Codes above 128 come from signals.
 */
export type ExitKind =
  /** `/stop`: the server shut down on purpose. */
  | 'clean'
  /** SIGTERM/SIGINT (docker stop, Ctrl+C); Java ran its shutdown sequence. */
  | 'signal'
  /** Restart to apply a staged update (normally handled inside the start script). */
  | 'update'
  /** A crash a restart may fix. */
  | 'crash'
  /** A failure a restart cannot fix (auth, missing assets, broken mod, …). */
  | 'unrecoverable';

export interface ExitInfo {
  code: number;
  /** Stable machine-readable reason, e.g. `auth_failed`. */
  reason: string;
  kind: ExitKind;
  /** Plain-text diagnosis for notifications. */
  message: string;
  /** What the operator can do about it. */
  hint?: string;
}

interface ExitDefinition {
  reason: string;
  kind: ExitKind;
  message: string;
  hint?: string;
}

const EXIT_CODES: Record<number, ExitDefinition> = {
  0: { reason: 'normal', kind: 'clean', message: 'The server was stopped with /stop.' },
  1: {
    reason: 'crash',
    kind: 'crash',
    message: 'The server crashed.',
    hint: 'See the console log for the error.',
  },
  2: {
    reason: 'auth_failed',
    kind: 'unrecoverable',
    message: 'Authentication failed: the server tokens were rejected.',
    hint: 'Remove or renew the server tokens passed via environment or CLI, start the server and run /auth login device.',
  },
  3: {
    reason: 'world_gen_error',
    kind: 'unrecoverable',
    message: 'The world generation config could not be loaded.',
    hint: 'Check the world generation settings of the world named in the log.',
  },
  4: { reason: 'client_gone', kind: 'crash', message: 'The server lost its host client.' },
  5: {
    reason: 'missing_plugin',
    kind: 'unrecoverable',
    message: 'A required plugin or mod is missing.',
    hint: 'Re-add the mod named in the log or remove it from the server config.',
  },
  6: {
    reason: 'validation_error',
    kind: 'unrecoverable',
    message: 'Required game data failed validation.',
    hint: 'See the console log for the file that failed.',
  },
  7: {
    reason: 'missing_assets',
    kind: 'unrecoverable',
    message: 'No asset pack could be loaded.',
    hint: 'Check that Assets.zip exists and matches the server version.',
  },
  8: { reason: 'update', kind: 'update', message: 'The server restarted to apply an update.' },
  9: {
    reason: 'mod_error',
    kind: 'unrecoverable',
    message: 'A mod or plugin failed to load.',
    hint: 'Remove or update the mod named in the log (or start with --ignore-broken-mods).',
  },
  10: {
    reason: 'verify_error',
    kind: 'unrecoverable',
    message: 'World data failed verification (corrupted chunks?).',
    hint: 'Restore the world from a backup.',
  },
  11: {
    reason: 'invalid_install_dir',
    kind: 'unrecoverable',
    message: 'The server runs from an invalid install directory.',
  },
  130: { reason: 'stopped_by_signal', kind: 'signal', message: 'The server was stopped (SIGINT).' },
  143: {
    reason: 'stopped_by_signal',
    kind: 'signal',
    message: 'The server was stopped (SIGTERM, e.g. docker stop).',
  },
};

export function classifyExit(code: number, oomKilled = false): ExitInfo {
  if (code === 137 || oomKilled) {
    return oomKilled
      ? {
          code,
          reason: 'out_of_memory',
          kind: 'crash',
          message: 'The server ran out of memory and was killed.',
          hint: 'Lower JAVA_MAX_RAM or raise DOCKER_MEMORY_LIMIT.',
        }
      : {
          code,
          reason: 'killed',
          kind: 'crash',
          message: 'The server was killed (SIGKILL).',
          hint: 'If this was not a forced stop, check the container memory limit.',
        };
  }
  const known = EXIT_CODES[code];
  if (known) return { code, ...known };
  return {
    code,
    reason: 'unknown',
    kind: 'crash',
    message: `The server exited with code ${code}.`,
  };
}

/** Whether the watchdog may restart the server after this exit. */
export function isRestartable(info: ExitInfo): boolean {
  return info.kind === 'crash';
}
