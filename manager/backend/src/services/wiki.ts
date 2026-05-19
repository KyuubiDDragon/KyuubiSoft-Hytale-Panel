/**
 * Auto-Wiki (V3.1.3)
 *
 * Scans the mods/plugins directories for JAR files, extracts each archive's
 * `manifest.json` (Hytale plugin format) and renders a Markdown page per
 * mod/plugin plus an index.json.
 *
 * The ZIP reader is implemented in-house to avoid adding a runtime
 * dependency: we read the central directory, locate the entry by name and
 * inflate just that one record. This is enough for our needs (small JSON
 * files) without ever holding the full JAR in memory.
 */

import { readdir, readFile, writeFile, mkdir, stat, open } from 'fs/promises';
import path from 'path';
import { inflateRawSync } from 'zlib';
import { config } from '../config.js';
import { isDemoMode } from './demoData.js';
import { getConfig, updateConfig } from './configService.js';

const DATA_PATH = process.env.MANAGER_DATA_PATH || '/app/data';
const WIKI_DIR = path.join(DATA_PATH, 'wiki');
const INDEX_PATH = path.join(WIKI_DIR, 'index.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiEntry {
  slug: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  category: string;
  commands: string[];
  configSchema?: unknown;
  source: 'mod' | 'plugin';
  fileName: string;
  generatedAt: string;
}

export interface WikiIndex {
  generatedAt: string;
  entries: WikiEntry[];
}

interface WikiConfigSlice {
  publicAccess: boolean;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ConfigWithWiki { wiki?: Partial<WikiConfigSlice> }

export async function getWikiConfig(): Promise<WikiConfigSlice> {
  try {
    const cfg = (await getConfig()) as unknown as ConfigWithWiki;
    return { publicAccess: cfg.wiki?.publicAccess ?? false };
  } catch {
    return { publicAccess: false };
  }
}

export async function setWikiConfig(next: Partial<WikiConfigSlice>): Promise<WikiConfigSlice> {
  const current = await getWikiConfig();
  const merged: WikiConfigSlice = {
    publicAccess: next.publicAccess ?? current.publicAccess,
  };
  try {
    await updateConfig({ wiki: merged } as unknown as Parameters<typeof updateConfig>[0]);
  } catch (err) {
    console.error('[wiki] failed to persist config:', err);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// ZIP central directory reader (subset)
// ---------------------------------------------------------------------------

interface CdEntry {
  name: string;
  compressionMethod: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CD_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

async function readEntryFromJar(jarPath: string, targetName: string): Promise<Buffer | null> {
  const handle = await open(jarPath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) return null;

    // Scan back from EOF to find the EOCD record.
    const lookup = Math.min(size, 0xFFFF + 22);
    const tail = Buffer.alloc(lookup);
    await handle.read(tail, 0, lookup, size - lookup);
    let eocdOffset = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) return null;

    const totalEntries = tail.readUInt16LE(eocdOffset + 10);
    const cdSize = tail.readUInt32LE(eocdOffset + 12);
    const cdOffset = tail.readUInt32LE(eocdOffset + 16);

    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);

    let p = 0;
    let target: CdEntry | null = null;
    for (let i = 0; i < totalEntries; i++) {
      if (cd.readUInt32LE(p) !== CD_FILE_HEADER) break;
      const compressionMethod = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const fileNameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + fileNameLen).toString('utf-8');
      if (name === targetName) {
        target = { name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset };
        break;
      }
      p += 46 + fileNameLen + extraLen + commentLen;
    }
    if (!target) return null;

    // Read local file header to skip past name+extra and reach the payload.
    const lfh = Buffer.alloc(30);
    await handle.read(lfh, 0, 30, target.localHeaderOffset);
    if (lfh.readUInt32LE(0) !== LOCAL_FILE_HEADER) return null;
    const lfnLen = lfh.readUInt16LE(26);
    const lfeLen = lfh.readUInt16LE(28);
    const payloadOffset = target.localHeaderOffset + 30 + lfnLen + lfeLen;

    const payload = Buffer.alloc(target.compressedSize);
    await handle.read(payload, 0, target.compressedSize, payloadOffset);

    if (target.compressionMethod === 0) return payload;
    if (target.compressionMethod === 8) return inflateRawSync(payload);
    return null;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Plugin / mod scanning
// ---------------------------------------------------------------------------

interface RawManifest {
  name?: string;
  id?: string;
  description?: string;
  author?: string;
  authors?: string[] | string;
  version?: string;
  category?: string;
  commands?: unknown;
  config?: unknown;
  configSchema?: unknown;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unnamed';
}

function categoriseByFileName(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith('chat-') || n.includes('chat')) return 'Chat';
  if (n.includes('econ')) return 'Economy';
  if (n.includes('protect') || n.includes('claim')) return 'Protection';
  if (n.includes('map') || n.includes('web')) return 'Maps';
  if (n.includes('admin')) return 'Admin';
  return 'Misc';
}

function commandsFromManifest(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object' && 'name' in c) return String((c as { name: unknown }).name);
      return JSON.stringify(c);
    });
  }
  if (typeof raw === 'object') return Object.keys(raw as Record<string, unknown>);
  return [];
}

async function scanDir(dir: string, source: 'mod' | 'plugin'): Promise<WikiEntry[]> {
  const out: WikiEntry[] = [];
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.jar')) continue;
    const full = path.join(dir, f);
    try {
      const s = await stat(full);
      if (!s.isFile()) continue;
    } catch { continue; }

    let manifest: RawManifest | null = null;
    try {
      const buf = await readEntryFromJar(full, 'manifest.json');
      if (buf) manifest = JSON.parse(buf.toString('utf-8')) as RawManifest;
    } catch (err) {
      console.log(`[wiki] could not read manifest.json from ${f}:`, (err as Error).message);
    }

    const name = manifest?.name || manifest?.id || f.replace(/\.jar$/i, '');
    const description = manifest?.description;
    const author = manifest?.author
      ?? (Array.isArray(manifest?.authors) ? manifest!.authors.join(', ') : manifest?.authors);
    const version = manifest?.version;
    const category = manifest?.category || categoriseByFileName(f);
    const commands = commandsFromManifest(manifest?.commands);
    const configSchema = manifest?.configSchema ?? manifest?.config;

    out.push({
      slug: slugify(`${source}-${name}`),
      name,
      description,
      author: typeof author === 'string' ? author : undefined,
      version,
      category,
      commands,
      configSchema,
      source,
      fileName: f,
      generatedAt: new Date().toISOString(),
    });
  }
  return out;
}

function renderMarkdown(entry: WikiEntry): string {
  const lines: string[] = [];
  lines.push(`# ${entry.name}`);
  lines.push('');
  const meta: string[] = [];
  if (entry.version) meta.push(`**Version:** ${entry.version}`);
  if (entry.author) meta.push(`**Author:** ${entry.author}`);
  meta.push(`**Source:** ${entry.source}`);
  meta.push(`**Category:** ${entry.category}`);
  meta.push(`**File:** \`${entry.fileName}\``);
  lines.push(meta.join('  \n'));
  lines.push('');
  if (entry.description) {
    lines.push('## Description');
    lines.push('');
    lines.push(entry.description);
    lines.push('');
  }
  if (entry.commands.length > 0) {
    lines.push('## Commands');
    lines.push('');
    for (const c of entry.commands) lines.push(`- \`${c}\``);
    lines.push('');
  }
  if (entry.configSchema) {
    lines.push('## Configuration');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(entry.configSchema, null, 2));
    lines.push('```');
    lines.push('');
  }
  lines.push(`_Generated ${entry.generatedAt}_`);
  return lines.join('\n');
}

function demoEntries(): WikiEntry[] {
  const now = new Date().toISOString();
  return [
    {
      slug: 'plugin-kyuubi-api',
      name: 'KyuubiSoft API',
      description: 'Companion plugin used by the panel to receive chat, join/leave and death events and to issue authoritative commands without going through the console.',
      author: 'KyuubiSoft',
      version: '1.2.0',
      category: 'Admin',
      commands: ['/kapi-status', '/kapi-reload'],
      configSchema: { port: 18083, allowList: ['127.0.0.1'] },
      source: 'plugin',
      fileName: 'kyuubi-api-1.2.0.jar',
      generatedAt: now,
    },
    {
      slug: 'mod-easywebmap',
      name: 'EasyWebMap',
      description: 'Renders a live, browser-based map of all loaded chunks. Powers the WebMap tab in this panel.',
      author: 'community',
      version: '1.0.9',
      category: 'Maps',
      commands: ['/webmap reload'],
      configSchema: { port: 18081, refreshSeconds: 5 },
      source: 'mod',
      fileName: 'EasyWebMap-v1.0.9.jar',
      generatedAt: now,
    },
    {
      slug: 'plugin-essentialchat',
      name: 'EssentialChat',
      description: 'Basic chat formatting, private messaging and per-world channels.',
      author: 'Demo',
      version: '0.4.1',
      category: 'Chat',
      commands: ['/msg', '/r', '/ignore'],
      source: 'plugin',
      fileName: 'essentialchat.jar',
      generatedAt: now,
    },
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function regenerateWiki(): Promise<WikiIndex> {
  await mkdir(WIKI_DIR, { recursive: true });

  let entries: WikiEntry[];
  if (isDemoMode()) {
    entries = demoEntries();
    console.log('[wiki] demo mode — using simulated entries');
  } else {
    const mods = await scanDir(config.modsPath, 'mod');
    const plugins = await scanDir(config.pluginsPath, 'plugin');
    entries = [...mods, ...plugins];
    console.log(`[wiki] scanned: ${mods.length} mods + ${plugins.length} plugins`);
  }

  // Write per-entry markdown files.
  for (const e of entries) {
    await writeFile(path.join(WIKI_DIR, `${e.slug}.md`), renderMarkdown(e), 'utf-8');
  }

  const index: WikiIndex = {
    generatedAt: new Date().toISOString(),
    entries,
  };
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
  return index;
}

export async function loadWikiIndex(): Promise<WikiIndex> {
  try {
    const content = await readFile(INDEX_PATH, 'utf-8');
    return JSON.parse(content) as WikiIndex;
  } catch {
    // Lazy initial scan so a fresh install isn't blank.
    return regenerateWiki();
  }
}

export async function loadWikiPage(slug: string): Promise<{ entry: WikiEntry; markdown: string } | null> {
  const safe = slug.replace(/[^a-z0-9-]/gi, '');
  if (!safe) return null;
  try {
    const index = await loadWikiIndex();
    const entry = index.entries.find((e) => e.slug === safe);
    if (!entry) return null;
    const markdown = await readFile(path.join(WIKI_DIR, `${safe}.md`), 'utf-8');
    return { entry, markdown };
  } catch {
    return null;
  }
}
