// Shared composable for the Mods view + components/mods/* children.
//
// The Mods view used to be a single 3138-line SFC. As part of the refactor
// to components/mods/*, this composable hosts shared types and a small
// helper for resolving localized strings from mod registries. Stateful
// pieces still live in views/Mods.vue (which is being incrementally
// decomposed). Subsequent extractions should move per-tab state here
// (or into a Pinia store) without changing endpoint URLs or behavior.
import type { LocalizedString } from '@/api/management'
import { getLocale } from '@/i18n'

/**
 * The set of tabs rendered by views/Mods.vue. Kept here so the future
 * extracted ModsList / ModsStore / ModsFilter components can share the
 * same union without each redeclaring it.
 */
export type ModsTab = 'mods' | 'plugins' | 'store' | 'modtale' | 'stackmart' | 'curseforge' | 'updates'

/**
 * Resolve a localized string returned by a mod registry into the user's
 * current locale. Falls back through en / de / pt_br before settling on
 * the first non-empty value.
 *
 * Extracted from views/Mods.vue (getLocalizedText) so that future child
 * components can render localized titles/descriptions identically.
 */
export function getLocalizedText(text: string | LocalizedString | undefined | null): string {
  if (!text) return ''
  if (typeof text === 'string') return text

  // Handle object type (LocalizedString)
  if (typeof text === 'object') {
    const locale = getLocale()
    // Map locale to key (handle pt_br -> pt_br)
    const localeKey = locale === 'pt_br' ? 'pt_br' : locale

    // Try current locale, then English, then German, then Portuguese, then first available value
    const result = text[localeKey as keyof LocalizedString]
      || text.en
      || text.de
      || text.pt_br
      || Object.values(text).find(v => typeof v === 'string' && v.length > 0)
      || ''

    return result
  }

  // Fallback: convert to string
  return String(text)
}

/**
 * Category color classes used in the mod tiles. Centralized here so that
 * a future extracted ModsFilter / ModsList / ModsStore can render the
 * same badge styling without duplicating the mapping.
 */
export function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    map: 'bg-blue-500/20 text-blue-400',
    utility: 'bg-green-500/20 text-green-400',
    gameplay: 'bg-purple-500/20 text-purple-400',
    admin: 'bg-red-500/20 text-red-400',
    other: 'bg-gray-500/20 text-gray-400',
  }
  return colors[category] || colors.other
}
