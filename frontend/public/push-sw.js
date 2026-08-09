// Web Push handlers for the ledger service worker.
//
// This file is NOT the service worker: vite-plugin-pwa runs in `generateSW`
// mode, so Workbox generates sw.js (precache manifest + the "New version"
// prompt flow) and pulls this in via `workbox.importScripts`. Adding the
// handlers here rather than migrating to `injectManifest` keeps that generated
// caching/update logic untouched — see vite.config.ts.
//
// Every server send path marshals the same {title, body} JSON:
// server/notify.go pushAll, and the cap/threshold/drift paths in
// cmd/ledger/main.go.

/* global self, clients */

self.addEventListener("push", (event) => {
  // Never trust the payload: a malformed or absent body must still surface a
  // notification. On iOS a `push` handled without calling showNotification can
  // cost the site its push permission, so there is no early return here.
  let title = "ledger";
  let body = "";
  try {
    const data = event.data ? event.data.json() : {};
    if (typeof data.title === "string" && data.title) title = data.title;
    if (typeof data.body === "string") body = data.body;
  } catch {
    body = event.data ? event.data.text() : "";
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/manifest-icon-192.jpg",
      badge: "/manifest-icon-192.jpg",
      // Collapse repeats: a second budget alert replaces the first in the
      // shade rather than stacking into a wall of near-identical rows.
      tag: "ledger",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
      // Prefer an already-open window — opening a second one would strand the
      // user in a fresh instance while their real session sits behind it.
      for (const c of all) {
        if ("focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })(),
  );
});
