import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPoller, type VisibilitySource } from './usePolling'

function fakeVisibility(initial = true) {
  let visible = initial
  const listeners = new Set<() => void>()
  const source: VisibilitySource = {
    isVisible: () => visible,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    source,
    listenerCount: () => listeners.size,
    set(next: boolean) {
      visible = next
      listeners.forEach((l) => l())
    },
  }
}

describe('createPoller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs once right away and then on every interval while visible', async () => {
    const task = vi.fn()
    const poller = createPoller(task, 1000, { visibility: fakeVisibility().source })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3000)
    expect(task).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('pauses in a hidden tab and loads immediately when it comes back', async () => {
    const task = vi.fn()
    const vis = fakeVisibility()
    const poller = createPoller(task, 1000, { visibility: vis.source })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)

    vis.set(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(task).toHaveBeenCalledTimes(1)

    vis.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('does not run at all when started in a hidden tab, until it becomes visible', async () => {
    const task = vi.fn()
    const vis = fakeVisibility(false)
    const poller = createPoller(task, 1000, { visibility: vis.source })
    poller.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(task).not.toHaveBeenCalled()

    vis.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('stop() ends the timer and the visibility listener', async () => {
    const task = vi.fn()
    const vis = fakeVisibility()
    const poller = createPoller(task, 1000, { visibility: vis.source })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)

    poller.stop()
    expect(vis.listenerCount()).toBe(0)
    expect(poller.active).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    vis.set(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('does not overlap a run that is still in flight', async () => {
    let release: () => void = () => {}
    const task = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const poller = createPoller(task, 1000, { visibility: fakeVisibility().source })
    poller.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(task).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('keeps polling after a task throws', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const poller = createPoller(task, 1000, { visibility: fakeVisibility().source })
    poller.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(task).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('skips the initial run with immediate: false but still loads on return', async () => {
    const task = vi.fn()
    const vis = fakeVisibility()
    const poller = createPoller(task, 1000, { visibility: vis.source, immediate: false })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(task).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(1)

    vis.set(false)
    vis.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('start() twice does not create a second timer', async () => {
    const task = vi.fn()
    const poller = createPoller(task, 1000, { visibility: fakeVisibility().source })
    poller.start()
    poller.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(2)
    poller.stop()
  })
})
