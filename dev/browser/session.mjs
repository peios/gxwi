// Logs on in headless Chromium, checks the websocket through gxwi-server, logs off.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const port = 9334;
const chrome = spawn("chromium", ["--headless", "--ignore-certificate-errors", "--disable-gpu", "--hide-scrollbars",
    "--blink-settings=preferredColorScheme=0", "--window-size=900,640",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;

await send("Page.enable");
await send("Page.navigate", { url: "https://127.0.0.1:7780/desktop/files?open=1" });
await sleep(1500);
await js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);
await js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
await sleep(3000);

const out = {};
out.urlAfterLogon = await js(`location.href`);
out.heading = await js(`document.querySelector("h1").textContent`);
out.websocket = await js(`document.getElementById("ws").textContent`);
out.pageSeesCookie = await js(`document.cookie`);
const shot = await send("Page.captureScreenshot");
writeFileSync(new URL("session.png", import.meta.url), Buffer.from(shot.result.data, "base64"));
await js(`document.forms[0].submit()`);
await sleep(2500);
out.afterLogoffHeading = await js(`document.querySelector("h1").textContent`);
out.afterLogoffUrl = await js(`location.href`);
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill();
process.exit(0);
