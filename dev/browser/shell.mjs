// Fenestra's taskbar, in headless Chromium: a part of the shell, which is an
// app with a panel. What matters is that one process draws it for every
// device while each device's page marks it with its own focus, and that only
// the shell gets to move the focus.
//
// The desktop cannot see into an app's frame and neither can a script in it,
// but the browser's debugger can: a frame kept apart gets a process of its
// own, which shows up as a target to attach to.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

const port = 9339;
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
/** The frames of `parent` that the browser keeps in processes of their own. */
const frames = async (parent) =>
    Promise.all(
        (await browser("/json"))
            .filter((t) => t.type === "iframe" && t.parentId === parent.id)
            .map(attach),
    );
/** The one of them that is the taskbar, and the rest. */
async function sorted(parent) {
    const found = { bar: null, others: [] };
    for (const frame of await frames(parent)) {
        if (await frame.js(`!!document.querySelector("nav[aria-label=Windows]")`)) {
            found.bar = frame;
        } else if (!(await frame.js(`!!document.querySelector("[fx-global-key]")`))) {
            found.others.push(frame);
        }
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
/** What a desktop's page has: the focused surface, those in sight, the panel. */
const desk = `(() => {
    const all = [...document.querySelectorAll(".fx-surface")];
    const panel = document.querySelector(".fx-surface[data-role=panel]");
    const at = panel?.getBoundingClientRect();
    return {
        focused: Number(all.find((s) => s.dataset.focused === "true")?.dataset.id ?? 0),
        inSight: all.filter((s) => !s.hidden && s.dataset.role !== "panel").map((s) => Number(s.dataset.id)),
        panel: panel && { left: at.left, bottom: at.bottom, width: at.width, height: at.height, strip: !!panel.querySelector(".fx-strip") },
        viewport: [innerWidth, innerHeight],
    };
})()`;
/** What a taskbar shows. */
const bar = `[...document.querySelectorAll("button")].map((b) => b.getAttribute("fx-surface") + " " + b.textContent + (b.dataset.fxFocused === "true" ? " FOCUSED" : "") + (b.dataset.fxVisible === "false" ? " (out of sight)" : ""))`;
/** Each button's icon: the name it asks for, and whether the browser got an image for it. */
const icons = `[...document.querySelectorAll("button img")].map((i) => i.getAttribute("src").split("/").pop() + (i.complete && i.naturalWidth > 0 ? " drawn" : " MISSING"))`;
/** Presses a taskbar's button for real, by where it is on the desktop's page. */
async function press(desktop, taskbar, surface) {
    const frame = await desktop.js(
        `(() => { const r = document.querySelector(".fx-surface[data-role=panel] iframe").getBoundingClientRect(); return [r.left, r.top]; })()`,
    );
    const button = await taskbar.js(
        `(() => { const r = document.querySelector('[fx-focus="${surface}"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
    );
    const at = { x: frame[0] + button[0], y: frame[1] + button[1], button: "left", clickCount: 1 };
    await desktop.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await desktop.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
    await sleep(500);
}

const { bar: ta } = await sorted(a);
if (!ta) {
    out.stopped = "no taskbar to attach to";
    out.desk = await a.js(desk);
    await finish(1);
}
out.atFirst = { desk: await a.js(desk), bar: await ta.js(bar) };
out.theBarsPage = await ta.js(`({ scripts: document.scripts.length, origin: self.origin })`);

// Two apps, started from the launcher.
await launch(a.send);
await sleep(2500);
await launch(a.send);
await sleep(3000);
out.withTwoApps = { desk: await a.js(desk), bar: await ta.js(bar), icons: await ta.js(icons) };

// The first window, asked for from the taskbar.
const first = out.withTwoApps.desk.inSight[0];
await ta.js(`window.pressed = document.querySelector('[fx-focus="${first}"]')`);
await press(a, ta, first);
out.afterPressingTheFirst = {
    desk: await a.js(desk),
    bar: await ta.js(bar),
    sameButton: await ta.js(`window.pressed === document.querySelector('[fx-focus="${first}"]')`),
};

// Another device. Its focus is its own, and the one process draws both bars.
const b = await page("https://127.0.0.1:7780/");
await sleep(5000);
const { bar: tb } = await sorted(b);
out.onAnotherDevice = {
    desk: await b.js(desk),
    bar: tb ? await tb.js(bar) : "no taskbar",
    andStillOnTheFirst: await ta.js(bar),
};
await browser(`/json/close/${b.id}`).catch(() => {});

// An app that is no part of the shell asks for the focus, and is not given it.
const { others } = await sorted(a);
const last = out.withTwoApps.desk.inSight.at(-1);
await others[0]?.js(`parent.postMessage({ fx: "focus", surface: ${last} }, "*")`);
await sleep(500);
out.anAppAskingForTheFocus = { asked: last, desk: (await a.js(desk)).focused };

// Too narrow to share: one window in sight, and the taskbar is the way to the rest.
await a.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
});
await sleep(1000);
out.narrow = { desk: await a.js(desk), bar: await ta.js(bar) };
await press(a, ta, last);
out.narrowAfterPressingTheLast = {
    desk: await a.js(desk),
    bar: await ta.js(bar),
    keyboardIn: await a.js(
        `Number(document.activeElement?.closest?.(".fx-surface")?.dataset.id ?? 0)`,
    ),
};
writeFileSync(
    new URL("shell-narrow.png", import.meta.url),
    Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"),
);
await a.send("Emulation.clearDeviceMetricsOverride");
await sleep(1000);

// A window closed is a button gone.
await a.js(`document.querySelector('.fx-surface[data-id="${first}"] [data-part=close]').click()`);
await sleep(1000);
out.afterClosingTheFirst = { desk: await a.js(desk), bar: await ta.js(bar) };
writeFileSync(
    new URL("shell.png", import.meta.url),
    Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64"),
);
out.barLog = ta.log;

// The taskbar's process ended from outside. Fenestra starts another, which is
// told everything and drawn where the last one was.
const process_ = `new Promise((done) => { const s = new WebSocket("ws://" + location.host + "/.fenestra/desktop"); s.onmessage = (m) => { s.close(); done(JSON.parse(m.data).surfaces.find((x) => x.shell && x.role === "panel")?.owner.app.pid ?? 0); }; })`;
const was = await a.js(process_);
const said = spawnSync(
    new URL("../guest.sh", import.meta.url).pathname,
    [`kill ${was}; echo killed`],
    { encoding: "utf8" },
);
await sleep(5000);
const { bar: again } = await sorted(a);
out.afterItsProcessEnded = {
    was,
    guest: said.stdout.trim(),
    is: await a.js(process_),
    desk: await a.js(desk),
    bar: again ? await again.js(bar) : "no taskbar",
};
await finish(0);
