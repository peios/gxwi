// A live surface, in headless Chromium: the app's process draws it and the
// page is the desktop's. What matters is that the page holds nothing: what is
// typed on one page is there on another, and after the first is loaded again.
//
// The desktop cannot see into an app's frame and neither can a script in it,
// but the browser's debugger can: a frame kept apart gets a process of its
// own, which shows up as a target to attach to.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const port = 9338;
const chrome = spawn("chromium", ["--headless", "--disable-gpu", "--hide-scrollbars",
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
        else if (msg.method === "Runtime.exceptionThrown") log.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((r) => { const id = next++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    await send("Log.enable");
    await send("Runtime.enable");
    const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.result?.value;
    return { id: target.id, send, js, log };
}
const page = async (url) => attach(await browser(`/json/new?${url}`, "PUT"));
/** The frames of `parent` that the browser keeps in processes of their own. */
const frames = async (parent) => Promise.all((await browser("/json")).filter((t) => t.type === "iframe" && t.parentId === parent.id).map(attach));

for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await browser("/json"); break; } catch {}
}
const a = await page("http://127.0.0.1:7780/");
await sleep(1500);
await a.js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);
await a.js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
await sleep(3000);

const out = {};
const finish = async (code) => {
    out.desktopErrors = a.log;
    await a.js(`document.querySelector("form")?.submit()`);
    await sleep(1500);
    console.log(JSON.stringify(out, null, 1));
    chrome.kill();
    process.exit(code);
};
const key = async (shift) => {
    const params = { code: "Enter", key: "Enter", windowsVirtualKeyCode: 13, modifiers: shift ? 8 : 0 };
    await a.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
    await a.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
};
const shows = `({ text: document.getElementById("fx-root").innerText.replace(/\\n+/g, " | "), note: document.querySelector("[name=note]")?.value, connected: document.getElementById("fx-root").dataset.connected })`;
const type = (text) => `(() => { const i = document.querySelector("[name=note]"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`;

await key(false);
await sleep(3000);
let [fa] = await frames(a);
if (!fa) { out.stopped = "no frame of the app's to attach to"; await finish(1); }
out.atFirst = await fa.js(shows);
out.thePage = await fa.js(`({ scripts: document.scripts.length, stylesheets: [...document.styleSheets].map(s => new URL(s.href).pathname.split("/").slice(4).join("/")), themed: getComputedStyle(document.body).getPropertyValue("--accent-solid").trim(), origin: self.origin })`);

// Three presses. The button pressed is still the same element afterwards:
// the page was changed to match, not swapped.
await fa.js(`window.pressed = document.querySelector("[fx-click=press]")`);
for (let i = 0; i < 3; i++) { await fa.js(`document.querySelector("[fx-click=press]").click()`); await sleep(200); }
out.afterThreePresses = await fa.js(shows);
out.sameButton = await fa.js(`window.pressed === document.querySelector("[fx-click=press]")`);

// Half a note, left in the field with the keyboard still in it.
await fa.js(type("half a no"));
await sleep(600);
out.whileTyping = await fa.js(shows);

// A second page on the same session. It was never told anything by the first.
const b = await page("http://127.0.0.1:7780/");
await sleep(4000);
const [fb] = await frames(b);
out.theSecondPage = fb ? await fb.js(shows) : "no frame";
// Typed on from there: the first page's field follows, keyboard in it or not,
// because it was not the first page that said it.
if (fb) await fb.js(type("half a note, finished elsewhere"));
await sleep(700);
out.backOnTheFirst = await fa.js(shows);
// Cleared by the process, which every page obeys.
await fa.js(`document.querySelector("[fx-click=clear]").click()`);
await sleep(600);
out.afterClear = { first: (await fa.js(shows)).note, second: fb ? (await fb.js(shows)).note : undefined };

// The first page loaded again from nothing.
await fb?.js(type("kept by the process"));
await sleep(600);
await a.send("Page.reload");
await sleep(4000);
[fa] = await frames(a);
out.afterLoadingThePageAgain = fa ? await fa.js(shows) : "no frame";
out.frameErrors = [...new Set([...(fa?.log ?? []), ...(fb?.log ?? [])])];
writeFileSync(new URL("live.png", import.meta.url), Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"));
await browser(`/json/close/${b.id}`).catch(() => {});

// A page of the app's own still works, asked for by name.
await a.js(`document.querySelector(".fx-surface[data-kind=debug]").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); window.focus()`);
await key(true);
await sleep(4000);
out.aRawPageFound = await a.js(`fetch([...document.querySelectorAll("iframe")].at(-1).getAttribute("src") + "found").then(r => r.ok ? r.json() : "status " + r.status, String)`);
await finish(0);
