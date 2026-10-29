/**
 * Regression tests for the start-parameter validation.
 *
 * Hytale 0.7 exits with code 1 on an unknown option ("foo is not a recognized
 * option"), and -javaagent & co. turned config.edit into code execution.
 */
import { describe, it, expect } from 'vitest';
import {
  validateExtraServerArgs,
  validateExtraJavaArgs,
  normalizeBootCommands,
  maxHeapMbForLimit,
  ramToMb,
  HYTALE_SERVER_OPTIONS,
} from './jvmSettings.js';

describe('validateExtraServerArgs', () => {
  it('accepts known, allowed options with valid values', () => {
    for (const args of [
      '',
      '--ignore-broken-mods',
      '--disable-file-watcher --log WARNING,PacketLogging:OFF',
      '--log=FINE',
      '--transport QUICHE',
      '-t QUIC',
      '--validate-prefabs',
      '--validate-prefabs BLOCKS,ENTITIES --validate-assets',
      '--prefab-cache /opt/hytale/data/prefab-cache',
      '--force-network-flush false',
    ]) {
      expect(validateExtraServerArgs(args), args).toEqual({ ok: true });
    }
  });

  it('rejects unknown options and stray words, which stop the server', () => {
    expect(validateExtraServerArgs('--foo').ok).toBe(false);
    expect(validateExtraServerArgs('--ignore-broken-mods extra').ok).toBe(false);
    expect(validateExtraServerArgs('-x').ok).toBe(false);
  });

  it('does not take names of the object prototype for server options', () => {
    for (const args of ['--constructor', '--toString', '--__proto__', '--hasOwnProperty x']) {
      expect(validateExtraServerArgs(args).ok, args).toBe(false);
    }
  });

  it('rejects options the panel manages, with a hint', () => {
    const r = validateExtraServerArgs('--boot-command stop');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/boot commands list/);
    for (const args of [
      '--universe /opt/hytale/x',
      '--mods /opt/hytale/mods',
      '-b 0.0.0.0:5521',
      '--allow-op',
      '--backup-max-count 3',
    ]) {
      expect(validateExtraServerArgs(args).ok, args).toBe(false);
    }
  });

  it('rejects options that end the server, load code or leak secrets', () => {
    for (const args of [
      '--early-plugins /opt/hytale/plugins',
      '--version',
      '--help',
      '--bare',
      '--shutdown-after-validate',
      '--verify-worlds',
      '--session-token abc',
    ]) {
      expect(validateExtraServerArgs(args).ok, args).toBe(false);
    }
  });

  it('checks values: missing, malformed, paths outside /opt/hytale or with ..', () => {
    for (const args of [
      '--log',
      '--log LOUD',
      '--transport TCP',
      '--disable-sentry=true',
      '--force-network-flush maybe',
      '--prefab-cache /etc/passwd',
      '--prefab-cache /opt/hytale/../etc',
      '--world-gen /opt/hytale/a/../../etc',
      '--log FINE;rm',
    ]) {
      expect(validateExtraServerArgs(args).ok, args).toBe(false);
    }
  });

  it('covers every option of the 0.7.3 --help output', () => {
    expect(Object.keys(HYTALE_SERVER_OPTIONS)).toHaveLength(46);
  });
});

describe('validateExtraJavaArgs', () => {
  it('accepts common tuning flags', () => {
    for (const args of [
      '',
      '-XX:+UseZGC -XX:+ZGenerational',
      '-XX:MaxGCPauseMillis=100 -Dfile.encoding=UTF-8',
      '-Xss1m -Dhytale.allow_outdated_mods',
      '-Xlog:gc*:file=logs/gc.log:time,uptime:filecount=5,filesize=20M',
      '--add-opens=java.base/java.lang=ALL-UNNAMED',
    ]) {
      expect(validateExtraJavaArgs(args), args).toEqual({ ok: true });
    }
  });

  it('rejects code-loading and panel-managed options', () => {
    for (const args of [
      '-javaagent:/opt/hytale/mods/agent.jar',
      '-agentlib:jdwp=transport=dt_socket',
      '-agentpath:/tmp/x.so',
      '-XX:OnError=/bin/sh',
      '-XX:OnOutOfMemoryError=touch',
      '-XX:VMOptionsFile=/opt/hytale/data/x',
      '-XX:AOTCache=HytaleServer.aot',
      '@/opt/hytale/data/args',
      '-cp /tmp',
      '-Djava.library.path=/opt/hytale/mods',
      '-Djava.system.class.loader=Evil',
      '-Xbootclasspath/a:/tmp/x.jar',
      '-Xmx8G',
      '-Xms2G',
    ]) {
      expect(validateExtraJavaArgs(args).ok, args).toBe(false);
    }
  });

  it('keeps -Xlog output inside the logs folder', () => {
    expect(validateExtraJavaArgs('-Xlog:gc:file=/opt/hytale/mods/x.jar').ok).toBe(false);
    expect(validateExtraJavaArgs('-Xlog:gc:file=../config.json').ok).toBe(false);
    // relative to the server directory: would truncate the server's config
    expect(validateExtraJavaArgs('-Xlog:all:file=config.json::filecount=0').ok).toBe(false);
    expect(
      validateExtraJavaArgs('-Xlog:gc:file=logs/gc.log,safepoint:file=HytaleServer.jar').ok,
    ).toBe(false);
    // Java writes to a file for any output other than stdout/stderr, "file=" or not
    expect(validateExtraJavaArgs('-Xlog:gc:config.json').ok).toBe(false);
    expect(validateExtraJavaArgs('-Xlog:all:HytaleServer.jar').ok).toBe(false);
    expect(validateExtraJavaArgs('-Xlog:gc:file=logs/..').ok).toBe(false);
    expect(validateExtraJavaArgs('-Xlog:gc:stdout:time:filecount=1:extra').ok).toBe(false);
    for (const ok of [
      '-Xlog:gc:logs/gc.log',
      '-Xlog:gc:stdout',
      '-Xlog:gc::time',
      '-Xlog:disable',
    ]) {
      expect(validateExtraJavaArgs(ok), ok).toEqual({ ok: true });
    }
  });

  it('refuses -Xlog:help, which only prints and exits', () => {
    expect(validateExtraJavaArgs('-Xlog:help').ok).toBe(false);
  });

  it('allows one garbage collector instead of G1, never two or one that cannot run a server', () => {
    expect(validateExtraJavaArgs('-XX:+UseShenandoahGC').ok).toBe(true);
    expect(validateExtraJavaArgs('-XX:+UseZGC -XX:+UseZGC').ok).toBe(true);
    const two = validateExtraJavaArgs('-XX:+UseZGC -XX:+UseParallelGC');
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.error).toMatch(/one garbage collector/);
    expect(validateExtraJavaArgs('-XX:+UseG1GC -XX:+UseZGC').ok).toBe(false);
    expect(validateExtraJavaArgs('-XX:+UseEpsilonGC').ok).toBe(false);
    expect(validateExtraJavaArgs('-XX:+UseConcMarkSweepGC').ok).toBe(false);
  });

  it('refuses -XX flags that override the heap, write files or unlock more flags', () => {
    for (const args of [
      '-XX:MaxHeapSize=64G',
      '-XX:InitialHeapSize=1G',
      '-XX:MaxRAMPercentage=90',
      '-XX:MaxRAM=64G',
      '-XX:ErrorFile=config.json',
      '-XX:HeapDumpPath=/opt/hytale/data/panel-config.json',
      '-XX:+LogCompilation',
      '-XX:+UnlockDiagnosticVMOptions',
      '-XX:+EnableJVMCI',
      '-XX:StartFlightRecording=filename=x.jfr',
      '-XX:AllocateHeapAt=data',
      '-XX:SharedClassListFile=classes.txt',
      // SIGTERM would no longer shut the server down cleanly
      '-XX:+ReduceSignalUsage',
    ]) {
      expect(validateExtraJavaArgs(args).ok, args).toBe(false);
    }
  });

  it("allows only the server's own -D properties and a few Java ones", () => {
    expect(validateExtraJavaArgs('-Dhytale.allow_outdated_mods -Dhytale.qlog=1').ok).toBe(true);
    for (const args of [
      // paths a bundled library loads a native library from
      '-Drocksdb.lib.path=mods',
      '-Dlibrary.jline.path=mods',
      '-Dio.netty.native.workdir=/opt/hytale/mods',
      '-Dsome.plugin.setting=1',
      '-DHytale.allow_outdated_mods',
    ]) {
      expect(validateExtraJavaArgs(args).ok, args).toBe(false);
    }
  });

  it('splits at spaces and tabs only (like the start script)', () => {
    expect(validateExtraJavaArgs('\t-Xss1m\t-Xss2m ').ok).toBe(true);
    expect(validateExtraJavaArgs('-Xss1m\r').ok).toBe(false);
    expect(validateExtraJavaArgs('-Xss1m -Xss2m').ok).toBe(false);
  });

  it('refuses runtime -D properties except a few harmless ones', () => {
    for (const args of [
      '-Dcom.sun.management.jmxremote.port=9010',
      '-Duser.dir=/tmp',
      '-Djava.io.tmpdir=/opt/hytale/mods',
      '-Djdk.attach.allowAttachSelf=true',
      '-Djava.rmi.server.codebase=http://x',
      '-Dsun.boot.library.path=/tmp',
    ]) {
      expect(validateExtraJavaArgs(args).ok, args).toBe(false);
    }
    expect(validateExtraJavaArgs('-Dfile.encoding=UTF-8 -Djava.net.preferIPv4Stack=true').ok).toBe(
      true,
    );
  });
});

describe('heap vs. container limit', () => {
  it('parses panel RAM values', () => {
    expect(ramToMb('4G')).toBe(4096);
    expect(ramToMb('512m')).toBe(512);
    expect(ramToMb('1.5G')).toBeNull();
  });

  it('keeps a quarter of the limit (at most 1.5 GB) for the JVM itself', () => {
    const GB = 1024 * 1024 * 1024;
    expect(maxHeapMbForLimit(8 * GB)).toBe(8192 - 1536);
    expect(maxHeapMbForLimit(4 * GB)).toBe(3072);
    expect(maxHeapMbForLimit(0)).toBeNull();
    expect(maxHeapMbForLimit(null)).toBeNull();
  });
});

describe('normalizeBootCommands', () => {
  it('strips the slash, drops empty entries and keeps the order', () => {
    expect(normalizeBootCommands(['/say hello', '  ', 'whitelist on'])).toEqual({
      ok: true,
      commands: ['say hello', 'whitelist on'],
    });
    expect(normalizeBootCommands(undefined)).toEqual({ ok: true, commands: [] });
  });

  it('rejects commas (the server splits at them), line breaks and non-lists', () => {
    expect(normalizeBootCommands(['say a, b']).ok).toBe(false);
    expect(normalizeBootCommands(['say a\nstop']).ok).toBe(false);
    expect(normalizeBootCommands('stop').ok).toBe(false);
    expect(normalizeBootCommands([1]).ok).toBe(false);
  });
});
