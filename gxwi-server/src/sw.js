// GXWI's service worker, for when the machine does not answer.
//
// A page loaded at this address while the machine is away (shut down,
// restarting, crashed, cut off) would get the browser's own error. This
// stands in for it: every request still goes to the machine as it always
// does, and only a page that does not come at all, or not within REQUEST_TIMEOUT_MS, is
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

const CACHE_PREFIX = "gxwi-away-";
const CACHE = `${CACHE_PREFIX}2`;
const AWAY = "/.gxwi/away";
const KEPT = [
    AWAY,
    "/.gxwi/logon.css",
    "/.gxwi/fonts/manrope.woff2",
    "/.gxwi/fonts/schibsted-grotesk.woff2",
];
// How long a page is waited for before the machine counts as not answering.
// gxwid keeps the address open while the server behind it is down, so a page
// asked for then is not refused: it never comes.
const REQUEST_TIMEOUT_MS = 10000;
// How often what is kept is fetched again, so the waiting page names the
// machine as it is called now.
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

let keptAtMs = 0;
function keep() {
    keptAtMs = Date.now();
    // From the machine itself, not the browser's own copies: the stylesheet
    // is kept by the browser for an hour, and a copy from before the waiting
    // page was styled drew it unstyled.
    const fresh = KEPT.map((url) => new Request(url, { cache: "reload" }));
    return caches
        .open(CACHE)
        .then((cache) => cache.addAll(fresh))
        .catch(() => {
            // Failed refresh leaves the previous offline page available.
        });
}

self.addEventListener("install", (event) => {
    event.waitUntil(keep().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names
                        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
                        .map((name) => caches.delete(name)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

/** The machine's answer, or nothing if it gives none within REQUEST_TIMEOUT_MS. */
function within(request) {
    const controller = new AbortController();
    const cancel = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new Error("no answer")), REQUEST_TIMEOUT_MS);
    return fetch(request, { signal: controller.signal }).finally(() => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", cancel);
    });
}

/** Read only GXWI's cached response, never an application's same-path entry. */
async function cached(path) {
    const cache = await caches.open(CACHE);
    return (await cache.match(path)) ?? Response.error();
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    if (request.cache === "no-store") return;
    // A page of its own in the tab, not one in a frame: a desktop's surfaces
    // have their own way of waiting.
    if (request.mode === "navigate" && request.destination === "document") {
        event.respondWith(
            (async () => {
                try {
                    const response = await within(request);
                    if (Date.now() - keptAtMs > CACHE_MAX_AGE_MS) event.waitUntil(keep());
                    return response;
                } catch {
                    return cached(AWAY);
                }
            })(),
        );
        return;
    }
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.search || !KEPT.includes(url.pathname)) return;
    event.respondWith(fetch(request).catch(() => cached(url.pathname)));
});
