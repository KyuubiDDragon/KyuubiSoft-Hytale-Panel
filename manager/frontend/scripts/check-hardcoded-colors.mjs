#!/usr/bin/env node
// Guards the theme work: fixed gray utilities (bg-gray-700, border-slate-600 ...)
// ignore the light/dark theme. The count of such classes in src/ may only go
// down. Lower BASELINE whenever views are migrated to the theme tokens
// (bg-surface-*, text-ink-*, border-border-*).
//
// Usage (from manager/frontend):
//   node scripts/check-hardcoded-colors.mjs          check against the baseline
//   node scripts/check-hardcoded-colors.mjs --list   per-file breakdown
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASELINE = 66

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const PATTERN = /(?<![\w-])(?:[a-z]+:)*-?[a-z]+-(?:gray|slate|zinc|neutral|stone)-\d{2,3}(?:\/\d+)?(?![\w-])/g

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name)) yield full
  }
}

const perFile = new Map()
let total = 0
for (const file of walk(root)) {
  const hits = readFileSync(file, 'utf8').match(PATTERN)
  if (!hits) continue
  perFile.set(relative(root, file).split(sep).join('/'), hits.length)
  total += hits.length
}

if (process.argv.includes('--list')) {
  for (const [file, n] of [...perFile].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), file)
}

console.log(`Fixed gray utilities: ${total} (baseline ${BASELINE})`)
if (total > BASELINE) {
  console.error(`Too many fixed gray utilities: ${total} > ${BASELINE}. Use the theme tokens instead (bg-surface-*, text-ink-*, border-border-*).`)
  process.exit(1)
}
if (total < BASELINE) console.log(`Below baseline - lower BASELINE in scripts/check-hardcoded-colors.mjs to ${total}.`)
