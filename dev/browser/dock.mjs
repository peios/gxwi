// fenesh's dock, in headless Chromium: a panel along the left with an icon
// for every running program and a dot for each of its windows. What matters
// is that a panel can ask for a side and get it, between the top bar and the
// bottom; that windows are shown by program, not one by one; that the icon
// and the dots move the focus on this device and are marked with it; and
// that the button at the bottom sends for the launcher.
//
// Only fenesh has a dock, so this needs ../../../fenesh/dev/push.sh to have
// made it the shell.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

const port = 9346;
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
/** Where things lie on the desktop's page, and which window has the focus. */
const desk = `(() => {
    const rect = (s) => { const r = s.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    return {
        panels: [...document.querySelectorAll(".fx-surface[data-role=panel]")].map((s) => ({ edge: s.dataset.edge ?? null, ...rect(s), border: getComputedStyle(s).borderWidth })),
        windows: [...document.querySelectorAll(".fx-surface[data-role=window]")].filter((s) => !s.hidden).map((s) => ({ id: Number(s.dataset.id), ...rect(s) })),
        focused: Number(document.querySelector('.fx-surface[data-focused="true"]')?.dataset.id ?? 0),
        overlayInSight: Number(document.querySelector(".fx-surface[data-role=overlay]:not([hidden])")?.dataset.id ?? 0),
        keyboardIn: Number(document.activeElement?.closest?.(".fx-surface")?.dataset.id ?? 0),
        viewport: [innerWidth, innerHeight],
    };
})()`;
/** What the dock shows: each program, its icon, its windows, and what the page marks. */
const shows = `({
    programs: [...document.querySelectorAll(".dock > ul > li")].map((li) => ({
        id: li.id,
        icon: li.querySelector("img").getAttribute("src").split("/").pop() + (li.querySelector("img").naturalWidth > 0 ? "" : " MISSING"),
        // The first of the windows its icon goes through, and 0 for a pin that is not running.
        goesTo: Number((li.querySelector("button").getAttribute("fx-focus") ?? "").split(" ")[0]),
        key: li.querySelector("button").getAttribute("fx-global-key"),
        titles: li.querySelector("button").title,
        windows: [...li.querySelectorAll(".windows i")].map((i) => Number(i.getAttribute("fx-surface")) + (i.dataset.fxFocused === "true" ? " FOCUSED" : "") + (i.dataset.fxVisible === "false" ? " (out of sight)" : "")),
        marked: li.matches(':has([data-fx-focused="true"])'),
    })),
    launch: document.querySelector(".launch") ? { sendsFor: Number(document.querySelector(".launch").getAttribute("fx-surface")), how: document.querySelector(".launch").getAttribute("fx-overlay") } : null,
})`;
/** Clicks something in a frame for real, by where it is on the desktop's page. */
async function click(frameElement, target, selector) {
    const at = await a.js(`(() => { const r = document.querySelector(${JSON.stringify(frameElement)}).getBoundingClientRect(); return [r.left, r.top]; })()`);
    const inside = await target.js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const point = { x: at[0] + inside[0], y: at[1] + inside[1], button: "left", clickCount: 1 };
    await a.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
    await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
    await sleep(600);
}
const DOCK = ".fx-surface[data-role=panel][data-edge=left] iframe";

const dock = await frame(a, "nav.dock");
if (!dock) { out.stopped = "no dock to attach to"; out.desk = await a.js(desk); await finish(1); }
out.atFirst = { desk: await a.js(desk), dock: await dock.js(shows) };

// Two windows of the desktop's own (Space, while the keyboard is on the
// desktop's own page), and two programs started from the launcher: three
// programs, the first with two windows. They come after whatever is pinned,
// which the dev VM's settings make Gexora (pins.mjs is about that).
for (let i = 0; i < 2; i++) {
    await a.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await a.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await sleep(800);
}
await launch(a.send);
await sleep(2500);
await launch(a.send);
await sleep(3000);
out.withThreePrograms = { desk: await a.js(desk), dock: await dock.js(shows) };
writeFileSync(new URL("dock.png", import.meta.url), Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"));

// The first program's icon, pressed for real: its first window has the focus.
// Then its second dot: the second window.
// What is running has windows, whether it is drawn in a pin's place or not.
const running = out.withThreePrograms.dock.programs.filter((program) => program.windows.length > 0).sort((x, y) => x.goesTo - y.goesTo);
const first = running[0];
await click(DOCK, dock, `#${first.id} button`);
out.afterPressingTheFirstIcon = { focused: (await a.js(desk)).focused, expected: first.goesTo, dock: (await dock.js(shows)).programs.map((p) => [p.marked, p.windows]) };
await click(DOCK, dock, `#${first.id} .windows i:nth-child(2)`);
out.afterPressingItsSecondDot = { focused: (await a.js(desk)).focused, expected: Number(first.windows[1]), dock: (await dock.js(shows)).programs.map((p) => [p.marked, p.windows]) };

// The second program, by its chord from anywhere: the chords count every
// entry, pinned or running.
const second = out.withThreePrograms.dock.programs.find((program) => program.id === running[1].id);
const digit = second.key.split("+").pop();
await a.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: digit, code: `Digit${digit}`, windowsVirtualKeyCode: 48 + Number(digit), modifiers: 1 });
await a.send("Input.dispatchKeyEvent", { type: "keyUp", key: digit, code: `Digit${digit}`, windowsVirtualKeyCode: 48 + Number(digit), modifiers: 1 });
await sleep(500);
out.afterItsChord = { chord: second.key, focused: (await a.js(desk)).focused, expected: second.goesTo };

// The launcher, from the button at the bottom.
await click(DOCK, dock, ".launch");
out.afterPressingLaunch = { desk: await a.js(desk), launcherIs: out.atFirst.dock.launch?.sendsFor, typingIn: await (await frame(a, "[name=query]"))?.js(`document.activeElement?.name ?? null`) };
await a.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await a.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(500);

// Too narrow to share: the dock stays, one window in sight, and the dots
// say which are out of it.
await a.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(1000);
out.narrow = { desk: await a.js(desk), dock: (await dock.js(shows)).programs.map((p) => p.windows) };
writeFileSync(new URL("dock-narrow.png", import.meta.url), Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"));
await a.send("Emulation.clearDeviceMetricsOverride");
await sleep(1000);

// A window closed is a dot gone, and a program's last window is its icon gone.
const hello = running[2];
await a.js(`document.querySelector('.fx-surface[data-id="${hello.goesTo}"] [data-part=close]').click()`);
await sleep(1500);
out.afterClosingTheThird = (await dock.js(shows)).programs.map((p) => [p.id, p.windows.length]);
out.dockLog = dock.log;
await finish(0);
