/**
 * TPS is judged relative to the world's target rate: Hytale ticks at 30 TPS
 * by default (plugin 2.1+ reports the target), the old plugin capped its
 * readings at 20.
 */

/** Hytale's default tick rate. */
export const HYTALE_TARGET_TPS = 30
/** Scale of plugins before 2.1, whose TPS never went above 20. */
export const LEGACY_PLUGIN_TARGET_TPS = 20

/** At or above this share of the target a world runs fine. */
export const TPS_OK_RATIO = 0.95
/** Below this share it lags noticeably (same default as the watchdog alarm). */
export const TPS_WARN_RATIO = 0.75

export type TpsLevel = 'good' | 'warn' | 'bad' | 'unknown'

/** TPS as a percentage of the target, rounded; null when unknown. */
export function tpsPercent(tps: number | null | undefined, target: number): number | null {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || target <= 0) return null
  return Math.round((tps / target) * 100)
}

export function tpsLevel(tps: number | null | undefined, target: number): TpsLevel {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || target <= 0) return 'unknown'
  const ratio = tps / target
  if (ratio >= TPS_OK_RATIO) return 'good'
  if (ratio >= TPS_WARN_RATIO) return 'warn'
  return 'bad'
}

/** Tick time budget at the target rate in ms (33.3 ms at 30 TPS). */
export function tickBudgetMs(target: number): number {
  return target > 0 ? 1000 / target : 0
}
