// Two browser pages on one Fenestra session: Space opens surfaces, both pages
// see them, each lays out for its own size, close works, focus is per page.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const port = 9335;
const chrome = spawn("chromium", ["--headless", "--disable-gpu", "--hide-scrollbars",
    "--blink-settings=preferredColorScheme=0", "--window-size=1200,800",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let next = 1;
    const waiting = new Map();
    const log = [];
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id) waiting.get(msg.id)?.(msg);
        else if (msg.method === "Log.entryAdded") log.push(msg.params.entry.text);
        else if (msg.method === "Runtime.exceptionThrown") log.push(msg.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((r) => { const id = next++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    await send("Log.enable");
    await send("Runtime.enable");
    const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;
    const key = async (code, k) => {
        await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: k, windowsVirtualKeyCode: 32 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: k, windowsVirtualKeyCode: 32 });
    };
    const shot = async (name) => writeFileSync(new URL(name, import.meta.url), Buffer.from((await send("Page.captureScreenshot")).result.data, "base64"));
    return { send, js, key, shot, log };
}

for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await fetch(`http://127.0.0.1:${port}/json`); break; } catch {}
}
const tiles = `[...document.querySelectorAll(".fx-surface:not([hidden])")].map(e => e.dataset.id + (e.dataset.focused === "true" ? "*" : "")).join(" ")`;

const a = await page("http://127.0.0.1:7780/");
await sleep(1500);
await a.js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);
await a.js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
await sleep(3000);

const out = {};
out.start = await a.js(tiles);
for (let i = 0; i < 4; i++) { await a.key("Space", " "); await sleep(300); }
out.afterFourSpaces = await a.js(tiles);
out.strip = await a.js(`[...document.querySelector(".fx-strip").children].map(e => e.className + "=" + e.textContent).join(" | ")`);
await a.shot("desktop-wide.png");

// A second page on the same session, phone sized.
const b = await page("http://127.0.0.1:7780/");
await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
await sleep(2000);
out.phoneSees = await b.js(`document.querySelectorAll(".fx-surface").length + " surfaces, showing: " + ${tiles}`);
await b.js(`document.querySelector('.fx-surface:not([hidden]) [data-action="next"]').click()`);
await sleep(300);
out.phoneAfterNext = await b.js(tiles);
await b.shot("desktop-phone.png");
out.wideUnmovedByPhone = await a.js(tiles);

// Close one from the phone; the wide page hears of it.
await b.js(`document.querySelector('.fx-surface:not([hidden]) [data-part="close"]').click()`);
await sleep(500);
out.wideAfterPhoneClosedOne = await a.js(tiles);
out.phoneAfterClose = await b.js(tiles);

// Focus by pressing a tile on the wide page.
await a.js(`document.querySelector('.fx-surface[data-focused="false"] .fx-content').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
out.wideAfterPressingAnother = await a.js(tiles);
out.debugText = (await a.js(`document.querySelector('.fx-surface[data-focused="true"] .debug-facts').textContent`)).split("\n").slice(0, 5);
out.errors = [...a.log, ...b.log];

// Leave the session as it was found.
await a.js(`document.querySelector("form").submit()`);
await sleep(1500);
console.log(JSON.stringify(out, null, 1));
chrome.kill();
process.exit(0);
