// A context menu, in headless Chromium: named in an app's HTML with fx-menu,
// drawn by the desktop's page over every frame, and answered with an
// ordinary event to the app's process. What matters is that the menu is in
// the desktop's document and not the frame's; that it opens where it was
// asked for and stays inside the viewport; that a chosen item reaches the
// process with the right name; that a disabled item cannot be chosen; and
// that Escape and a press elsewhere take it away.
//
// The test app has a menu on its count (../../libgxwi/examples/hello).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

const port = 9352;
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
const a = await page("http://127.0.0.1:7780/");
await sleep(1500);
await a.js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);
await a.js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
await sleep(4000);

const out = {};
const finish = async (code) => {
    out.desktopErrors = a.log;
    await a.js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
    await sleep(1500);
    console.log(JSON.stringify(out, null, 1));
    chrome.kill();
    process.exit(code);
};

await launch(a.send);
await sleep(3000);
const fa = await frame(a, "[fx-menu]");
if (!fa) { out.stopped = "no frame with a menu in it"; await finish(1); }

/** What the desktop's page shows of the menu. */
const shown = `(() => {
    const menu = document.querySelector(".fx-menu");
    if (!menu) return null;
    const r = menu.getBoundingClientRect();
    return {
        items: [...menu.querySelectorAll("li")].map((li) => li.getAttribute("role") === "separator" ? "—" : (li.firstElementChild.disabled ? "(" : "") + li.firstElementChild.textContent + (li.firstElementChild.disabled ? ")" : "")),
        box: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        hasKeyboard: menu.contains(document.activeElement),
    };
})()`;
/** A secondary press at x, y of the frame, on whatever is there. */
const press = (x, y) => `(() => {
    const at = document.elementFromPoint(${x}, ${y}) ?? document.body;
    at.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 2 }));
    return at.closest("[fx-menu]") ? "on the menu's element" : "elsewhere: " + at.tagName;
})()`;
const count = () => fa.js(`document.getElementById("count").textContent`);
const key = async (key, code) => {
    // A key that presses a button has to be a whole key, text and all.
    const vk = { Escape: 27, Enter: 13, ArrowDown: 40 }[key];
    await a.send("Input.dispatchKeyEvent", { type: key === "Enter" ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, ...(key === "Enter" ? { text: "\r" } : {}) });
    await a.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
};
const where = async () => await fa.js(`(() => { const r = document.querySelector("[fx-menu]").getBoundingClientRect(); return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }; })()`);

// Nothing at first, and not in the frame either.
out.beforeAnything = { desktop: await a.js(shown), frameDraws: await fa.js(`!!document.querySelector(".fx-menu")`), count: await count() };

// Opened on the count, with the count at nought, "Start the count again"
// cannot be chosen.
let at = await where();
out.pressedOn = await fa.js(press(at.x, at.y));
await sleep(400);
out.atNought = await a.js(shown);
out.stillInTheFrame = await fa.js(`!!document.querySelector(".fx-menu")`);

// Escape takes it away.
await key("Escape", "Escape");
await sleep(300);
out.afterEscape = await a.js(shown);

// Two presses from the menu: the item reaches the process as its own event.
for (let i = 0; i < 2; i++) {
    await fa.js(press(at.x, at.y));
    await sleep(400);
    await a.js(`[...document.querySelectorAll(".fx-menu button")].find((b) => b.textContent === "Press").click()`);
    await sleep(400);
}
out.afterTwoFromTheMenu = { count: await count(), menu: await a.js(shown) };

// The keyboard: down twice lands on the second item, Enter chooses it.
await fa.js(press(at.x, at.y));
await sleep(400);
out.withTwo = await a.js(shown);
await key("ArrowDown", "ArrowDown");
await key("ArrowDown", "ArrowDown");
out.onTheSecond = await a.js(`document.activeElement.textContent`);
await key("Enter", "Enter");
await sleep(400);
out.afterStartingAgain = { count: await count(), menu: await a.js(shown), keyboardBackInTheFrame: await a.js(`document.activeElement instanceof HTMLIFrameElement`) };

// A press elsewhere in the frame takes it away, and the frame says so.
await fa.js(press(at.x, at.y));
await sleep(400);
await fa.js(`document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }))`);
await sleep(300);
out.afterAPressElsewhere = await a.js(shown);

// Asked for from the keyboard, the event's point is nowhere near the
// element, and the menu goes under the element's bottom left.
const element = await fa.js(`(() => { const r = document.querySelector("[fx-menu]").getBoundingClientRect(); return { left: Math.round(r.left), bottom: Math.round(r.bottom) }; })()`);
await fa.js(`document.querySelector("[fx-menu]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0 }))`);
await sleep(400);
const frameBox = await a.js(`(() => { const r = [...document.querySelectorAll("iframe")].at(-1).getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top) }; })()`);
const fromTheKeyboard = await a.js(shown);
out.fromTheKeyboard = { ...fromTheKeyboard, underTheElement: fromTheKeyboard && fromTheKeyboard.box.left === frameBox.left + element.left && fromTheKeyboard.box.top === frameBox.top + element.bottom };
await key("Escape", "Escape");

// Nowhere else does a secondary press do anything of ours.
out.pressedOnNothing = await fa.js(press(5, 5));
await sleep(300);
out.afterThat = await a.js(shown);

// For the picture: open, with the keyboard on the first item.
await fa.js(press(at.x, at.y));
await sleep(400);
await key("ArrowDown", "ArrowDown");
await sleep(200);
writeFileSync(new URL("menu.png", import.meta.url), Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"));
out.frameErrors = fa.log;
await finish(0);
