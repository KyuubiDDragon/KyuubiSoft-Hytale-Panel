/**
 * Mod / plugin compatibility checking.
 *
 * Installing a mod built for a different server version is a common cause of
 * boot crashes. This service produces a verdict — compatible / incompatible /
 * unknown — for a mod against the installed server version, from two sources:
 *
 *   1. Declared registry metadata (gameVersions / minServerVersion /
 *      maxServerVersion on a ModStoreEntry), and
 *   2. A manifest probed from inside the mod JAR.
 *
 * NOTE: Hytale's mod manifest format isn't finalized. The JAR probe tries a
 * few plausible manifest names + field spellings and is marked clearly so it
 * can be tightened later. When nothing is declared the verdict is "unknown"
 * (never a hard block) — we surface the uncertainty rather than guessing.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';
import { getServer, getDefaultId } from './servers.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export type CompatVerdict = 'compatible' | 'incompatible' | 'unknown';

export interface CompatResult {
  verdict: CompatVerdict;
  serverVersion: string | null;
  declared: {
    gameVersions?: string[];
    minServerVersion?: string;
    maxServerVersion?: string;
    source: 'registry' | 'jar' | 'none';
  };
  reason: string;
}

export interface DeclaredCompat {
  gameVersions?: string[];
  minServerVersion?: string;
  maxServerVersion?: string;
}

// ---------- version parsing ----------

// Parse a version like "1.0.4", "v1.2", "0.1.0-pre1" into comparable numbers.
// Pre-release suffixes are dropped for ordering (treated as the base release).
function parseVersion(v: string): number[] | null {
  if (!v || typeof v !== 'string') return null;
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Loose equality at major.minor.patch (ignores pre-release suffix differences).
function versionsMatch(a: string, b: string): boolean {
  return compareVersions(a, b) === 0;
}

export async function getServerVersion(serverId?: string): Promise<string | null> {
  let serverPath = config.serverPath;
  try {
    const id = serverId ?? (await getDefaultId());
    const s = await getServer(id);
    if (s) serverPath = s.paths.server;
  } catch { /* registry not ready */ }
  try {
    const v = fs.readFileSync(path.join(serverPath, '.hytale-version'), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

// ---------- verdict from declared ranges ----------

export function evaluate(declared: DeclaredCompat, serverVersion: string | null, source: 'registry' | 'jar' | 'none'): CompatResult {
  const base: CompatResult = {
    verdict: 'unknown',
    serverVersion,
    declared: { ...declared, source },
    reason: '',
  };

  const hasAny = (declared.gameVersions && declared.gameVersions.length) || declared.minServerVersion || declared.maxServerVersion;
  if (!hasAny) {
    base.reason = 'The mod does not declare a compatible server version.';
    return base;
  }
  if (!serverVersion) {
    base.reason = 'The installed server version is unknown, so compatibility cannot be verified.';
    return base;
  }

  // Explicit version list wins.
  if (declared.gameVersions && declared.gameVersions.length) {
    const ok = declared.gameVersions.some(gv => versionsMatch(gv, serverVersion));
    base.verdict = ok ? 'compatible' : 'incompatible';
    base.reason = ok
      ? `Declared for server ${declared.gameVersions.join(', ')} — matches ${serverVersion}.`
      : `Declared for server ${declared.gameVersions.join(', ')}, but ${serverVersion} is installed.`;
    return base;
  }

  // Min/max range.
  if (declared.minServerVersion) {
    const cmp = compareVersions(serverVersion, declared.minServerVersion);
    if (cmp !== null && cmp < 0) {
      base.verdict = 'incompatible';
      base.reason = `Requires server ≥ ${declared.minServerVersion}, but ${serverVersion} is installed.`;
      return base;
    }
  }
  if (declared.maxServerVersion) {
    const cmp = compareVersions(serverVersion, declared.maxServerVersion);
    if (cmp !== null && cmp > 0) {
      base.verdict = 'incompatible';
      base.reason = `Requires server ≤ ${declared.maxServerVersion}, but ${serverVersion} is installed.`;
      return base;
    }
  }
  base.verdict = 'compatible';
  const rangeParts: string[] = [];
  if (declared.minServerVersion) rangeParts.push(`≥ ${declared.minServerVersion}`);
  if (declared.maxServerVersion) rangeParts.push(`≤ ${declared.maxServerVersion}`);
  base.reason = `Compatible — server ${serverVersion} is within the declared range (${rangeParts.join(', ')}).`;
  return base;
}

// ---------- JAR manifest probe (ASSUMED format — adjust when Hytale finalizes) ----------

// Manifest entry names to try inside the JAR, in priority order.
const JAR_MANIFEST_CANDIDATES = ['mod.json', 'hytale.mod.json', 'hytale-mod.json', 'manifest.json'];

function pickDeclared(obj: Record<string, unknown>): DeclaredCompat {
  const out: DeclaredCompat = {};
  const gv = obj.gameVersions ?? obj.gameVersion ?? obj.compatibleVersions;
  if (Array.isArray(gv)) out.gameVersions = gv.map(String);
  else if (typeof gv === 'string') out.gameVersions = [gv];
  for (const key of ['minServerVersion', 'minGameVersion', 'minVersion']) {
    if (typeof obj[key] === 'string') { out.minServerVersion = obj[key] as string; break; }
  }
  for (const key of ['maxServerVersion', 'maxGameVersion', 'maxVersion']) {
    if (typeof obj[key] === 'string') { out.maxServerVersion = obj[key] as string; break; }
  }
  return out;
}

/**
 * Probe a JAR for declared compatibility. Uses `unzip -p` to stream candidate
 * manifest files without extracting the whole archive. Returns null if nothing
 * usable was found.
 */
export async function probeJarCompat(jarPath: string): Promise<DeclaredCompat | null> {
  if (!fs.existsSync(jarPath)) return null;
  for (const entry of JAR_MANIFEST_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync('unzip', ['-p', jarPath, entry], { maxBuffer: 1024 * 1024 });
      if (!stdout || !stdout.trim()) continue;
      const json = JSON.parse(stdout) as Record<string, unknown>;
      const declared = pickDeclared(json);
      if (declared.gameVersions || declared.minServerVersion || declared.maxServerVersion) {
        return declared;
      }
    } catch {
      // entry not present or not JSON — try the next candidate
    }
  }
  return null;
}

// ---------- public entry points ----------

export async function checkRegistryMod(declared: DeclaredCompat, serverId?: string): Promise<CompatResult> {
  const serverVersion = await getServerVersion(serverId);
  const hasDeclared = (declared.gameVersions && declared.gameVersions.length) || declared.minServerVersion || declared.maxServerVersion;
  return evaluate(declared, serverVersion, hasDeclared ? 'registry' : 'none');
}

export async function checkInstalledJar(jarPath: string, serverId?: string): Promise<CompatResult> {
  const serverVersion = await getServerVersion(serverId);
  let declared: DeclaredCompat | null = null;
  try {
    declared = await probeJarCompat(jarPath);
  } catch (err) {
    logger.info('[ModCompat] JAR probe failed:', err);
  }
  return evaluate(declared ?? {}, serverVersion, declared ? 'jar' : 'none');
}
