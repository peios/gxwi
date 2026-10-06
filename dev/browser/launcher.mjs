// Fenestra's launcher, in headless Chromium: an overlay of the shell's, sent
// for by a chord from anywhere and worked by the keyboard. What matters is
// that it is in sight only where it was sent for, that the keyboard goes into
// it and comes back out, and that what it starts is started by the desktop.
//
// The dev VM declares the test app in the catalogue, which is what the
// launcher lists, so that there is something to start that can be seen.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const port = 9341;
const chrome = spawn("chromium", ["--headless", "--ignore-certificate-errors", "--disable-gpu", "--hide-scrollbars",
    "--blink-settings=preferredColorScheme=0", "--window-size=1200,800",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = (path, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method }).then((r) => r.json());

async function attach(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let next = 1;
    const waiting = new Map();
    const log = [];
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id) waiting.get(msg.id)?.(msg);
        else if (msg.method === "Log.entryAdded") log.push(msg.params.entry.text);
        else if (msg.method === "Runtime.consoleAPICalled") log.push(msg.params.args.map((a) => a.value).join(" "));
        else if (msg.method === "Runtime.exceptionThrown") log.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((r) => { const id = next++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    await send("Log.enable");
    await send("Runtime.enable");
    const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.result?.value;
    return { id: target.id, send, js, log };
}
const page = async (url) => attach(await browser(`/json/new?${url}`, "PUT"));
/** The frame of `parent` that `has` something, among those the browser keeps apart. */
async function frame(parent, has) {
    const all = await Promise.all((await browser("/json")).filter((t) => t.type === "iframe" && t.parentId === parent.id).map(attach));
    for (const one of all) if (await one.js(`!!document.querySelector(${JSON.stringify(has)})`)) return one;
    return null;
}

for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await browser("/json"); break; } catch {}
}
const a = await page("https://127.0.0.1:7780/");
await sleep(1500);
await a.js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);
await a.js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
await sleep(4000);

const out = {};
const finish = async (code) => {
    out.desktopLog = a.log;
    await a.js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
    await sleep(1000);
    console.log(JSON.stringify(out, null, 1));
    chrome.kill();
    process.exit(code);
};
const HELD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const CODES = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40, Space: 32 };
/** A key pressed for real, which goes wherever the keyboard is. `text` is what it types, if anything. */
async function press(on, chord, text) {
    const parts = chord.split("+");
    const key = parts.pop();
    const modifiers = parts.reduce((sum, part) => sum + HELD[part], 0);
    const letter = /^[A-Z0-9]$/.test(key);
    const params = {
        modifiers,
        key: letter ? key.toLowerCase() : key === "Space" ? " " : key,
        code: letter ? (/[0-9]/.test(key) ? `Digit${key}` : `Key${key}`) : key,
        windowsVirtualKeyCode: letter ? key.charCodeAt(0) : CODES[key] ?? 0,
    };
    await on.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...params, ...(text ? { text } : {}) });
    await on.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    await sleep(400);
}
/** What a desktop's page has of the launcher, the focus and the keyboard. */
const desk = `(() => {
    const overlay = document.querySelector(".fx-surface[data-role=overlay]");
    const at = overlay?.getBoundingClientRect();
    return {
        launcher: overlay ? (overlay.hidden ? "out of sight" : { id: Number(overlay.dataset.id), left: at.left, top: at.top, width: at.width, height: at.height, over: getComputedStyle(overlay).zIndex }) : "none",
        focused: Number(document.querySelector('.fx-surface[data-focused="true"]')?.dataset.id ?? 0),
        keyboardIn: Number(document.activeElement?.closest?.(".fx-surface")?.dataset.id ?? 0),
        windows: [...document.querySelectorAll(".fx-surface[data-role=window] .fx-title")].map((t) => t.textContent),
    };
})()`;
/** What the launcher shows. */
const shows = `({
    typing: document.activeElement?.name ?? null,
    query: document.querySelector("[name=query]").value,
    listed: [...document.querySelectorAll("li button")].map((b) => b.textContent + (b.getAttribute("aria-selected") ? " PICKED" : "")),
})`;

const launcher = await frame(a, "[name=query][fx-autofocus]");
if (!launcher) { out.stopped = "no launcher to attach to"; out.desk = await a.js(desk); await finish(1); }
out.atLogon = await a.js(desk);

// Sent for, with the keyboard in the desktop's own page.
await press(a, "Ctrl+Space");
out.sentFor = { desk: await a.js(desk), launcher: await launcher.js(shows) };
await press(a, "ArrowDown");
await press(a, "ArrowDown");
await press(a, "ArrowUp");
out.afterDownDownUp = (await launcher.js(shows)).listed.findIndex((entry) => entry.endsWith("PICKED"));
for (const letter of "HELLO") await press(a, letter, letter.toLowerCase());
await sleep(500);
out.afterTypingHello = await launcher.js(shows);
writeFileSync(new URL("launcher.png", import.meta.url), Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"));
await press(a, "Enter");
await sleep(3000);
out.afterEnter = { desk: await a.js(desk), launcher: await launcher.js(shows) };

// Sent for from inside the app it started, and sent away again.
await press(a, "Alt+2");
out.inTheApp = await a.js(desk);
await press(a, "Alt+P");
out.sentForFromInsideTheApp = { desk: await a.js(desk), launcher: await launcher.js(shows) };

// Another device, meanwhile, has no launcher in sight.
const b = await page("https://127.0.0.1:7780/");
await sleep(5000);
out.onAnotherDeviceMeanwhile = (await b.js(desk)).launcher;
await browser(`/json/close/${b.id}`).catch(() => {});

await press(a, "Escape");
out.afterEscape = await a.js(desk);

// A press on a window sends it away too.
await press(a, "Alt+P");
const tile = await a.js(`(() => { const r = document.querySelector(".fx-surface[data-kind=app][data-role=window] .fx-strip").getBoundingClientRect(); return { x: r.left + 200, y: r.top + 10 }; })()`);
await a.send("Input.dispatchMouseEvent", { type: "mousePressed", ...tile, button: "left", clickCount: 1 });
await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...tile, button: "left", clickCount: 1 });
await sleep(400);
out.afterAPressOnAWindow = await a.js(desk);

// An app that is no part of the shell asks to be over everything.
const app = await frame(a, "[fx-click=press]");
await app?.js(`parent.postMessage({ fx: "overlay", how: "show" }, "*")`);
await sleep(300);
out.launcherLog = launcher.log;
await finish(0);
