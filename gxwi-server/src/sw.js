// GXWI's service worker, for when the machine does not answer.
//
// A page loaded at this address while the machine is away (shut down,
// restarting, crashed, cut off) would get the browser's own error. This
// stands in for it: every request still goes to the machine as it always
// does, and only a page that does not come at all, or not within WAIT, is
// answered with the waiting page kept from the last time the machine was
// there. That page shows the mark until the machine answers again, then
// loads what was asked for.
//
// Nothing else is ever answered from what is kept, except what the waiting
// page is drawn with, and then only when the machine does not answer. A
// request that asks not to be kept (cache: "no-store") is never answered
// from it: that is how a page asks whether the machine is back.
//
// Browsers run service workers only on HTTPS and on the local machine, so
// over plain HTTP elsewhere this is never installed.

const CACHE = "gxwi-away-1";
const AWAY = "/.gxwi/away";
const KEPT = [AWAY, "/.gxwi/logon.css", "/.gxwi/fonts/manrope.woff2", "/.gxwi/fonts/schibsted-grotesk.woff2"];
// How long a page is waited for before the machine counts as not answering.
// gxwid keeps the address open while the server behind it is down, so a page
// asked for then is not refused: it never comes.
const WAIT = 10000;
// How often what is kept is fetched again, so the waiting page names the
// machine as it is called now.
const FRESH = 10 * 60 * 1000;

let keptAt = 0;
function keep() {
    keptAt = Date.now();
    return caches.open(CACHE).then((cache) => cache.addAll(KEPT)).catch(() => {});
}

self.addEventListener("install", (event) => {
    event.waitUntil(keep().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys()
        .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
        .then(() => self.clients.claim()));
});

/** The machine's answer, or nothing if it gives none within WAIT. */
function within(request) {
    let timer;
    return Promise.race([
        fetch(request),
        new Promise((_, fail) => (timer = setTimeout(() => fail(new Error("no answer")), WAIT))),
    ]).finally(() => clearTimeout(timer));
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    // A page of its own in the tab, not one in a frame: a desktop's surfaces
    // have their own way of waiting.
    if (request.mode === "navigate" && request.destination === "document") {
        event.respondWith((async () => {
            try {
                const response = await within(request);
                if (Date.now() - keptAt > FRESH) event.waitUntil(keep());
                return response;
            } catch {
                return (await caches.match(AWAY)) ?? Response.error();
            }
        })());
        return;
    }
    if (request.cache === "no-store") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.search || !KEPT.includes(url.pathname)) return;
    event.respondWith(fetch(request).catch(async () => (await caches.match(url.pathname)) ?? Response.error()));
});
