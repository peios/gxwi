// The overlay, against the dev VM: set and removed in the registry while gxwid
// runs, and looked at both by a browser that alice is logged on in and by
// requests that carry no session at all.
//
// The overlay set here is GXWI's stand-in (dev/run-gxwid.sh puts a copy at
// /tmp/gxwi-overlay), because its page says who it is running as and which
// process it is, and it can be told to exit.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { guest, sleep } from "./harness.mjs";

const port = 9360;
const site = "http://127.0.0.1:7780";
const KEY = "'Machine\\Software\\GXWI'";
const set = (name, value) => guest(`reg set ${KEY} ${name} 'sz:${value}'`);
const remove = (name) => guest(`REG_ASSUME_YES=1 reg del --yes ${KEY} ${name}`);
const log = () => readFileSync(new URL("../../target/vmshare/gxwi.log", import.meta.url), "utf8");

const out = {};
const failed = [];
const expect = (what, holds) => { if (!holds) failed.push(what); };

/** A request with no cookies: somebody who has never been here. */
async function stranger(path = "/") {
    const response = await fetch(site + path, { redirect: "manual" });
    const body = await response.text();
    return {
        status: response.status,
        heading: /<h1>([^<]*)<\/h1>/.exec(body)?.[1] ?? null,
        process: /process\s+(\d+)/.exec(body)?.[1] ?? null,
        administrator: body.includes("S-1-5-32-544"),
        asked: /You asked for <code>([^<]*)<\/code>/.exec(body)?.[1] ?? null,
        refresh: response.headers.get("refresh"),
    };
}

/** Asks as a stranger until `until` holds of the answer, or `seconds` pass. */
async function eventually(until, seconds = 20, path = "/") {
    const started = Date.now();
    let last;
    while (Date.now() - started < seconds * 1000) {
        last = await stranger(path).catch(() => null);
        if (last && until(last)) return { ...last, after: Math.round((Date.now() - started) / 100) / 10 };
        await sleep(250);
    }
    return { ...last, after: null };
}

const chrome = spawn("chromium", ["--headless", "--disable-gpu", "--hide-scrollbars",
    "--blink-settings=preferredColorScheme=0", "--window-size=1100,720",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let next = 1;
const waiting = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id) waiting.get(msg.id)?.(msg); };
const send = (method, params = {}) => new Promise((r) => { const id = next++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result?.value;
const picture = async (name) => writeFileSync(new URL(name, import.meta.url), Buffer.from((await send("Page.captureScreenshot")).result.data, "base64"));
/** What the browser alice is logged on in is showing. */
const seen = () => js(`({
    heading: document.querySelector("h1")?.textContent ?? null,
    desktop: !!document.querySelector(".fx-surface, #fx-root, [data-role]"),
    process: /process\\s+(\\d+)/.exec(document.querySelector("pre")?.textContent ?? "")?.[1] ?? null,
    websocket: document.getElementById("ws")?.textContent ?? null,
    title: document.title,
})`);
const reload = async () => { await send("Page.reload"); await sleep(2500); return seen(); };

try {
    // From nothing: whatever an earlier run left set is taken away.
    remove("OverlaySession");
    remove("OverlayUsername");
    out.none = await eventually((s) => s.heading === "Sign in");
    expect("with no overlay a stranger is asked to sign in", out.none.status === 401 && out.none.heading === "Sign in");

    // alice logs on, and has a desktop.
    await send("Page.enable");
    await send("Page.navigate", { url: site + "/" });
    await sleep(1500);
    await js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
    await sleep(2000);
    await js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
    await sleep(4000);
    out.alice = await seen();
    expect("alice has a session", out.alice.heading !== "Sign in" && out.alice.heading !== "Not available yet");

    // An overlay as peios, who has no credential: it appears with no logon.
    set("OverlayUsername", "peios");
    set("OverlaySession", "/tmp/gxwi-overlay");
    out.up = await eventually((s) => s.status === 200 && s.heading === "A session", 20, "/some/where?x=1");
    expect("the overlay answers a stranger with no logon", out.up.status === 200 && out.up.heading === "A session");
    expect("it runs as peios, an administrator", out.up.administrator === true);
    expect("it is sent the path that was asked for", out.up.asked?.endsWith("/some/where?x=1") === true);
    out.aliceCovered = await reload();
    await picture("overlay.png");
    expect("alice, logged on, is sent to it too", out.aliceCovered.heading === "A session" && out.aliceCovered.process === out.up.process);
    expect("a websocket reaches it", out.aliceCovered.websocket === "echoed");
    expect("everyone shares one overlay", (await stranger()).process === out.up.process);

    // It exits: nobody is shown anything else, and it comes back as another process.
    await fetch(site + "/.hello/logoff", { method: "POST" }).catch(() => null);
    out.gone = await eventually((s) => s.status === 503, 5);
    expect("while it is gone a stranger is told it is not available", out.gone.status === 503 && out.gone.heading === "Not available yet");
    expect("and the page asks again by itself", out.gone.refresh === "5");
    out.back = await eventually((s) => s.status === 200 && s.heading === "A session");
    expect("an overlay that exits is started again", out.back.status === 200 && out.back.process !== out.up.process);

    // An account with a password is refused, and the logon pages do not come back.
    set("OverlayUsername", "alice");
    out.refused = await eventually((s) => s.status === 503, 15);
    await sleep(4000);
    out.stillRefused = await stranger();
    expect("an account with a password cannot be an overlay's", out.refused.status === 503 && out.stillRefused.status === 503);
    out.refusedWhy = log().split("\n").filter((l) => l.includes("the overlay could not be started")).at(-1) ?? null;
    expect("gxwid says why", /alice/.test(out.refusedWhy ?? ""));
    out.aliceRefused = await reload();
    await picture("overlay-unavailable.png");
    expect("alice, logged on, is not given her session back by it", out.aliceRefused.heading === "Not available yet");

    // The browser is showing the page that asks again: put the overlay right
    // and it arrives without anyone reloading.
    set("OverlayUsername", "peios");
    await eventually((s) => s.status === 200, 20);
    await sleep(7000);
    out.cameBack = await seen();
    expect("the page that asks again finds the overlay", out.cameBack.heading === "A session");

    // Nobody to run as, and a program that is not there.
    remove("OverlayUsername");
    out.nobody = await eventually((s) => s.status === 503, 15);
    expect("an overlay with nobody to run as is not available", out.nobody.status === 503);
    set("OverlayUsername", "peios");
    set("OverlaySession", "/tmp/no-such-overlay");
    await sleep(3000);
    out.missing = await eventually((s) => s.status === 503, 15);
    expect("an overlay whose program is not there is not available", out.missing.status === 503);

    // A value that makes no sense is no overlay.
    set("OverlaySession", "not-a-path");
    out.nonsense = await eventually((s) => s.status === 401, 15);
    expect("an OverlaySession that is not a path is ignored", out.nonsense.status === 401 && out.nonsense.heading === "Sign in");

    // Taken away: strangers are asked to sign in, and alice's session is where it was.
    set("OverlaySession", "/tmp/gxwi-overlay");
    await eventually((s) => s.status === 200, 20);
    remove("OverlaySession");
    out.removed = await eventually((s) => s.status === 401, 15);
    expect("with the overlay removed a stranger is asked to sign in", out.removed.status === 401 && out.removed.heading === "Sign in");
    out.aliceBack = await reload();
    expect("and alice has her session back without logging on", out.aliceBack.heading === out.alice.heading && out.aliceBack.title === out.alice.title);

    // Last, because both forget who was logged on in which browser.
    //
    // gxwi-server goes and another is started: it is told of the overlay
    // before it serves, and gets a connection of its own to the same one.
    set("OverlaySession", "/tmp/gxwi-overlay");
    out.again = await eventually((s) => s.status === 200, 20);
    guest(`for p in /proc/[0-9]*; do read -r c < $p/comm 2>/dev/null && [ "$c" = gxwi-server ] && kill "\${p#/proc/}"; done`);
    await sleep(500);
    out.newServer = await eventually((s) => s.status === 200 && s.heading === "A session", 20);
    expect("a new gxwi-server is sent to the same overlay", out.newServer.process === out.again.process);
    expect("and showed nothing else on the way", !log().split("gxwi-server exited").at(-1).includes("the overlay is not set"));

    // gxwid goes and another is started: it ends the overlay it finds, which
    // it could neither end later nor watch, and starts its own.
    guest("svctl restart gxwid");
    out.newGxwid = await eventually((s) => s.status === 200 && s.heading === "A session" && s.process !== out.again.process, 40);
    expect("a new gxwid starts an overlay of its own", out.newGxwid.status === 200);
    const since = log().split("gxwid: listening on").at(-1);
    expect("having ended the one it found", since.includes("ending the overlay an earlier gxwid left running"));
    expect("and showed nothing else on the way", !since.includes("the overlay is not set"));
} finally {
    remove("OverlaySession");
    remove("OverlayUsername");
    await js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
    await js(`fetch("/.hello/logoff", { method: "POST" }).then(() => 0, () => 0)`);
    await sleep(1000);
    out.failed = failed;
    console.log(JSON.stringify(out, null, 1));
    ws.close();
    chrome.kill();
    process.exit(failed.length ? 1 : 0);
}
