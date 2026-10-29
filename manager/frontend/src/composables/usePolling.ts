import { onScopeDispose, toValue, watch, type MaybeRefOrGetter } from 'vue'

/** Where the poller learns whether the page is in the foreground. */
export interface VisibilitySource {
  isVisible(): boolean
  /** Calls `listener` whenever visibility changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

const documentVisibility: VisibilitySource = {
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  subscribe(listener) {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
}

export interface PollerOptions {
  /** Where visibility comes from (default: the document). */
  visibility?: VisibilitySource
  /** Run once when polling starts in a visible tab (default: true). Returning to a hidden tab always loads. */
  immediate?: boolean
}

export interface Poller {
  /** Begins polling (runs `task` once right away when the page is visible). */
  start(): void
  /** Ends polling and releases the timer and the visibility listener. */
  stop(): void
  /** Runs `task` now, unless the previous run is still in flight. */
  trigger(): void
  readonly active: boolean
}

/**
 * Framework-free polling loop: runs `task` every `intervalMs` while the page is
 * visible, stops the timer in a hidden tab and loads once immediately when the
 * tab comes back. A run that is still in flight is never overlapped.
 */
export function createPoller(
  task: () => void | Promise<void>,
  intervalMs: number,
  { visibility = documentVisibility, immediate = true }: PollerOptions = {},
): Poller {
  let active = false
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let inFlight = false

  function clearTimer() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function trigger() {
    if (inFlight) return
    inFlight = true
    Promise.resolve()
      .then(task)
      .catch(() => {
        // The task reports its own errors; a failed run must not stop polling.
      })
      .finally(() => {
        inFlight = false
      })
  }

  function resume(runNow: boolean) {
    clearTimer()
    if (runNow) trigger()
    timer = setInterval(trigger, intervalMs)
  }

  function onVisibilityChange() {
    if (!active) return
    if (visibility.isVisible()) resume(true)
    else clearTimer()
  }

  return {
    start() {
      if (active) return
      active = true
      unsubscribe = visibility.subscribe(onVisibilityChange)
      if (visibility.isVisible()) resume(immediate)
    },
    stop() {
      active = false
      clearTimer()
      unsubscribe?.()
      unsubscribe = null
    },
    trigger,
    get active() {
      return active
    },
  }
}

export interface UsePollingOptions extends Pick<PollerOptions, 'immediate'> {
  /** Polling only runs while this is true (default: always). Reacts to changes. */
  enabled?: MaybeRefOrGetter<boolean>
}

/**
 * Component-scoped polling that pauses in a hidden tab (see `createPoller`).
 * Starts immediately and stops with the surrounding component or effect scope.
 */
export function usePolling(
  task: () => void | Promise<void>,
  intervalMs: number,
  options: UsePollingOptions = {},
): Pick<Poller, 'trigger'> {
  const poller = createPoller(task, intervalMs, { immediate: options.immediate })

  watch(
    () => toValue(options.enabled ?? true),
    (enabled) => (enabled ? poller.start() : poller.stop()),
    { immediate: true },
  )

  onScopeDispose(() => poller.stop())

  return { trigger: poller.trigger }
}
