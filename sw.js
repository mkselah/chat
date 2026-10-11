// Minimal service worker: makes the site installable as an app.
// No caching on purpose, so you always get the newest code after a deploy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));