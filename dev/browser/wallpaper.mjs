// fenesh's background, in headless Chromium: a surface under everything with
// the wallpaper on it. What matters is that a surface can ask to be the
// background and is laid under the panels and the windows, the whole
// viewport; that the image the shell serves is drawn; that a press on it
// sends an overlay away and moves no focus; and that it never has the
// focus or a strip.
//
// Requires the matching application artifacts staged from GXWI Essentials.
// to have made it the shell.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

const port = 9347;
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
/** The background on the desktop's page, and what is on top at a few points. */
const desk = `(() => {
    const b = document.querySelector(".fx-surface[data-role=background]");
    const r = b?.getBoundingClientRect();
    const path = (e) => { const out = []; for (; e && e !== document.body; e = e.parentElement) out.push(e.tagName.toLowerCase() + (e.dataset.role ? "[" + e.dataset.role + "]" : "")); return out.join(" < "); };
    return {
        background: b ? { left: r.left, top: r.top, width: r.width, height: r.height, zIndex: getComputedStyle(b).zIndex, strip: !!b.querySelector(".fx-strip"), border: getComputedStyle(b).borderWidth, hidden: b.hidden } : null,
        viewport: [innerWidth, innerHeight],
        onTopAt: { gapBetweenPanelAndWindow: path(document.elementFromPoint(60, 44)), middle: path(document.elementFromPoint(600, 400)), topBar: path(document.elementFromPoint(600, 20)) },
        focused: Number(document.querySelector('.fx-surface[data-focused="true"]')?.dataset.id ?? 0),
        overlayInSight: Number(document.querySelector(".fx-surface[data-role=overlay]:not([hidden])")?.dataset.id ?? 0),
    };
})()`;
/** Whether the wallpaper was fetched and drawn, from inside its frame. */
const drawn = `(async () => {
    const el = document.querySelector(".wallpaper");
    const url = getComputedStyle(el).backgroundImage;
    const response = await fetch("../../wallpaper");
    return { url, status: response.status, type: response.headers.get("content-type"), bytes: (await response.arrayBuffer()).byteLength, size: getComputedStyle(el).backgroundSize };
})()`;

const background = await frame(a, ".wallpaper");
if (!background) {
    out.stopped = "no background to attach to";
    out.desk = await a.js(desk);
    await finish(1);
}
out.empty = await a.js(desk);
out.image = await background.js(drawn);
writeFileSync(
    new URL("wallpaper-empty.png", import.meta.url),
    Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"),
);

// With a window: the window is over the background, the gap shows it.
await launch(a.send);
await sleep(3000);
out.withAWindow = await a.js(desk);
writeFileSync(
    new URL("wallpaper.png", import.meta.url),
    Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"),
);

// The launcher in sight, then a press on the background for real: the
// launcher goes, the window keeps the focus.
await a.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    modifiers: 2,
});
await a.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    modifiers: 2,
});
await sleep(600);
out.launcherSentFor = (await a.js(desk)).overlayInSight;
const point = { x: 60, y: 44, button: "left", clickCount: 1 };
await a.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
await sleep(600);
out.afterPressingTheBackground = {
    overlayInSight: (await a.js(desk)).overlayInSight,
    focused: (await a.js(desk)).focused,
    was: out.withAWindow.focused,
};
out.backgroundLog = background.log;
await finish(0);
