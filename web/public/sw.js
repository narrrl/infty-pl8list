// Makes the app installable from the browser (some browsers want a service worker
// for that) and shows a short note instead of the browser's error page when the
// phone is offline. Nothing is cached: audio, artwork and the feed always come
// from the network, and every other request passes straight through.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>pl8list ∞</title></head>
<body bgcolor="#000000" text="#f2f2f2"><p>You are offline. pl8list ∞ needs a connection to play.</p></body></html>`;

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    fetch(e.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })),
  );
});
