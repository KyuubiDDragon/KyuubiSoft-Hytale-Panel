#!/usr/bin/env node
/**
 * Checks the language files against each other and against the code:
 *
 *  1. de, en and pt_br have exactly the same keys.
 *  2. The {placeholders} of a message are the same in every language.
 *  3. Every key the code asks for with a literal (t('a.b'), te('a.b'),
 *     labelKey: 'a.b' …) exists; for a key built at runtime (`a.b.${x}`)
 *     the fixed part must at least be a section of the language file.
 *
 * Usage: node scripts/check-i18n.mjs        (exit code 1 on any finding)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const LOCALES = ['de', 'en', 'pt_br']

/** { a: { b: 'x' } } -> Map('a.b' -> 'x') */
export function flatten(tree, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') flatten(value, path, out)
    else out.set(path, String(value))
  }
  return out
}

/** Keys that exist in some languages only: { de: [...], en: [...] } of what each lacks. */
export function compareKeys(flat) {
  const all = new Set()
  for (const map of Object.values(flat)) for (const key of map.keys()) all.add(key)
  const missing = {}
  for (const [locale, map] of Object.entries(flat)) {
    missing[locale] = [...all].filter((key) => !map.has(key)).sort()
  }
  return missing
}

export function placeholders(message) {
  return [...message.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort()
}

/** Keys whose {placeholders} differ between languages: [{ key, byLocale }]. */
export function comparePlaceholders(flat) {
  const findings = []
  const reference = flat[LOCALES[0]]
  for (const [key, message] of reference) {
    const byLocale = {}
    let differs = false
    for (const locale of Object.keys(flat)) {
      const other = flat[locale].get(key)
      if (other === undefined) continue
      byLocale[locale] = placeholders(other).join(',')
      if (byLocale[locale] !== placeholders(message).join(',')) differs = true
    }
    if (differs) findings.push({ key, byLocale })
  }
  return findings
}

const CALL = /(?<![A-Za-z0-9_.$])(?:\$t|t|te|tc)\(\s*(['"`])([^'"`\n]+)\1/g
const KEY_PROP = /\b[a-z][A-Za-z]*Key\s*[:=]\s*(['"])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\1/g

/** Keys the code asks for: { literal: Map(key -> files), dynamic: Map(prefix -> files) }. */
export function collectUsedKeys(files) {
  const literal = new Map()
  const dynamic = new Map()
  const add = (map, key, file) => {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(file)
  }
  for (const { path, text } of files) {
    for (const m of text.matchAll(CALL)) {
      const key = m[2]
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_${}]+)+$/.test(key)) continue
      if (key.includes('${')) {
        const prefix = key.slice(0, key.indexOf('${'))
        // Only a prefix that ends at a section boundary says anything.
        if (prefix.endsWith('.')) add(dynamic, prefix.slice(0, -1), path)
      } else {
        add(literal, key, path)
      }
    }
    for (const m of text.matchAll(KEY_PROP)) add(literal, m[2], path)
  }
  return { literal, dynamic }
}

export function findMissingKeys(used, flat) {
  const reference = flat.en
  const sections = new Set()
  for (const key of reference.keys()) {
    const parts = key.split('.')
    for (let i = 1; i < parts.length; i++) sections.add(parts.slice(0, i).join('.'))
  }
  const missing = [...used.literal.entries()]
    // A pluralised message is still one key.
    .filter(([key]) => !reference.has(key))
    .map(([key, files]) => ({ key, files: [...files] }))
  const badSections = [...used.dynamic.entries()]
    .filter(([prefix]) => !sections.has(prefix))
    .map(([prefix, files]) => ({ key: `${prefix}.<…>`, files: [...files] }))
  return [...missing, ...badSections].sort((a, b) => a.key.localeCompare(b.key))
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full)
  }
  return out
}

export function loadLocales(dir = join(SRC, 'i18n')) {
  const flat = {}
  for (const locale of LOCALES) {
    flat[locale] = flatten(JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')))
  }
  return flat
}

export function loadSources(dir = SRC) {
  return walk(dir).map((path) => ({ path: relative(ROOT, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }))
}

export function runChecks() {
  const flat = loadLocales()
  const findings = []

  const missing = compareKeys(flat)
  for (const [locale, keys] of Object.entries(missing)) {
    if (keys.length > 0) findings.push(`${locale}.json lacks ${keys.length} key(s) the other languages have:\n    ${keys.join('\n    ')}`)
  }

  const mismatched = comparePlaceholders(flat)
  if (mismatched.length > 0) {
    findings.push(
      `Placeholders differ between languages:\n    ${mismatched
        .map((f) => `${f.key} ${JSON.stringify(f.byLocale)}`)
        .join('\n    ')}`,
    )
  }

  const unknown = findMissingKeys(collectUsedKeys(loadSources()), flat)
  if (unknown.length > 0) {
    findings.push(
      `The code uses ${unknown.length} key(s) that no language file has:\n    ${unknown
        .map((f) => `${f.key}  (${f.files.join(', ')})`)
        .join('\n    ')}`,
    )
  }
  return { flat, findings }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flat, findings } = runChecks()
  if (findings.length > 0) {
    console.error(`i18n check failed:\n\n${findings.join('\n\n')}\n`)
    process.exit(1)
  }
  console.log(`i18n check passed: ${flat.en.size} keys in ${LOCALES.length} languages, all used keys exist.`)
}
