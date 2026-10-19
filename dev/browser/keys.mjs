// Keys, in headless Chromium. The desktop's page cannot hear a key pressed in
// a surface's page, so the chords that are the desktop's are claimed
// beforehand and passed up from wherever they are pressed. What matters is
// that a claimed chord does the same thing wherever the keyboard is, that an
// app's own keys work and typing is left alone, and that a page which cannot
// pass keys on is marked.
import { spawn } from "node:child_process";
import { launch } from "./launch.mjs";

const port = 9340;
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
    return { id: target.id, url: target.url, send, js, log };
}
const page = async (url) => attach(await browser(`/json/new?${url}`, "PUT"));
/** The frames of `parent` that show the hello app's live surface. */
async function hellos(parent) {
    const all = await Promise.all(
        (await browser("/json"))
            .filter((t) => t.type === "iframe" && t.parentId === parent.id)
            .map(attach),
    );
    const found = [];
    for (const frame of all) {
        if (await frame.js(`!!document.querySelector("[fx-click=press]")`)) found.push(frame);
    }
    return found;
}

for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
        await browser("/json");
        break;
    } catch {}
}
const a = await page("https://127.0.0.1:7780/");
await sleep(1500);
await a.js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);
await a.js(
    `document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`,
);
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
const HELD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
/** A key pressed for real, which goes wherever the keyboard is. `chord` is as "Alt+J"; `text` is what it types, if anything. */
async function press(chord, text) {
    const parts = chord.split("+");
    const key = parts.pop();
    const modifiers = parts.reduce((sum, part) => sum + HELD[part], 0);
    const letter = /^[A-Z0-9]$/.test(key);
    const params = {
        modifiers,
        key: letter ? key.toLowerCase() : key,
        code: letter ? (/[0-9]/.test(key) ? `Digit${key}` : `Key${key}`) : key,
        windowsVirtualKeyCode: letter ? key.charCodeAt(0) : ({ Enter: 13, Escape: 27 }[key] ?? 0),
    };
    await a.send("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        ...params,
        ...(text ? { text } : {}),
    });
    await a.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    await sleep(500);
}
/** Which surface has the focus, and which has the keyboard (0 for the desktop's own page). */
const where = () =>
    a.js(`({
    focused: Number(document.querySelector('.fx-surface[data-focused="true"]')?.dataset.id ?? 0),
    keyboardIn: Number(document.activeElement?.closest?.(".fx-surface")?.dataset.id ?? 0),
})`);
const shows = `({ count: document.getElementById("count").textContent, note: document.querySelector("[name=note]").value })`;

// Two apps from the launcher. Each has the focus as it opens, and the keyboard with it.
for (let i = 0; i < 2; i++) {
    await launch(a.send);
    await sleep(2500);
}
out.atFirst = await where();

// The window manager's chord, with the keyboard in the desktop's own page,
// which the first window is drawn by.
await press("Alt+1");
await press("Alt+K");
out.nextFromTheDesktop = await where();
// The shell's: the taskbar's third button, which is clicked though nobody is near it.
await press("Alt+3");
out.theThirdWindowByItsNumber = await where();
// And the window manager's again with the keyboard in an app's page, which
// the desktop cannot hear.
await press("Alt+J");
out.previousFromInsideAnApp = await where();

// An app's own keys, in whichever app has the keyboard now.
const apps = await hellos(a);
const both = async () => Promise.all(apps.map((app) => app.js(shows)));
const withKeyboard = [];
for (const app of apps) if (await app.js(`document.hasFocus()`)) withKeyboard.push(app);
out.appsWithTheKeyboard = withKeyboard.length;
const app = withKeyboard[0] ?? apps[0];
await press("P", "p");
out.aLetterOutsideAField = await both();
await app.js(`document.querySelector("[name=note]").focus()`);
await press("P", "p");
await sleep(400);
out.theSameLetterInAField = await both();
await press("Ctrl+Enter");
out.ctrlEnterInTheField = await both();
await press("Escape");
await sleep(400);
out.escapeInTheField = await both();
// A claimed chord is the desktop's even here, and types nothing.
await press("Alt+K", "k");
out.previousFromInsideAField = { ...(await where()), apps: await both() };

// A page of the app's own, with the keyboard put in it by a real press.
await press("Alt+1");
out.backOnTheDesktop = await where();
await launch(a.send, "hello --raw");
await sleep(4000);
out.theRawPageAsItOpened = await where();
await press("Alt+1");
const raw = await a.js(
    `(() => { const s = [...document.querySelectorAll(".fx-surface[data-role=window]")].at(-1); const r = s.querySelector("iframe").getBoundingClientRect(); return { id: Number(s.dataset.id), x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
);
const at = { x: raw.x, y: raw.y, button: "left", clickCount: 1 };
await a.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
await sleep(100);
out.aPressInARawPage = { raw: raw.id, within100ms: await where() };
await press("Alt+J");
out.nextFromInsideARawPage = await where();
const deaf = `[...document.querySelectorAll('.fx-surface[data-deaf="true"]')].map((s) => Number(s.dataset.id))`;
out.deafBefore = await a.js(deaf);

// The raw page goes somewhere that does not include the desktop's script.
const rawFrame = (
    await Promise.all(
        (await browser("/json"))
            .filter((t) => t.type === "iframe" && t.parentId === a.id && t.url.endsWith("/raw/"))
            .map(attach),
    )
)[0];
await rawFrame?.js(`location.href = "ping"`);
await sleep(4500);
out.deafAfterItWentElsewhere = {
    deaf: await a.js(deaf),
    says: await a.js(
        `getComputedStyle(document.querySelector('.fx-surface[data-deaf="true"] .fx-identity'), "::after").content`,
    ),
};

// An app that is no part of the shell asks for a chord of its own.
await apps[0].js(`parent.postMessage({ fx: "keys", chords: ["Alt+X"] }, "*")`);
await sleep(300);
out.appLog = [...new Set(apps.flatMap((app) => app.log))];
await finish(0);
