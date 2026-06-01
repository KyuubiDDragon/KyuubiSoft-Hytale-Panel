/* Web Push handlers, imported into the Workbox-generated service worker via
 * `workbox.importScripts` (see vite.config.ts). Keeps the push/notification
 * logic out of the auto-generated precache SW. */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = { title: 'KyuubiSoft Hytale Panel', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'KyuubiSoft Hytale Panel'
  const options = {
    body: data.body || '',
    icon: '/logo.png',
    badge: '/logo.png',
    data: { link: data.link || '/' },
    tag: data.tag || 'kp-alert',
    renotify: true,
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = (event.notification.data && event.notification.data.link) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) {
            try { client.navigate(link) } catch (e) { /* cross-origin or unsupported */ }
          }
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(link)
    })
  )
})
