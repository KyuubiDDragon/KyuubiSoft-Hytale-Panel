/**
 * Validation of the start parameters the panel stores in panel-config.json:
 * heap size against the container memory limit, extra server arguments
 * against the options the server really knows, extra JVM arguments against a
 * list of harmless forms, and boot commands.
 *
 * Why so strict: an unknown server option makes Hytale 0.7 exit right away
 * ("x is not a recognized option", exit code 1) and Docker's restart policy
 * then gives up after a few tries; options the server needs for a hosted
 * setup (--version, --bare, --shutdown-after-validate, ...) make it exit or
 * run without worlds. JVM options like -javaagent or -XX:OnError load or run
 * arbitrary code, which would turn `config.edit` into code execution in the
 * game container.
 *
 * scripts/start-args.sh applies the same rules again when the server starts
 * (values saved by an older panel version are otherwise passed on unchecked);
 * jvmSettings.script.test.ts runs both against the same cases. Change them
 * together.
 */

/** How an option takes its value (joptsimple semantics). */
type OptionKind = 'flag' | 'value' | 'optional-value';

interface ServerOption {
  kind: OptionKind;
  /** allowed: usable in the extra arguments; managed: set by the panel/image; blocked: never. */
  policy: 'allowed' | 'managed' | 'blocked';
  /** Checks a value (whole value, before any comma split by the server). */
  value?: RegExp;
}

// An absolute path below /opt/hytale without ".." segments.
const PATH_VALUE = /^\/opt\/hytale\/(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9_./-]+$/;
const LOG_LEVEL = '(?:OFF|SEVERE|WARNING|INFO|CONFIG|FINE|FINER|FINEST|ALL)';
const LOG_VALUE = new RegExp(
  `^(?:[A-Za-z0-9_.$-]+:)?${LOG_LEVEL}(?:,(?:[A-Za-z0-9_.$-]+:)?${LOG_LEVEL})*$`,
  'i',
);
const VALIDATION_VALUE =
  /^(?:PHYSICS|BLOCKS|BLOCK_STATES|ENTITIES|BLOCK_FILLER)(?:,(?:PHYSICS|BLOCKS|BLOCK_STATES|ENTITIES|BLOCK_FILLER))*$/;

/**
 * Every option of `java -jar HytaleServer.jar --help` (Hytale 0.7.3). Re-check
 * this list when a server update adds or removes options.
 */
export const HYTALE_SERVER_OPTIONS: Readonly<Record<string, ServerOption>> = {
  'accept-early-plugins': { kind: 'flag', policy: 'managed' },
  'allow-install-dir': { kind: 'flag', policy: 'allowed' },
  'allow-op': { kind: 'flag', policy: 'managed' },
  assets: { kind: 'value', policy: 'managed' },
  'auth-mode': { kind: 'value', policy: 'managed' },
  backup: { kind: 'flag', policy: 'managed' },
  'backup-archive-max-count': { kind: 'value', policy: 'managed' },
  'backup-dir': { kind: 'value', policy: 'managed' },
  'backup-frequency': { kind: 'value', policy: 'managed' },
  'backup-max-count': { kind: 'value', policy: 'managed' },
  bare: { kind: 'flag', policy: 'blocked' },
  bind: { kind: 'value', policy: 'managed' },
  'boot-command': { kind: 'value', policy: 'managed' },
  bootstrap: { kind: 'flag', policy: 'blocked' },
  'client-pid': { kind: 'value', policy: 'blocked' },
  'disable-asset-compare': { kind: 'flag', policy: 'allowed' },
  'disable-cpb-build': { kind: 'flag', policy: 'allowed' },
  'disable-file-watcher': { kind: 'flag', policy: 'allowed' },
  'disable-sentry': { kind: 'flag', policy: 'managed' },
  // Loads code from the given directory.
  'early-plugins': { kind: 'value', policy: 'blocked' },
  'event-debug': { kind: 'flag', policy: 'allowed' },
  'force-network-flush': { kind: 'value', policy: 'allowed', value: /^(?:true|false)$/i },
  'generate-asset-schema': { kind: 'value', policy: 'blocked' },
  'generate-config-schema': { kind: 'value', policy: 'blocked' },
  help: { kind: 'flag', policy: 'blocked' },
  'identity-token': { kind: 'value', policy: 'blocked' },
  'ignore-broken-mods': { kind: 'flag', policy: 'allowed' },
  log: { kind: 'value', policy: 'allowed', value: LOG_VALUE },
  'migrate-worlds': { kind: 'value', policy: 'blocked' },
  migrations: { kind: 'value', policy: 'blocked' },
  mods: { kind: 'value', policy: 'managed' },
  'owner-name': { kind: 'value', policy: 'blocked' },
  'owner-uuid': { kind: 'value', policy: 'blocked' },
  'prefab-cache': { kind: 'value', policy: 'allowed', value: PATH_VALUE },
  'recovery-mode': { kind: 'value', policy: 'blocked' },
  'session-token': { kind: 'value', policy: 'blocked' },
  'shutdown-after-validate': { kind: 'flag', policy: 'blocked' },
  singleplayer: { kind: 'flag', policy: 'blocked' },
  transport: { kind: 'value', policy: 'allowed', value: /^(?:QUIC|QUICHE)$/ },
  universe: { kind: 'value', policy: 'managed' },
  'validate-assets': { kind: 'flag', policy: 'allowed' },
  'validate-prefabs': { kind: 'optional-value', policy: 'allowed', value: VALIDATION_VALUE },
  'validate-world-gen': { kind: 'flag', policy: 'allowed' },
  'verify-worlds': { kind: 'flag', policy: 'blocked' },
  version: { kind: 'flag', policy: 'blocked' },
  'world-gen': { kind: 'value', policy: 'allowed', value: PATH_VALUE },
};

const SHORT_OPTIONS: Readonly<Record<string, string>> = { b: 'bind', t: 'transport' };

const MANAGED_HINT: Readonly<Record<string, string>> = {
  'accept-early-plugins': 'use the "Accept early plugins" switch',
  'allow-op': 'use the "Allow OP" switch',
  'disable-sentry': 'use the "Disable Sentry" switch',
  'boot-command': 'use the boot commands list',
  'backup-max-count': 'use the native backup settings',
  'backup-archive-max-count': 'use the native backup settings',
};

export type ValidationResult = { ok: true } | { ok: false; error: string };

const MAX_ARGS_LENGTH = 1024;
// Characters the start script can pass through unchanged (it splits on
// whitespace and never evaluates the text).
const SAFE_TOKEN = /^[A-Za-z0-9_.:=+\-/,*%$]+$/;

// Split at spaces and tabs only, like the start script; any other whitespace
// stays inside a token and makes it invalid.
function tokenize(args: string): string[] {
  const trimmed = args.replace(/^[ \t]+|[ \t]+$/g, '');
  return trimmed ? trimmed.split(/[ \t]+/) : [];
}

/** Extra server arguments: only known options, used the way the server parses them. */
export function validateExtraServerArgs(args: string): ValidationResult {
  if (args.length > MAX_ARGS_LENGTH) return { ok: false, error: 'Server arguments are too long' };
  const tokens = tokenize(args);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!SAFE_TOKEN.test(token)) return { ok: false, error: `Invalid characters in "${token}"` };
    let name: string;
    let inline: string | undefined;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      name = eq > 0 ? token.slice(2, eq) : token.slice(2);
      inline = eq > 0 ? token.slice(eq + 1) : undefined;
    } else if (/^-[A-Za-z]$/.test(token)) {
      name = SHORT_OPTIONS[token.slice(1)] ?? token;
    } else {
      return {
        ok: false,
        error: `"${token}" is not an option (the server rejects stray arguments)`,
      };
    }
    // Own keys only: "--constructor" or "--toString" are not server options.
    const option = Object.hasOwn(HYTALE_SERVER_OPTIONS, name)
      ? HYTALE_SERVER_OPTIONS[name]
      : undefined;
    if (!option)
      return { ok: false, error: `Unknown server option "${token}" - the server would not start` };
    if (option.policy === 'managed') {
      const hint = MANAGED_HINT[name] ?? 'the panel sets it itself';
      return { ok: false, error: `"--${name}" cannot be set here: ${hint}` };
    }
    if (option.policy === 'blocked') {
      return { ok: false, error: `"--${name}" is not allowed for a hosted server` };
    }
    let value = inline;
    if (option.kind === 'flag' && value !== undefined) {
      return { ok: false, error: `"--${name}" does not take a value` };
    }
    if (option.kind === 'value' && value === undefined) {
      value = tokens[i + 1];
      if (value === undefined) return { ok: false, error: `"--${name}" needs a value` };
      i++;
    }
    if (
      option.kind === 'optional-value' &&
      value === undefined &&
      tokens[i + 1] &&
      !tokens[i + 1].startsWith('-')
    ) {
      value = tokens[++i];
    }
    if (value !== undefined && option.value && !option.value.test(value)) {
      return { ok: false, error: `Invalid value "${value}" for "--${name}"` };
    }
  }
  return { ok: true };
}

// -XX flags (with or without +/- or =value) that are refused by name: they load
// or run code (agents, JVMCI, hsdis via diagnostic flags), read or write files
// at a chosen path (a relative name lands in the server directory and could
// overwrite config.json or the server JAR), override the heap that the panel
// checks against the container limit, or stop SIGTERM from shutting the
// server down cleanly (ReduceSignalUsage).
const BLOCKED_XX_FLAGS = new RegExp(
  '^-XX:[+-]?(?:' +
    [
      'OnError',
      'OnOutOfMemoryError',
      'VMOptionsFile',
      'Flags',
      'CompileCommandFile',
      'AOT\\w*',
      'SharedArchiveFile',
      'SharedClassListFile',
      'ExtraSharedClassListFile',
      'ArchiveClassesAtExit',
      'DumpLoadedClassList',
      'Unlock\\w+VMOptions',
      '\\w*JVMCI\\w*',
      'ErrorFile',
      'HeapDumpPath',
      'LogFile',
      'LogCompilation',
      'LogVMOutput',
      'StartFlightRecording',
      'FlightRecorderOptions',
      'PerfDataSaveFile',
      'AllocateHeapAt',
      'ReduceSignalUsage',
      'MaxHeapSize',
      'InitialHeapSize',
      'MinHeapSize',
      '\\w*RAMPercentage',
      'MaxRAM\\w*',
      'MinRAM\\w*',
      'InitialRAM\\w*',
    ].join('|') +
    ')(?:=|$)',
  'i',
);

// Garbage collector. The start script uses G1 and leaves its -XX:+UseG1GC out
// when the extra arguments pick another collector; two at once stop the JVM
// ("Multiple garbage collectors selected"). Epsilon never frees memory, CMS
// and ParallelOld no longer exist in Java 25.
const GC_SELECTOR = /^-XX:\+Use(Serial|Parallel|G1|Z|Shenandoah)GC$/;
const UNSUPPORTED_GC = /^-XX:[+-]?Use(?:Epsilon|ConcMarkSweep|ParallelOld)GC$/i;

// -D properties: the server's own (hytale.*) and a few harmless ones of the
// Java runtime. Everything else is read by the runtime (class loading, file
// locations, remote management) or by libraries bundled with the server, some
// of them as the path to load a native library from, which would turn a file
// upload into code execution. Operators can still pass any property through
// EXTRA_JAVA_ARGS in the environment.
const ALLOWED_PROPERTY =
  /^-D(?:hytale\.[A-Za-z0-9_.-]+|file\.encoding|java\.net\.preferIPv4Stack|java\.net\.preferIPv6Addresses|java\.awt\.headless|sun\.net\.\w+|jdk\.virtualThreadScheduler\.\w+)(?:=|$)/;

// The only forms accepted at all.
const ALLOWED_JVM = [
  /^-XX:[+-][A-Za-z][A-Za-z0-9_]*$/,
  /^-XX:[A-Za-z][A-Za-z0-9_]*=[A-Za-z0-9_.:+\-,%]*$/,
  /^-D[A-Za-z_][A-Za-z0-9_.-]*(?:=[A-Za-z0-9_.:+\-/,%]*)?$/,
  /^-Xss\d+[kKmM]?$/,
  /^-Xmn\d+[kKmMgG]?$/,
  /^-Xlog:[A-Za-z0-9_*+=:,.\-/%]+$/,
  /^-verbose:(?:gc|class|module|jni)$/,
  /^--(?:add-opens|add-exports|add-reads|enable-native-access)=[A-Za-z0-9_.\-/,=]+$/,
  /^-(?:ea|da|esa|dsa)$/,
];

// -Xlog:<what>:<output>:<decorators>:<output-options>. Java treats every output
// other than stdout/stderr as a file, with or without "file=", relative to the
// server directory: only a file in its logs folder is allowed, anything else
// could truncate config.json or the server JAR. The token pattern above
// allows no quotes, so splitting at ':' gives the real fields.
const XLOG_OUTPUT = /^(?:stdout|stderr|(?:file=)?logs\/[A-Za-z0-9_%-][A-Za-z0-9_.%-]*)$/;
const XLOG_MAX_FIELDS = 4;

/** Extra JVM arguments: harmless tuning only. */
export function validateExtraJavaArgs(args: string): ValidationResult {
  if (args.length > MAX_ARGS_LENGTH) return { ok: false, error: 'Java arguments are too long' };
  const collectors = new Set<string>();
  for (const token of tokenize(args)) {
    if (/^-X(?:mx|ms)/i.test(token)) {
      return { ok: false, error: `"${token}": set the heap with the RAM fields` };
    }
    if (
      /^(?:-javaagent|-agent(?:lib|path)|-Xbootclasspath|@)/i.test(token) ||
      BLOCKED_XX_FLAGS.test(token)
    ) {
      return {
        ok: false,
        error: `"${token}" is not allowed (loads code, writes files, changes the runtime or the heap the panel manages)`,
      };
    }
    if (token.startsWith('-D') && !ALLOWED_PROPERTY.test(token)) {
      return {
        ok: false,
        error: `"${token}": only -Dhytale.* and a few Java properties (file.encoding, java.net.preferIPv4Stack, ...) can be set here`,
      };
    }
    if (UNSUPPORTED_GC.test(token)) {
      return {
        ok: false,
        error: `"${token}": this garbage collector does not exist in Java 25 or never frees memory`,
      };
    }
    if (!ALLOWED_JVM.some((re) => re.test(token))) {
      return {
        ok: false,
        error: `"${token}" is not an accepted JVM option (allowed: -XX:..., -D..., -Xss, -Xmn, -Xlog:..., --add-opens=...)`,
      };
    }
    if (token.startsWith('-Xlog:')) {
      const [what, output, ...rest] = token.slice('-Xlog:'.length).split(':');
      if (/^help$/i.test(what)) {
        return { ok: false, error: `"${token}": -Xlog:help only prints and exits` };
      }
      if (rest.length > XLOG_MAX_FIELDS - 2 || (output && !XLOG_OUTPUT.test(output))) {
        return { ok: false, error: `"${token}": -Xlog may only write to logs/<file>` };
      }
    }
    const gc = GC_SELECTOR.exec(token);
    if (gc) collectors.add(gc[1]);
  }
  if (collectors.size > 1) {
    return {
      ok: false,
      error: `Only one garbage collector can be selected (${[...collectors].map((c) => `-XX:+Use${c}GC`).join(', ')})`,
    };
  }
  return { ok: true };
}

// ---------- heap vs. container limit ----------

const JVM_HEADROOM_MAX_MB = 1536;

/** "3G" / "512M" → MB (null if not a size the panel accepts). */
export function ramToMb(value: string): number | null {
  const m = /^(\d{1,5})([MmGg])$/.exec(value);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return m[2].toUpperCase() === 'G' ? n * 1024 : n;
}

/**
 * Largest heap that fits the container's memory limit: the JVM needs memory
 * beyond the heap (metaspace, threads, code cache, direct buffers, GC). Keeps a
 * quarter of the limit, at most 1.5 GB. Same rule as start-server.sh.
 */
export function maxHeapMbForLimit(limitBytes: number | null): number | null {
  if (!limitBytes || limitBytes <= 0) return null;
  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  return limitMb - Math.min(JVM_HEADROOM_MAX_MB, Math.floor(limitMb / 4));
}

// ---------- boot commands ----------

const MAX_BOOT_COMMANDS = 20;
const MAX_BOOT_COMMAND_LENGTH = 200;

/**
 * Normalizes and checks the boot command list: one console command per entry,
 * stored without the leading slash (the server runs boot commands without the
 * console's slash handling). Hytale splits every --boot-command value at
 * commas, so a command containing a comma cannot be passed this way.
 */
export function normalizeBootCommands(
  input: unknown,
): { ok: true; commands: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, commands: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'bootCommands must be a list' };
  if (input.length > MAX_BOOT_COMMANDS) {
    return { ok: false, error: `At most ${MAX_BOOT_COMMANDS} boot commands` };
  }
  const commands: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, error: 'Every boot command must be text' };
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(raw))
      return { ok: false, error: 'Boot commands must be a single line' };
    const command = raw.trim().replace(/^\/+/, '');
    if (!command) continue;
    if (command.length > MAX_BOOT_COMMAND_LENGTH)
      return { ok: false, error: 'Boot command too long' };
    if (command.includes(',')) {
      return {
        ok: false,
        error: `"${command}": the server splits boot commands at commas, so a command with a comma cannot run at boot`,
      };
    }
    commands.push(command);
  }
  return { ok: true, commands };
}
