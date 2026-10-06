// A real mouse drag on the gap between two tiles, in headless Chromium.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const port = 9336;
const chrome = spawn("chromium", ["--headless", "--ignore-certificate-errors", "--disable-gpu", "--hide-scrollbars",
    "--blink-settings=preferredColorScheme=0", "--window-size=1200,800",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let next = 1;
const waiting = new Map();
const log = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) waiting.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") log.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((r) => { const id = next++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;
const mouse = (type, x, y, buttons = 1) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
const space = async () => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", code: "Space", key: " ", windowsVirtualKeyCode: 32 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", code: "Space", key: " ", windowsVirtualKeyCode: 32 });
};
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: "https://127.0.0.1:7780/" });
await sleep(1500);
await js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);
await js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
await sleep(3000);
await space(); await sleep(300); await space(); await sleep(500);

const widths = `[...document.querySelectorAll(".fx-surface")].map(e => e.dataset.id + ":" + Math.round(e.offsetWidth) + "x" + Math.round(e.offsetHeight)).join(" ")`;
const out = { before: await js(widths), handles: await js(`document.querySelectorAll(".fx-handle").length`) };
// The first handle is the upright gap between the left half and the right.
const h = await js(`(() => { const r = [...document.querySelectorAll(".fx-handle")].find(e => e.style.cursor === "col-resize").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await mouse("mousePressed", h.x, h.y);
for (let x = h.x; x >= 350; x -= 25) { await mouse("mouseMoved", x, h.y + 40); await sleep(16); }
out.during = await js(widths);
out.draggingFlag = await js(`document.getElementById("desktop").dataset.dragging ?? null`);
await mouse("mouseReleased", 350, h.y + 40, 0);
await sleep(300);
out.after = await js(widths);
out.flagAfter = await js(`document.getElementById("desktop").dataset.dragging ?? null`);
writeFileSync(new URL("drag.png", import.meta.url), Buffer.from((await send("Page.captureScreenshot")).result.data, "base64"));
out.errors = log;
await js(`document.querySelector("form").submit()`);
await sleep(1500);
console.log(JSON.stringify(out, null, 1));
chrome.kill();
process.exit(0);
