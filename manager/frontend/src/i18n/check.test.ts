import { describe, expect, it } from 'vitest'
import {
  collectUsedKeys,
  compareKeys,
  comparePlaceholders,
  findMissingKeys,
  flatten,
  runChecks,
} from '../../scripts/check-i18n.mjs'

const flat = (tree: Record<string, unknown>) => flatten(tree)

describe('language file checks', () => {
  it('flattens nested messages to dotted keys', () => {
    expect([...flat({ a: { b: 'x', c: { d: 'y' } }, e: 'z' }).keys()]).toEqual([
      'a.b',
      'a.c.d',
      'e',
    ])
  })

  it('names the keys a language lacks', () => {
    const missing = compareKeys({
      de: flat({ a: '1', b: '2' }),
      en: flat({ a: '1' }),
      pt_br: flat({ a: '1', b: '2', c: '3' }),
    })
    expect(missing.de).toEqual(['c'])
    expect(missing.en).toEqual(['b', 'c'])
    expect(missing.pt_br).toEqual([])
  })

  it('finds a placeholder that differs between languages', () => {
    const findings = comparePlaceholders({
      de: flat({ ok: 'Hallo {name}', bad: 'in {minutes} min' }),
      en: flat({ ok: 'Hello {name}', bad: 'in {time}' }),
      pt_br: flat({ ok: 'Olá {name}', bad: 'em {minutes} min' }),
    })
    expect(findings.map((f) => f.key)).toEqual(['bad'])
  })

  it('collects keys asked for with a literal, a key property or a built-up key', () => {
    const used = collectUsedKeys([
      {
        path: 'a.vue',
        text: 't(\'nav.home\') + $t("nav.help") + te(`cmd.x`) + t(`cmd.group.${g}`) + { labelKey: \'nav.users\' } + :key="item.id"',
      },
    ])
    expect([...used.literal.keys()].sort()).toEqual(['cmd.x', 'nav.help', 'nav.home', 'nav.users'])
    expect([...used.dynamic.keys()]).toEqual(['cmd.group'])
  })

  it('reports used keys that no language has, and unknown sections', () => {
    const en = flat({ nav: { home: 'x' }, cmd: { group: { a: 'A' } } })
    const used = collectUsedKeys([
      {
        path: 'a.vue',
        text: "t('nav.home') t('nav.gone') t(`cmd.group.${x}`) t(`cmd.nothing.${x}`)",
      },
    ])
    const found = findMissingKeys(used, { de: en, en, pt_br: en })
    expect(found.map((f) => f.key)).toEqual(['cmd.nothing.<…>', 'nav.gone'])
  })

  it('passes for the real language files and sources', () => {
    const { findings } = runChecks()
    expect(findings).toEqual([])
  })
})
