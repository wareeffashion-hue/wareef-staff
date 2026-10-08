// Wareef team: shows the system's alerts as phone notifications, even when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'وريف', body: e.data ? e.data.text() : '' }; }
  const urgent = !!d.urgent;
  e.waitUntil((async () => {
    // an open app rings out loud itself; the notification sound is up to the phone's settings
    if (urgent) for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) w.postMessage({ type: 'alarm', title: d.title, body: d.body, url: d.url });
    await self.registration.showNotification(d.title || 'وريف · فريق العمل', {
    body: d.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/badge-96.png',
    tag: d.tag || undefined,
    renotify: true,
    requireInteraction: urgent,               // alarms stay on screen until dismissed
    vibrate: urgent ? [600, 200, 600, 200, 1000] : [200, 100, 200],
    dir: 'rtl',
    lang: 'ar',
    timestamp: Date.now(),
    silent: false,
    data: { url: d.url || '/' },
  });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // the app's own window (not a report or payslip tab), else any window of the site, else a new one
    const mine = wins.filter((w) => new URL(w.url).origin === self.location.origin);
    const app = mine.find((w) => new URL(w.url).pathname === '/') || mine[0];
    if (app) {
      try { await app.focus(); await app.navigate(url); return; } catch { /* fall through and open one */ }
    }
    await self.clients.openWindow(url);
  })());
});
