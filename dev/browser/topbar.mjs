// fenesh's top bar, in headless Chromium: a panel along the top with the
// clock and the power button. What matters is that a panel can ask for the
// top edge and get it, with the windows between it and the taskbar; that the
// clock is the process's and reads the right minute; that a button on a panel
// can send for an overlay of the same app's; and that the power menu does
// what it says: a shutdown alice may not ask for is refused in the manager's
// words, and logging off ends the session and leaves the browser at the
// logon page.
//
// Requires the matching application artifacts staged from GXWI Essentials.
// have made it the shell.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const port = 9344;
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
    console.log(JSON.stringify(out, null, 1));
    chrome.kill();
    process.exit(code);
};
/** Where the panels and the windows lie on the desktop's page. */
const desk = `(() => {
    const rect = (s) => { const r = s.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, width: r.width }; };
    const panels = [...document.querySelectorAll(".fx-surface[data-role=panel]")].map((s) => ({ edge: s.dataset.edge ?? null, ...rect(s), border: getComputedStyle(s).borderWidth }));
    const windows = [...document.querySelectorAll(".fx-surface[data-role=window]")].filter((s) => !s.hidden).map(rect);
    const overlay = document.querySelector(".fx-surface[data-role=overlay]:not([hidden])");
    return { panels, windows, viewport: [innerWidth, innerHeight], overlayInSight: overlay ? Number(overlay.dataset.id) : null,
        keyboardIn: Number(document.activeElement?.closest?.(".fx-surface")?.dataset.id ?? 0), status: document.querySelector("#status")?.textContent ?? null };
})()`;
/** The session's surfaces, as a page is told them. */
const surfaces = `new Promise((done) => { const s = new WebSocket("ws://" + location.host + "/.fenestra/desktop"); s.onmessage = (m) => { s.close(); done(JSON.parse(m.data).surfaces.map((x) => ({ id: x.id, title: x.title, role: x.role, edge: x.edge ?? null, shell: x.shell }))); }; })`;
/** What the top bar shows. */
const bar = `({
    clock: document.querySelector(".clock")?.textContent ?? null,
    datetime: document.querySelector(".clock")?.getAttribute("datetime") ?? null,
    power: document.querySelector(".power") ? { sendsFor: Number(document.querySelector(".power").getAttribute("fx-surface")), how: document.querySelector(".power").getAttribute("fx-overlay"), menuInSight: document.querySelector(".power").dataset.fxVisible ?? null } : null,
})`;
/** What the power menu shows. */
const menu = `({ buttons: [...document.querySelectorAll("li button")].map((b) => b.textContent), said: document.querySelector(".said")?.textContent ?? null, refused: !!document.querySelector(".said.refused"), focused: document.activeElement?.id ?? null })`;
/** Clicks something in a frame for real, by where it is on the desktop's page. */
async function click(frameElement, target, selector) {
    const at = await a.js(
        `(() => { const r = document.querySelector(${JSON.stringify(frameElement)}).getBoundingClientRect(); return [r.left, r.top]; })()`,
    );
    const inside = await target.js(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
    );
    const point = { x: at[0] + inside[0], y: at[1] + inside[1], button: "left", clickCount: 1 };
    await a.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
    await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
    await sleep(600);
}

const top = await frame(a, ".topbar");
if (!top) {
    out.stopped = "no top bar to attach to";
    out.desk = await a.js(desk);
    await finish(1);
}
out.surfaces = await a.js(surfaces);
out.desk = await a.js(desk);
out.bar = await top.js(bar);
// The minute the bar shows against this machine's, allowing for the one
// turning over between the two readings.
const now = new Date();
const minutes = (iso) => Math.floor(Date.parse(iso) / 60000);
out.clockIsNow = Math.abs(minutes(out.bar.datetime) - Math.floor(now.getTime() / 60000)) <= 1;
out.powerMenuIs = out.surfaces.find((s) => s.title === "Power" && s.role === "overlay")?.id ?? null;

// The power button, pressed for real: the menu comes into sight with the
// keyboard on "Log off", and Escape sends it away.
await click(".fx-surface[data-role=panel][data-edge=top] iframe", top, ".power");
const power = await frame(a, ".power-menu");
out.afterPressingPower = {
    desk: await a.js(desk),
    bar: await top.js(bar),
    menu: power ? await power.js(menu) : "no menu",
};
writeFileSync(
    new URL("topbar.png", import.meta.url),
    Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"),
);
await a.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
});
await a.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
});
await sleep(500);
out.afterEscape = { overlayInSight: (await a.js(desk)).overlayInSight, bar: await top.js(bar) };

// Shutting down, which alice may not: the manager's refusal, and the
// session carries on.
await click(".fx-surface[data-role=panel][data-edge=top] iframe", top, ".power");
await power?.js(`document.querySelector("#shut-down").click()`);
await sleep(1500);
out.afterAskingToShutDown = {
    menu: power ? await power.js(menu) : "no menu",
    stillHere: (await a.js(desk)).panels.length,
};

// Logging off: the session ends and the browser is back at the logon page.
await power?.js(`document.querySelector("#log-off").click()`);
await sleep(3000);
out.afterLoggingOff = {
    atLogon: await a.js(`!!document.querySelector("#username")`),
    url: await a.js(`location.pathname`),
};
out.topBarLog = top.log;
out.menuLog = power?.log ?? [];
await finish(0);
