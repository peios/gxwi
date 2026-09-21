// Apps on the desktop, in headless Chromium: the launcher has Fenestra start
// the test app, the app asks for a surface over the display socket and draws it
// itself, in a frame GXWI keeps apart from the desktop. The desktop cannot
// see into such a frame, and neither can this: what an app is showing is
// asked of the app's process, the way the desktop's own page could ask.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

const port = 9337;
const chrome = spawn("chromium", ["--headless", "--disable-gpu", "--hide-scrollbars",
    "--blink-settings=preferredColorScheme=0", "--window-size=1200,800",
    `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    // A page of its own making, not the one the browser opened with: that one
    // shares no cookies with pages made later, and a second page needs them.
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let next = 1;
const waiting = new Map();
const log = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) waiting.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") log.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((r) => { const id = next++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.result.value;
const finish = async (out, code) => {
    out.errors = log;
    await js(`document.querySelector("form")?.submit()`);
    await sleep(1500);
    console.log(JSON.stringify(out, null, 1));
    chrome.kill();
    process.exit(code);
};
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:7780/" });
await sleep(1500);
await js(`document.querySelector("#username").value = "alice"; document.forms[0].submit()`);
await sleep(2000);
await js(`document.querySelector(".secret input").value = "alice-dev-password"; document.forms[0].submit()`);
await sleep(3000);

// The windows, that is: the shell's panel is shell.mjs's to try.
const surfaces = `[...document.querySelectorAll(".fx-surface[data-role=window]")].map(e => { const f = e.querySelector("iframe"); return { kind: e.dataset.kind, focused: e.dataset.focused, owner: e.querySelector(".fx-identity")?.textContent, frame: f?.getAttribute("src")?.replace(/[0-9a-f]{32}/, "<label>"), sandbox: f?.getAttribute("sandbox") ?? undefined, desktopCanSeeIn: f ? f.contentDocument !== null : undefined }; })`;
// Asked of app n's process through its way in, as the desktop's page may.
// A frame's address is /.gxwi/enter/<label>/<path>, so the app's own paths
// start after its first four parts.
const app = (n, what) => js(`fetch(document.querySelectorAll("[data-role=window] iframe")[${n}].getAttribute("src").split("/").slice(0, 4).join("/") + "/${what}").then(r => r.ok ? r.json() : "status " + r.status, String)`);
const says = async (n) => { const s = await app(n, "state"); return typeof s === "string" ? s : `pressed ${s.count}, showing in ${s.views}`; };

const out = { atLogon: await js(surfaces) };
await launch(send); await sleep(2500);
await launch(send); await sleep(2500);
out.afterTwoLaunches = await js(surfaces);
if (out.afterTwoLaunches.filter((s) => s.kind === "app").length !== 2) await finish({ ...out, stopped: "the launcher did not give two apps" }, 1);
out.theyShow = [await says(0), await says(1)];

// A real press on the first app's button, by where it is on the screen. The
// count is the app's process's, and the desktop should notice the keyboard
// going into a frame it cannot see into.
const at = await js(`(() => { const r = document.querySelector("[data-role=window] iframe").getBoundingClientRect(); return { x: r.x + 44, y: r.y + 67 }; })()`);
for (let i = 0; i < 3; i++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(150);
}
await sleep(600);
out.afterThreePresses = { theyShow: [await says(0), await says(1)], focused: (await js(surfaces)).map((s) => s.focused) };

// A second page on the same session: two views of the one surface.
const other = await (await fetch(`http://127.0.0.1:${port}/json/new?http://127.0.0.1:7780/`, { method: "PUT" })).json();
await sleep(3500);
out.withASecondPageOpen = await says(0);
await fetch(`http://127.0.0.1:${port}/json/close/${other.id}`);
await sleep(1000);
out.withItClosedAgain = await says(0);

// How GXWI serves it. (What a page of an app's own can do in there is tried
// by live.mjs, which opens one.)
out.anAppsAnswer = await js(`fetch(document.querySelector("[data-role=window] iframe").getAttribute("src")).then(r => ({ status: r.status, cameFrom: new URL(r.url).pathname.replace(/[0-9a-f]{64}/, "<secret>"), policy: r.headers.get("content-security-policy"), anyoneMayRead: r.headers.get("access-control-allow-origin"), referrer: r.headers.get("referrer-policy") }))`);
out.theSecretAloneIsEnough = await js(`fetch(document.querySelector("[data-role=window] iframe").getAttribute("src")).then(r => fetch(new URL(r.url).pathname.split("/").slice(0, 4).join("/") + "/state", { credentials: "omit" })).then(r => r.status)`);
out.aWrongSecret = await js(`fetch("/.gxwi/a/${"0".repeat(64)}/state", { credentials: "omit" }).then(r => r.status)`);
out.aLabelNobodyHas = await js(`fetch("/.gxwi/enter/${"0".repeat(32)}/state").then(r => r.status)`);
out.sayingTheLabelYourself = await js(`fetch("/", { headers: { "gxwi-origin": document.querySelector("[data-role=window] iframe").getAttribute("src").split("/")[3] } }).then(async r => (await r.text()).includes("<title>Fenestra</title>") ? "ignored: got the desktop" : "GOT THE APP")`);
out.theDesktopIsStillHere = await js(`location.href`);

writeFileSync(new URL("app.png", import.meta.url), Buffer.from((await send("Page.captureScreenshot")).result.data, "base64"));
// Close the first app's surface. Fenestra only asks; the surface goes when
// the app does.
await js(`document.querySelector('.fx-surface[data-kind="app"][data-role="window"] .fx-button[data-part="close"]').click()`);
await sleep(700);
out.afterClosingOne = (await js(surfaces)).map((s) => s.owner);
// HOLD=<seconds> keeps the session up that long, for starting an app some
// other way meanwhile, and then says what is on the desktop.
if (process.env.HOLD) {
    await sleep(Number(process.env.HOLD) * 1000);
    out.afterHolding = await js(surfaces);
}
await finish(out, 0);
