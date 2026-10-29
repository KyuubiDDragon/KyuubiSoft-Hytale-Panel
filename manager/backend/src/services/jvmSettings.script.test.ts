/**
 * The start script checks the panel's start parameters again before it passes
 * them to Java (scripts/start-args.sh), because values saved by an older panel
 * version would otherwise reach the server unchecked. Both checks must agree:
 * every case runs through the TypeScript validator and through the script.
 *
 * Needs bash (Linux/macOS, or Git Bash on Windows); skipped without it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateExtraJavaArgs, validateExtraServerArgs, ramToMb } from './jvmSettings.js';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/start-args.sh', import.meta.url));

function findBash(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')]
      : ['bash'];
  for (const candidate of candidates) {
    if (process.platform === 'win32' && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === 'ok') return candidate;
  }
  return null;
}

const bash = existsSync(SCRIPT) ? findBash() : null;

type Kind = 'java' | 'server' | 'ram';

const RUNNER = `
source "$1"
while IFS= read -r kind && IFS= read -r value; do
  case "$kind" in
    java) check_panel_java_args "$value" >/dev/null && echo ok || echo refused ;;
    server) check_panel_server_args "$value" >/dev/null && echo ok || echo refused ;;
    ram) check_panel_ram "$value" >/dev/null && echo ok || echo refused ;;
  esac
done
`;

/** Verdicts of the script, in the order of the cases. */
function scriptVerdicts(cases: [Kind, string][]): string[] {
  const result = spawnSync(bash as string, ['-c', RUNNER, 'runner', SCRIPT.replace(/\\/g, '/')], {
    input: cases.map(([kind, value]) => `${kind}\n${value}\n`).join(''),
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  return result.stdout.split('\n').filter(Boolean);
}

function panelVerdict(kind: Kind, value: string): string {
  const ok =
    kind === 'java'
      ? validateExtraJavaArgs(value).ok
      : kind === 'server'
        ? validateExtraServerArgs(value).ok
        : ramToMb(value) !== null;
  return ok ? 'ok' : 'refused';
}

const JAVA_CASES = [
  '',
  '-XX:+UseZGC -XX:+ZGenerational',
  '-XX:+UseZGC -XX:+UseStringDeduplication',
  '-XX:+UseZGC -XX:+UseZGC',
  '-XX:+UseZGC -XX:+UseParallelGC',
  '-XX:+UseG1GC -XX:+UseShenandoahGC',
  '-XX:-UseG1GC',
  '-XX:+UseEpsilonGC',
  '-XX:+UseConcMarkSweepGC',
  '-XX:MaxGCPauseMillis=100 -Dfile.encoding=UTF-8',
  '-Xss1m -Dhytale.allow_outdated_mods',
  '-Xmn512m -Xss512k',
  '-Xlog:gc*:file=logs/gc.log:time,uptime:filecount=5,filesize=20M',
  '-Xlog:gc:logs/gc.log',
  '-Xlog:gc:stdout',
  '-Xlog:gc::time',
  '-Xlog:disable',
  '-Xlog:gc:config.json',
  '-Xlog:all:HytaleServer.jar',
  '-Xlog:help',
  '-Xlog:gc:file=logs/..',
  '-Xlog:gc:file=/opt/hytale/mods/x.jar',
  '-Xlog:gc:file=../config.json',
  '-Xlog:all:file=config.json::filecount=0',
  '-Xlog:gc:file=logs/gc.log,safepoint:file=HytaleServer.jar',
  '-Xlog:gc:stdout:time:filecount=1:extra',
  '--add-opens=java.base/java.lang=ALL-UNNAMED',
  '-verbose:gc -ea',
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
  '-xms2G',
  '-XX:MaxHeapSize=64G',
  '-XX:MaxRAMPercentage=90',
  '-XX:ErrorFile=config.json',
  '-XX:heapdumppath=x',
  '-XX:+LogCompilation',
  '-XX:+UnlockDiagnosticVMOptions',
  '-XX:+EnableJVMCI',
  '-XX:StartFlightRecording=filename=x.jfr',
  '-XX:AllocateHeapAt=x',
  '-XX:+ReduceSignalUsage',
  '-XX:SharedClassListFile=x',
  '-Dcom.sun.management.jmxremote.port=9010',
  '-Duser.dir=/tmp',
  '-Djdk.attach.allowAttachSelf=true',
  '-Dsun.boot.library.path=/tmp',
  '-Dfile.encoding=UTF-8 -Djava.net.preferIPv4Stack=true',
  '-Dsun.net.inetaddr.ttl=30',
  '-Djdk.virtualThreadScheduler.parallelism=4',
  '-Dhytale.allow_outdated_mods -Dhytale.qlog=1',
  '-DHytale.allow_outdated_mods',
  '-Dhytale.',
  '-Drocksdb.lib.path=mods',
  '-Dlibrary.jline.path=mods',
  '-Dio.netty.native.workdir=/opt/hytale/mods',
  '-Dsome.plugin.setting=1',
  '\t-Xss1m\t-Xss2m ',
  '-Xss1m\r',
  '-Xss1m -Xss2m',
  '-XX:Foo=a/b',
  '-Xss1g',
  '-Xrs',
  '-XX:+HeapDumpOnOutOfMemoryError',
  'x'.repeat(1025),
];

const SERVER_CASES = [
  '',
  '--ignore-broken-mods',
  '--disable-file-watcher --log WARNING,PacketLogging:OFF',
  '--log=FINE',
  '--log=fine',
  '--transport QUICHE',
  '--transport quic',
  '-t QUIC',
  '--validate-prefabs',
  '--validate-prefabs BLOCKS,ENTITIES --validate-assets',
  '--validate-prefabs --ignore-broken-mods',
  '--validate-prefabs blocks',
  '--prefab-cache /opt/hytale/data/prefab-cache',
  '--force-network-flush false',
  '--force-network-flush=TRUE',
  '--early-plugins /opt/hytale/earlyplugins',
  '--ignore-broken-mods\r',
  ' --ignore-broken-mods\t--disable-file-watcher ',
  '--foo',
  '--ignore-broken-mods extra',
  '-x',
  '-b 0.0.0.0:5521',
  '--boot-command stop',
  '--universe /opt/hytale/x',
  '--mods /opt/hytale/mods',
  '--allow-op',
  '--accept-early-plugins',
  '--backup-max-count 3',
  '--version',
  '--help',
  '--bare',
  '--shutdown-after-validate',
  '--verify-worlds',
  '--session-token abc',
  '--log',
  '--log LOUD',
  '--log --ignore-broken-mods',
  '--transport TCP',
  '--disable-sentry=true',
  '--ignore-broken-mods=1',
  '--force-network-flush maybe',
  '--prefab-cache /etc/passwd',
  '--prefab-cache /opt/hytale/../etc',
  '--world-gen /opt/hytale/a/../../etc',
  '--world-gen /opt/hytale/a/..b',
  '--log FINE;rm',
  '--log $(id)',
  '-tQUIC',
  '--',
  '--=x',
  `--log ${'A'.repeat(1020)}`,
  '--constructor',
  '--toString',
  '--__proto__',
  '--hasOwnProperty x',
];

const RAM_CASES = ['3G', '512m', '4096M', '1.5G', '3 G', '3G -javaagent:x', '', '123456M', 'G'];

describe.skipIf(!bash)('start-args.sh agrees with the panel validation', () => {
  it.each([
    ['java', JAVA_CASES],
    ['server', SERVER_CASES],
    ['ram', RAM_CASES],
  ] as [Kind, string[]][])('%s arguments', (kind, values) => {
    const verdicts = scriptVerdicts(values.map((v) => [kind, v]));
    expect(verdicts).toHaveLength(values.length);
    const mismatches = values
      .map((value, i) => ({ value, panel: panelVerdict(kind, value), script: verdicts[i] }))
      .filter((c) => c.panel !== c.script);
    expect(mismatches).toEqual([]);
  });

  it('accepts and refuses something in every group (the cases are not vacuous)', () => {
    for (const values of [JAVA_CASES, SERVER_CASES]) {
      const java = values === JAVA_CASES;
      const verdicts = values.map((v) =>
        java ? validateExtraJavaArgs(v).ok : validateExtraServerArgs(v).ok,
      );
      expect(verdicts).toContain(true);
      expect(verdicts).toContain(false);
    }
  });
});
