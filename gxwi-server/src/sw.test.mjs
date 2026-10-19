import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
const ORIGIN = "https://gxwi.example";
const OFFLINE = "cached waiting page";

function fixture(fetch = async () => new Response("online")) {
    const handlers = new Map();
    const timers = new Map();
    const deleted = [];
    const lookedUp = [];
    const opened = [];
    const fetched = [];
    let nextTimer = 1;
    const context = vm.createContext({
        self: {
            addEventListener: (name, handler) => handlers.set(name, handler),
            clients: { claim: async () => {} },
            location: { origin: ORIGIN },
        },
        caches: {
            keys: async () => ["gxwi-away-1", "gxwi-away-2", "application-data", "gxwi-other"],
            delete: async (name) => deleted.push(name),
            match: async () => "unrelated application response",
            open: async (name) => {
                opened.push(name);
                return {
                    addAll: async () => {},
                    match: async (path) => {
                        lookedUp.push(path);
                        return OFFLINE;
                    },
                };
            },
        },
        fetch: (request, options) => {
            fetched.push({ request, options });
            return fetch(request, options);
        },
        setTimeout: (callback) => {
            const id = nextTimer++;
            timers.set(id, callback);
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        Request,
        Response,
        URL,
        AbortController,
        Date: { now: () => 0 },
    });
    vm.runInContext(source, context, { filename: "sw.js" });
    return { handlers, timers, deleted, lookedUp, opened, fetched, context };
}

function request(overrides = {}) {
    return {
        method: "GET",
        mode: "navigate",
        destination: "document",
        cache: "default",
        url: `${ORIGIN}/desktop`,
        signal: new AbortController().signal,
        ...overrides,
    };
}

function dispatch(worker, incoming) {
    let response;
    worker.handlers.get("fetch")({
        request: incoming,
        respondWith: (pending) => {
            assert.equal(response, undefined, "a request has only one response");
            response = pending;
        },
        waitUntil: () => {},
    });
    return response;
}

function pendingUntilAborted(_request, { signal }) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

test("activation removes only obsolete GXWI waiting-page caches", async () => {
    const worker = fixture();
    let completed;
    worker.handlers.get("activate")({ waitUntil: (pending) => (completed = pending) });
    await completed;
    assert.deepEqual(worker.deleted, ["gxwi-away-1"]);
});

test("no-store navigation bypasses offline interception", () => {
    const worker = fixture();
    assert.equal(dispatch(worker, request({ cache: "no-store" })), undefined);
    assert.equal(worker.fetched.length, 0);
    assert.deepEqual(worker.lookedUp, []);
});

test("no-store asset requests also bypass offline interception", () => {
    const worker = fixture();
    const incoming = request({
        mode: "cors",
        destination: "style",
        url: `${ORIGIN}/.gxwi/logon.css`,
        cache: "no-store",
    });
    assert.equal(dispatch(worker, incoming), undefined);
    assert.equal(worker.fetched.length, 0);
});

test("navigation timeout aborts the live fetch before serving the waiting page", async () => {
    const worker = fixture(pendingUntilAborted);
    const response = dispatch(worker, request());
    assert.equal(worker.timers.size, 1);
    const signal = worker.fetched[0].options.signal;
    assert.equal(signal.aborted, false);
    [...worker.timers.values()][0]();
    assert.equal(await response, OFFLINE);
    assert.equal(signal.aborted, true);
    assert.deepEqual(worker.lookedUp, ["/.gxwi/away"]);
    assert.equal(worker.timers.size, 0);
});

test("caller cancellation reaches the fetch and releases its timeout", async () => {
    const worker = fixture(pendingUntilAborted);
    const caller = new AbortController();
    const incoming = request({ signal: caller.signal });
    worker.context.incoming = incoming;
    const pending = vm.runInContext("within(incoming)", worker.context);
    const reason = new Error("caller stopped navigating");
    caller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(worker.fetched[0].options.signal.reason, reason);
    assert.equal(worker.timers.size, 0);
});

test("an already cancelled request stays cancelled", async () => {
    const worker = fixture(pendingUntilAborted);
    const caller = new AbortController();
    caller.abort(new Error("already cancelled"));
    worker.context.incoming = request({ signal: caller.signal });
    await assert.rejects(vm.runInContext("within(incoming)", worker.context), /already cancelled/);
    assert.equal(worker.timers.size, 0);
});

test("a successful navigation keeps its network response and clears its timeout", async () => {
    const answer = new Response("desktop");
    const worker = fixture(async () => answer);
    const incoming = request();
    assert.equal(await dispatch(worker, incoming), answer);
    assert.equal(worker.fetched[0].request, incoming);
    assert.equal(worker.timers.size, 0);
    assert.deepEqual(worker.lookedUp, []);
});

test("offline navigation receives the waiting page", async () => {
    const worker = fixture(async () => {
        throw new Error("offline");
    });
    assert.equal(await dispatch(worker, request()), OFFLINE);
    assert.equal(worker.timers.size, 0);
});

test("frame navigations and non-GET requests are left alone", () => {
    const worker = fixture();
    assert.equal(dispatch(worker, request({ destination: "iframe" })), undefined);
    assert.equal(dispatch(worker, request({ method: "POST" })), undefined);
    assert.equal(worker.fetched.length, 0);
});

test("only named offline assets may fall back to cached responses", async () => {
    const worker = fixture(async () => {
        throw new Error("offline");
    });
    const asset = request({ mode: "cors", destination: "style", url: `${ORIGIN}/.gxwi/logon.css` });
    assert.equal(await dispatch(worker, asset), OFFLINE);
    assert.deepEqual(worker.lookedUp, ["/.gxwi/logon.css"]);
    assert.equal(dispatch(worker, { ...asset, url: `${ORIGIN}/app/private.css` }), undefined);
    assert.equal(dispatch(worker, { ...asset, url: `${ORIGIN}/.gxwi/logon.css?v=1` }), undefined);
    assert.equal(
        dispatch(worker, { ...asset, url: "https://elsewhere.example/.gxwi/logon.css" }),
        undefined,
    );
});

test("fallback reads only GXWI's cache even when another cache has the same path", async () => {
    const worker = fixture(async () => {
        throw new Error("offline");
    });
    assert.equal(await dispatch(worker, request()), OFFLINE);
    const asset = request({ mode: "cors", destination: "style", url: `${ORIGIN}/.gxwi/logon.css` });
    assert.equal(await dispatch(worker, asset), OFFLINE);
    assert.deepEqual(worker.opened, ["gxwi-away-2", "gxwi-away-2"]);
});
