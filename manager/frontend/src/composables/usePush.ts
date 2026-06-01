import { ref } from 'vue'
import { pushApi } from '@/api/push'

/**
 * Browser-side Web Push helper. Talks to the Workbox-generated service worker
 * (which imports push-sw.js) and the panel's /api/push endpoints.
 */

const VAPID_KEY = ref<string | null>(null)
const subscribed = ref(false)
const supported = ref(typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)
const busy = ref(false)

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const out = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported.value) return null
  try {
    return await navigator.serviceWorker.ready
  } catch {
    return null
  }
}

export function usePush() {
  /** Reflect whether this browser currently holds a push subscription. */
  async function refresh(): Promise<void> {
    if (!supported.value) return
    try {
      const info = await pushApi.getVapidKey()
      VAPID_KEY.value = info.key
      if (!info.enabled) { subscribed.value = false; return }
      const reg = await getRegistration()
      const sub = reg ? await reg.pushManager.getSubscription() : null
      subscribed.value = !!sub
    } catch {
      subscribed.value = false
    }
  }

  /** Ask permission, subscribe with the VAPID key, and register server-side. */
  async function enable(): Promise<{ ok: boolean; error?: string }> {
    if (!supported.value) return { ok: false, error: 'unsupported' }
    busy.value = true
    try {
      const info = await pushApi.getVapidKey()
      if (!info.enabled || !info.key) return { ok: false, error: 'disabled' }
      VAPID_KEY.value = info.key

      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return { ok: false, error: 'denied' }

      const reg = await getRegistration()
      if (!reg) return { ok: false, error: 'no-sw' }

      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(info.key),
        })
      }
      await pushApi.subscribe(sub.toJSON())
      subscribed.value = true
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'failed' }
    } finally {
      busy.value = false
    }
  }

  /** Remove the browser subscription and deregister it server-side. */
  async function disable(): Promise<void> {
    busy.value = true
    try {
      const reg = await getRegistration()
      const sub = reg ? await reg.pushManager.getSubscription() : null
      if (sub) {
        await pushApi.unsubscribe(sub.endpoint).catch(() => {})
        await sub.unsubscribe().catch(() => {})
      }
      subscribed.value = false
    } finally {
      busy.value = false
    }
  }

  async function test(): Promise<boolean> {
    try { await pushApi.test(); return true } catch { return false }
  }

  return { supported, subscribed, busy, refresh, enable, disable, test }
}
