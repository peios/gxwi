// Drives headless Chromium over its debugging protocol through the logon pages.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const port = 9333;
const chrome = spawn("chromium", ["--headless", "--disable-gpu", "--hide-scrollbars",
    "--blink-settings=preferredColorScheme=0", "--window-size=900,640",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        target = list.find((t) => t.type === "page");
    } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let next = 1;
const waiting = new Map();
const log = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) waiting.get(msg.id)?.(msg);
    else if (msg.method === "Log.entryAdded") log.push(msg.params.entry.text);
};
const send = (method, params = {}) => new Promise((r) => {
    const id = next++;
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;

await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:7780/logon" });
await sleep(1500);
await js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);

const out = {};
out.title = await js(`document.querySelector("h1").textContent`);
out.buttonHidden = await js(`document.querySelector("button.reveal").hidden`);
out.typeBefore = await js(`document.querySelector(".secret input").type`);
await js(`document.querySelector(".secret input").value = "hunter2"; document.querySelector("button.reveal").click()`);
out.typeAfterClick = await js(`document.querySelector(".secret input").type`);
out.pressed = await js(`document.querySelector("button.reveal").getAttribute("aria-pressed")`);
const shot = await send("Page.captureScreenshot");
writeFileSync(new URL("eye.png", import.meta.url), Buffer.from(shot.result.data, "base64"));
// Something injected must still not run.
await js(`const s = document.createElement("script"); s.textContent = "window.injected = 1"; document.body.append(s)`);
out.injectedRan = await js(`window.injected === 1`);
// Submitting hides it again before the browser can remember it.
await js(`window.seen = null; document.forms[0].addEventListener("submit", (e) => { e.preventDefault(); window.seen = document.querySelector(".secret input").type; }); document.forms[0].requestSubmit()`);
out.typeAtSubmit = await js(`window.seen`);
out.log = log;
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill();
process.exit(0);
