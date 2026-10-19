// Workspaces, in headless Chromium. What matters is the split: which
// workspace a window is on is the session's, so every device agrees and the
// process says so in the surfaces; which workspace a device is showing is the
// device's, so two devices can look at different ones. And that the shell's
// pills in the top bar show the workspaces, mark this device's, and switch
// on a click; that the keys switch and take the focused window along; that
// a new window goes where the person last went; and that a dock icon for a
// window on another workspace goes there.
//
// Requires the matching application artifacts staged from GXWI Essentials.
// have made it the shell.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

const port = 9350;
const chrome = spawn(
    "chromium",
    [
        "--headless",
        "--ignore-certificate-errors",
        "--disable-gpu",
        "--hide-scrollbars",
        "--blink-settings=preferredColorScheme=0",
        "--window-size=1200,800",
        `--remote-debugging-port=${port}`,
        "about:blank",
    ],
    { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = (path, method = "GET") =>
    fetch(`http://127.0.0.1:${port}${path}`, { method }).then((r) => r.json());

async function attach(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let next = 1;
    const waiting = new Map();
    const log = [];
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id) {
            waiting.get(msg.id)?.(msg);
        } else if (msg.method === "Log.entryAdded") {
            log.push(msg.params.entry.text);
        } else if (msg.method === "Runtime.consoleAPICalled") {
            log.push(msg.params.args.map((a) => a.value).join(" "));
        } else if (msg.method === "Runtime.exceptionThrown") {
            log.push(
                msg.params.exceptionDetails.exception?.description ??
                    msg.params.exceptionDetails.text,
            );
        }
    };
    const send = (method, params = {}) =>
        new Promise((r) => {
            const id = next++;
            waiting.set(id, r);
            ws.send(JSON.stringify({ id, method, params }));
        });
    await send("Log.enable");
    await send("Runtime.enable");
    const js = async (expression) =>
        (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
            .result.result?.value;
    return { id: target.id, send, js, log };
}
const page = async (url) => attach(await browser(`/json/new?${url}`, "PUT"));
/** The frame of `parent` with something matching `has` in it. */
async function frame(parent, has) {
    const all = await Promise.all(
        (await browser("/json"))
            .filter((t) => t.type === "iframe" && t.parentId === parent.id)
            .map(attach),
    );
    for (const one of all) {
        if (await one.js(`!!document.querySelector(${JSON.stringify(has)})`)) return one;
    }
    return null;
}
async function logon(p) {
    await sleep(1500);
    await p.js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
    await sleep(2000);
    await p.js(
        `document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`,
    );
    await sleep(4000);
}

for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
        await browser("/json");
        break;
    } catch {}
}
const a = await page("https://127.0.0.1:7780/");
await logon(a);

const out = {};
const finish = async (code) => {
    out.desktopLog = a.log;
    await a.js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
    await sleep(1000);
    console.log(JSON.stringify(out, null, 1));
    chrome.kill();
    process.exit(code);
};
/** What a device shows: the windows in sight, the focus. */
const desk = `(() => ({
    inSight: [...document.querySelectorAll(".fx-surface[data-role=window]")].filter((s) => !s.hidden).map((s) => Number(s.dataset.id)),
    focused: Number(document.querySelector('.fx-surface[data-focused="true"]')?.dataset.id ?? 0),
}))()`;
/** The session's windows and their workspaces, as the process tells a page. */
const windows = `new Promise((done) => { const s = new WebSocket("ws://" + location.host + "/.fenestra/desktop"); s.onmessage = (m) => { s.close(); done(JSON.parse(m.data).surfaces.filter((x) => x.role === "window").map((x) => x.id + "@" + x.workspace)); }; })`;
/** The pills in a top bar, with this device's marked. */
const pills = `[...document.querySelectorAll(".spaces button")].map((b) => b.textContent + (b.dataset.fxCurrent === "true" ? "*" : "") + (b.classList.contains("empty") ? " (empty)" : ""))`;
const HELD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
async function press(on, chord) {
    const parts = chord.split("+");
    const key = parts.pop();
    const modifiers = parts.reduce((sum, part) => sum + HELD[part], 0);
    const letter = /^[A-Z]$/.test(key);
    const params = {
        modifiers,
        key: letter ? key.toLowerCase() : key,
        code: letter ? `Key${key}` : key,
        windowsVirtualKeyCode: letter
            ? key.charCodeAt(0)
            : ({ ArrowLeft: 37, ArrowRight: 39 }[key] ?? 0),
    };
    await on.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
    await on.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    await sleep(500);
}
/** Clicks something in a frame for real, by where it is on the desktop's page. */
async function click(on, frameElement, target, selector) {
    const at = await on.js(
        `(() => { const r = document.querySelector(${JSON.stringify(frameElement)}).getBoundingClientRect(); return [r.left, r.top]; })()`,
    );
    const inside = await target.js(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`,
    );
    if (!at || !inside) {
        out.notFound = { frameElement, selector };
        await finish(1);
    }
    const point = { x: at[0] + inside[0], y: at[1] + inside[1], button: "left", clickCount: 1 };
    await on.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
    await on.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
    await sleep(600);
}
const TOP = ".fx-surface[data-role=panel][data-edge=top] iframe";
const DOCK = ".fx-surface[data-role=panel][data-edge=left] iframe";

const top = await frame(a, ".spaces");
if (!top) {
    out.stopped = "no top bar with workspaces to attach to";
    await finish(1);
}
const state = async (device = a, bar = top) => ({
    desk: await device.js(desk),
    windows: await device.js(windows),
    pills: await bar.js(pills),
});
out.atFirst = await state();

// A window, then on to workspace 2 by key: it is out of sight, and a window
// opened now goes to 2, since that is where the person last went.
await launch(a.send);
await sleep(3000);
out.withAWindow = await state();
await press(a, "Ctrl+Alt+ArrowRight");
out.onTwo = await state();
// Back and forth by the letters as well: J back, K onward.
await press(a, "Ctrl+Alt+J");
out.backByJ = (await state()).pills;
await press(a, "Ctrl+Alt+K");
out.onAgainByK = (await state()).pills;
await launch(a.send);
await sleep(3000);
out.withAWindowOnTwo = await state();
writeFileSync(
    new URL("workspaces.png", import.meta.url),
    Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"),
);

// Taken along to 1 by key: the process says so, and both are in sight there.
await press(a, "Ctrl+Alt+Shift+ArrowLeft");
await sleep(500);
out.afterTakingItToOne = await state();

// Another device starts on 1 and sees both; it goes to the empty 2 by its
// pill while this one stays on 1.
const b = await page("https://127.0.0.1:7780/");
await sleep(5000);
const topB = await frame(b, ".spaces");
out.anotherDevice = await state(b, topB);
await click(b, TOP, topB, "#space-2");
out.anotherDeviceOnTwo = { b: await state(b, topB), aStillOn: (await state()).pills };

// A window opened now goes to 2, where the person last went, on whichever
// device: the other device is gone, this one shows 1, and the window still
// lands on 2, out of sight here. (Keys sent to a page while another is open
// in the same browser do not arrive, so the other is closed first.)
await browser(`/json/close/${b.id}`).catch(() => {});
await sleep(500);
await launch(a.send);
await sleep(3000);
out.aWindowOpenedNow = await state();

// The dock icon for that window, pressed here: this device goes to 2.
const dock = await frame(a, "nav.dock");
const third = Number(out.aWindowOpenedNow.windows.find((w) => w.endsWith("@2"))?.split("@")[0]);
await click(a, DOCK, dock, `[fx-focus="${third}"]`);
out.afterPressingItsDockIcon = await state();

// Back to 1 by its pill, and Alt+K on a workspace with two moves the focus among them only.
await click(a, TOP, top, "#space-1");
out.backOnOneByPill = await state();
await press(a, "Alt+K");
out.afterAltK = (await state()).desk;
out.topBarLog = top.log;
await finish(0);
