// Gexora, in headless Chromium: a file explorer, and the first app to draw
// icons for a directory full of things. What matters is that every entry
// gets an icon the browser can draw, that the icon rules give the expected
// names (a program by its section, a directory by its type, a named
// directory by its name), that going into a directory and back works by
// mouse and by keyboard, and that opening a program starts it.
//
// The dev VM declares Gexora and the test app in the catalogue and puts them
// in /usr/bin, so "gexora" starts it at alice's home and /bin, the view over
// /usr/bin, is where the programs are.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

const port = 9343;
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
/** The frame of `parent` that is Gexora's window. */
async function explorer(parent) {
    const all = await Promise.all((await browser("/json")).filter((t) => t.type === "iframe" && t.parentId === parent.id).map(attach));
    for (const frame of all) if (await frame.js(`!!document.querySelector("form.bar input[name=path]")`)) return frame;
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
    out.desktopLog = a.log;
    await a.js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
    await sleep(1000);
    console.log(JSON.stringify(out, null, 1));
    chrome.kill();
    process.exit(code);
};
/** What the explorer shows: the path, and each entry with its icon and whether the browser drew it. */
const shows = `({
    path: document.querySelector("input[name=path]").value,
    picked: document.querySelector('[aria-selected="true"] span')?.textContent ?? null,
    entries: [...document.querySelectorAll(".entries button")].map((b) => b.querySelector(".name").textContent + " [" + b.querySelector("img").getAttribute("src").split("/").pop() + (b.querySelector("img").naturalWidth > 0 ? "]" : " MISSING]")),
    trouble: document.querySelector(".trouble")?.textContent ?? null,
    more: document.querySelector(".more")?.textContent ?? null,
    status: document.querySelector(".status")?.textContent ?? null,
    details: document.querySelector(".details") ? [...document.querySelectorAll(".details dt, .details dd")].map((e) => e.textContent).join(" | ") : null,
    sortedBy: document.querySelector(".head [aria-sort]")?.textContent + " " + document.querySelector(".head [aria-sort]")?.getAttribute("aria-sort"),
    places: [...document.querySelectorAll(".sidebar ul:not(.volumes) button")].map((b) => b.textContent + (b.getAttribute("aria-current") === "true" ? " CURRENT" : "")),
    volumes: [...document.querySelectorAll(".volumes button")].map((b) => b.textContent),
})`;
const windows = () => a.js(`[...document.querySelectorAll(".fx-surface[data-role=window]")].map((s) => s.querySelector(".fx-title")?.textContent)`);
const HELD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
/** A key pressed for real, wherever the keyboard is. */
async function press(chord, text) {
    const parts = chord.split("+");
    const key = parts.pop();
    const modifiers = parts.reduce((sum, part) => sum + HELD[part], 0);
    const letter = /^[A-Z0-9]$/.test(key);
    const params = { modifiers, key: letter ? key.toLowerCase() : key, code: letter ? `Key${key}` : key, windowsVirtualKeyCode: letter ? key.charCodeAt(0) : { Enter: 13, Backspace: 8, ArrowUp: 38, ArrowDown: 40, F5: 116 }[key] ?? 0 };
    // Enter types a character too, which is what a form is sent on.
    if (key === "Enter" && !modifiers) text = "\r";
    await a.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...params, ...(text ? { text } : {}) });
    await a.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    await sleep(400);
}
/** Types into the address bar for real and presses Enter there. */
async function typePath(frame, path) {
    await frame.js(`(() => { const i = document.querySelector("input[name=path]"); i.focus(); i.select(); })()`);
    for (const c of path) await press(c === "/" ? "Slash" : c.toUpperCase(), c);
    await sleep(600);
    await press("Enter");
    await sleep(800);
}

await launch(a.send, "gexora");
await sleep(3500);
const ex = await explorer(a);
if (!ex) { out.stopped = "no explorer window to attach to"; out.windows = await windows(); await finish(1); }
out.atHome = await ex.js(shows);
out.windowsAtFirst = await windows();

// /bin, typed into the address bar: programs by their sections, the rest by
// their type. Gexora and the hello app are the two that carry a name.
await typePath(ex, "/bin");
out.inBin = await ex.js(shows);
out.inBinNamed = out.inBin.entries.filter((e) => /gexora|hello/.test(e));
out.inBinIcons = [...new Set(out.inBin.entries.map((e) => e.replace(/^.*\[/, "[")))];

// The columns: a click on an entry picks it and fills the details; a click
// on a heading sorts, and again the other way, with the pick following.
await ex.js(`[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === "gexora").click()`);
await sleep(600);
out.pickedGexora = await ex.js(shows);
out.pickedGexoraRow = await ex.js(`(() => { const b = document.querySelector('[aria-selected="true"]'); return [".modified", ".kind", ".size"].map((c) => b.querySelector(c).textContent); })()`);
await ex.js(`document.querySelector('.head [fx-value-by="size"]').click()`);
await sleep(600);
out.sortedBySize = { first: (await ex.js(shows)).entries[0], sortedBy: (await ex.js(shows)).sortedBy, picked: (await ex.js(shows)).picked };
await ex.js(`document.querySelector('.head [fx-value-by="size"]').click()`);
await sleep(600);
out.sortedBySizeAgain = { first: (await ex.js(shows)).entries[0], sortedBy: (await ex.js(shows)).sortedBy, picked: (await ex.js(shows)).picked };
await ex.js(`document.querySelector('.head [fx-value-by="name"]').click()`);
await sleep(600);

// The root, by the up button, and home again by the keyboard.
await ex.js(`document.querySelector('[fx-click="up"]').click()`);
await sleep(800);
out.afterUp = await ex.js(shows);
out.rootHasNamedDirectories = out.afterUp.entries.filter((e) => /home|usr|tmp/.test(e));

// Into a directory by keyboard: Down until "home" is picked, then Enter.
await ex.js(`document.querySelector(".entries button").focus()`);
for (let i = 0; i < 40; i++) {
    const picked = (await ex.js(shows)).picked;
    if (picked === "home") break;
    await press("ArrowDown");
}
await press("Enter");
await sleep(800);
out.afterEnterOnHome = await ex.js(shows);

// The edge between Modified and Type, dragged 60px to the right for real:
// Modified grows by what Type shrinks, the edge ends up under the pointer,
// and nothing else moves. The widths are the page's: they survive a render.
const widths = `getComputedStyle(document.querySelector(".head")).gridTemplateColumns.split(" ").map((w) => Math.round(parseFloat(w)))`;
out.columnsBefore = await ex.js(widths);
const edges = `[...document.querySelector(".head").children].map((c) => Math.round(c.getBoundingClientRect().right))`;
out.edgesBefore = await ex.js(edges);
const frame = await a.js(`(() => { const r = [...document.querySelectorAll(".fx-surface iframe")].find((f) => f.closest(".fx-surface").querySelector(".fx-title")?.textContent === "Gexora").getBoundingClientRect(); return [r.left, r.top]; })()`);
const edge = await ex.js(`(() => { const r = document.querySelector(".head .modified").getBoundingClientRect(); return [r.right, r.top + r.height / 2]; })()`);
const at = (x) => ({ x: frame[0] + x, y: frame[1] + edge[1], button: "left", buttons: 1 });
await a.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(edge[0] - 1), buttons: 0 });
out.cursorAtTheEdge = await ex.js(`document.querySelector(".head").style.cursor`);
await a.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at(edge[0] - 1), clickCount: 1 });
for (let x = edge[0]; x <= edge[0] + 60; x += 10) await a.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(x) });
await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at(edge[0] + 60), buttons: 0, clickCount: 1 });
await sleep(300);
out.columnsAfterDragging = await ex.js(widths);
out.edgesAfterDragging = await ex.js(edges);
out.stillSortedBy = (await ex.js(shows)).sortedBy;
await press("F5");
await sleep(800);
out.columnsAfterARender = await ex.js(widths);

// Home again from the sidebar.
await ex.js(`[...document.querySelectorAll(".sidebar button")].find((b) => b.textContent === "Home").click()`);
await sleep(800);
out.homeFromTheSidebar = { path: (await ex.js(shows)).path, places: (await ex.js(shows)).places };

// A directory that is not there says so, and the listing stays.
await typePath(ex, "/nowhere");
out.somewhereMissing = await ex.js(shows);

// Opening a program starts it: a new window.
await typePath(ex, "/bin");
out.helloFound = await ex.js(`!![...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === "gxwi-hello-app")`);
await ex.js(`[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === "gxwi-hello-app")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
await sleep(3000);
out.windowsAfterOpeningHello = await windows();
writeFileSync(new URL("explorer.png", import.meta.url), Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"));
out.explorerLog = ex.log;
await finish(0);
