// Pinning to fenesh's dock, in headless Chromium. What matters is that what
// the administrator pinned is there before anything runs; that a press on a
// pin that is not running starts it, and the program is then drawn in the
// pin's place; that the menu of a running program pins it and the menu of a
// pin unpins it; that the launcher's entries pin as well; and that what was
// pinned is still pinned in the next session, which is the registry's doing.
//
// Only fenesh has pins, so this needs ../../../fenesh/dev/push.sh to have
// made it the shell, which also pins Gexora for everybody. It starts from
// alice having pinned nothing: her `CurrentUser\Software\fenesh` `Pinned`
// has to be absent, and is not afterwards.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

const port = 9353;
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
/** The frame of `parent` with something matching `has` in it. */
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
const logOn = async () => {
    await sleep(1500);
    await a.js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
    await sleep(2000);
    await a.js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
    await sleep(4000);
};
await logOn();

const out = {};
const finish = async (code) => {
    out.desktopErrors = a.log;
    await a.js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
    await sleep(1500);
    console.log(JSON.stringify(out, null, 1));
    chrome.kill();
    process.exit(code);
};

/** The dock's entries in order: which, whether running, how many windows, which menu. */
const entries = `[...document.querySelectorAll(".dock > ul > li")].map((li) => ({
    id: li.id,
    idle: li.classList.contains("idle"),
    windows: li.querySelectorAll(".windows i").length,
    menu: li.getAttribute("fx-menu"),
    key: li.querySelector("button").getAttribute("fx-global-key"),
    title: li.querySelector("button").title,
    icon: li.querySelector("img").getAttribute("src").split("/").at(-1),
}))`;
/** A secondary press on the element with this id, in the middle of it. */
const menuOn = (id) => `(() => {
    const at = document.getElementById(${JSON.stringify(id)});
    if (!at) return "no such element";
    const r = at.getBoundingClientRect();
    at.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }));
    return "asked";
})()`;
const menu = `(() => {
    const menu = document.querySelector(".fx-menu");
    if (!menu) return null;
    const r = menu.getBoundingClientRect();
    return { items: [...menu.querySelectorAll("button")].map((b) => b.textContent), left: Math.round(r.left), inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
})()`;
const choose = (label) => `(() => { const b = [...document.querySelectorAll(".fx-menu button")].find((b) => b.textContent === ${JSON.stringify(label)}); b?.click(); return !!b; })()`;
const picture = async (name) => writeFileSync(new URL(name, import.meta.url), Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"));

let dock = await frame(a, ".dock");
if (!dock) { out.stopped = "no dock: is fenesh the shell?"; await finish(1); }

// What the administrator pinned, before anything runs.
out.atFirst = await dock.js(entries);
await picture("pins-idle.png");

// A press on it starts it, and the program is drawn in the pin's place.
await dock.js(`document.querySelector("#pinned-dev\\\\.peios\\\\.gexora button").click()`);
await sleep(4000);
out.afterPressingThePin = await dock.js(entries);

// Another program, which is not pinned, comes after the pins.
await launch(a.send);
await sleep(3000);
out.withHelloRunning = await dock.js(entries);
const hello = out.withHelloRunning.find((entry) => entry.title === "Hello")?.id;

// Its menu pins it. The menu is the desktop's, and wider than the dock.
out.askedForItsMenu = await dock.js(menuOn(hello));
await sleep(400);
out.itsMenu = await a.js(menu);
const dockWidth = await dock.js(`innerWidth`);
out.widerThanTheDock = out.itsMenu ? out.itsMenu.left + 100 > dockWidth : null;
await picture("pins-menu.png");
out.chosePin = await a.js(choose("Pin to the dock"));
await sleep(800);
out.afterPinningHello = await dock.js(entries);
// A pin that could not be kept is said, with why.
out.refused = await dock.js(`document.getElementById("refused")?.title ?? null`);

// The menu of a pin unpins it, and what is running goes on running.
await dock.js(menuOn("pinned-dev.peios.gexora"));
await sleep(400);
out.thePinsMenu = await a.js(menu);
await a.js(choose("Unpin from the dock"));
await sleep(800);
out.afterUnpinningGexora = await dock.js(entries);

// The launcher's entries pin as well, started or not.
await a.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 2 });
await a.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 2 });
await sleep(800);
const launcher = await frame(a, ".launcher");
out.theLaunchersEntries = await launcher?.js(`[...document.querySelectorAll(".launcher > ul > li")].map((li) => ({ app: li.getAttribute("fx-value-app"), menu: li.getAttribute("fx-menu") }))`);
await launcher?.js(`(() => {
    const at = document.querySelector('.launcher li[fx-value-app="dev.peios.gexora"]');
    const r = at.getBoundingClientRect();
    at.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + r.height / 2, button: 2 }));
})()`);
await sleep(400);
out.theLaunchersMenu = await a.js(menu);
out.theLauncherStillInSight = await a.js(`[...document.querySelectorAll('.fx-surface[data-role="overlay"]')].some((s) => !s.hidden)`);
out.choseInTheLauncher = await a.js(choose("Pin to the dock"));
await sleep(800);
out.afterPinningFromTheLauncher = await dock.js(entries);
out.theLaunchersEntriesAfter = await launcher?.js(`[...document.querySelectorAll(".launcher > ul > li")].map((li) => ({ app: li.getAttribute("fx-value-app"), menu: li.getAttribute("fx-menu") }))`);
await picture("pins.png");
out.dockErrors = dock.log;

// The next session: nothing running, and what was pinned is pinned.
await a.js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
await sleep(2500);
await a.send("Page.navigate", { url: "https://127.0.0.1:7780/" });
await logOn();
dock = await frame(a, ".dock");
out.theNextSession = dock ? await dock.js(entries) : "no dock";
await picture("pins-next-session.png");
await finish(0);
