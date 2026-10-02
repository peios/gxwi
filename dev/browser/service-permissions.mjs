// Services Manager's permissions, in headless Chromium: who may control a
// service and who may change its definition, each opened in gxwi-sd-editor.
//
// As dana, an administrator (`node service-permissions.mjs`): sshd's
// "Who may control it…" gives Authenticated Users Start and Stop, which
// writes sshd's own ServiceSecurity; "Who may change its definition…" adds
// Everyone with Read to its key, and then takes them away again. The grant
// to Authenticated Users is left in place for alice.
//
// As alice, an ordinary user (`node service-permissions.mjs alice`): both
// open, and neither can be changed, and each says why. With what dana gave
// her she stops sshd and starts it again. Then sshd's ServiceSecurity is
// taken away, so it is as it was.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const desk = await session(alice ? 9364 : 9363, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "permissions-alice" : "permissions";
const sshd = "Machine\\System\\Services\\sshd";

// A first sign-in brings Get started with it, which takes half the screen
// and, with it, the details pane: it goes.
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
for (const window of await strips()) {
    if (window.title !== "Get started") continue;
    const close = await desk.a.js(`(() => {
        const r = document.querySelector('.fx-surface[data-id="${window.id}"] [data-part="close"]')?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch("services");
const manager = await desk.frame("input[name=find]", '.fx-surface[data-role="window"]');
if (!manager) {
    out.stopped = "no Services Manager window to attach to";
    await desk.finish(out, 1);
}
// Its own surface, by id: another window may be first on the page.
const ours = (await strips()).find((window) => window.title === "Services Manager");
if (ours) manager.surface = `.fx-surface[data-id="${ours.id}"]`;
const details = () => manager.js(`({
    text: document.querySelector(".details")?.innerText ?? null,
    buttons: [...document.querySelectorAll(".details .permissions button, .bar .commands button")].map((b) => b.textContent + (b.disabled ? " (" + (b.title || "disabled") + ")" : "")),
    said: document.querySelector(".said")?.textContent ?? null,
})`);
async function until(ready, look, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 300) {
        const now = await look();
        if (ready(now)) return now;
        await sleep(300);
    }
    return look();
}

// sshd, picked by a real press on its row.
await until((rows) => rows > 0, () => manager.js(`document.querySelectorAll(".entries button").length`));
const at = await manager.js(`(() => {
    const rows = [...document.querySelectorAll(".entries button")];
    const at = rows.findIndex((b) => b.querySelector(".name").textContent === "SSH server");
    rows[at]?.scrollIntoView({ block: "center" });
    return at;
})()`);
// The first press on a new window can go before it is ready for one.
for (let tries = 0; tries < 4 && !(await details()).text?.includes("SSH server"); tries++) {
    await desk.press(manager, `#service-${at}`);
    await sleep(800);
}
out.picked = await until((d) => d.text?.includes("Who may control it is"), details);
await desk.picture(`${name}-details.png`);

/** The dialog the editor opened, once it is on the desktop. */
async function dialog() {
    for (let i = 0; i < 30; i++) {
        const found = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
        if (found) return found;
        await sleep(300);
    }
    return null;
}
const gone = () => until((none) => none, () => desk.a.js(`!document.querySelector('.fx-surface[data-role="dialog"]')`), 10000);
/** What the dialog shows. */
const shows = (editor) => editor.js(`({
    title: document.querySelector("header")?.innerText,
    fixed: document.querySelector(".fixed")?.textContent ?? null,
    listed: [...document.querySelectorAll(".who")].map((b) => b.querySelector(".name").textContent + (b.getAttribute("aria-selected") === "true" ? " (picked)" : "")),
    boxes: [...document.querySelectorAll(".rights tbody tr")].map((tr) => tr.querySelector("th").textContent + ": " + [...tr.querySelectorAll("[role=checkbox]")].map((c) => (c.getAttribute("aria-checked") === "true" ? "✓" : "·") + (c.disabled || c.getAttribute("aria-disabled") ? "(fixed)" : "")).join(" ")),
    footer: [...document.querySelectorAll("footer button")].map((b) => b.textContent + (b.disabled ? " (off)" : "")),
    trouble: document.querySelector(".trouble")?.textContent ?? null,
})`);
const open = async (which) => {
    await desk.press(manager, `.details .permissions button[fx-value-which="${which}"]`);
    return dialog();
};

if (alice) {
    // Who may control it: hers to read, not to change, and it says why.
    let editor = await open("control");
    out.control = editor ? await shows(editor) : "no dialog";
    if (editor) {
        await desk.press(editor, ".who[fx-value-sid='S-1-5-11']");
        out.controlAuthenticated = await shows(editor);
        await desk.picture(`${name}-control.png`);
        await desk.press(editor, "footer .primary");
        out.closed = await gone();
    }
    editor = await open("definition");
    out.definition = editor ? await shows(editor) : "no dialog";
    await desk.picture(`${name}-definition.png`);
    if (editor) {
        await desk.press(editor, "footer .primary");
        await gone();
    }
    // What dana gave her: she stops sshd, and starts it again.
    out.offered = await details();
    await desk.press(manager, ".bar .commands button:nth-child(2)");
    out.stopped = await until((d) => d.said !== null, details, 30000);
    await desk.press(manager, ".bar .commands button:nth-child(1)");
    out.started = await until((d) => d.said?.includes("started"), details, 30000);
    await desk.picture(`${name}-started.png`);
    out.putBack = guest(`reg del '${sshd}' ServiceSecurity; sleep 2; svctl status sshd | head -2`);
    await desk.finish(out);
}

// Who may control it: Authenticated Users may start and stop it too.
let editor = await open("control");
out.control = editor ? await shows(editor) : "no dialog";
if (!editor) await desk.finish(out, 1);
await desk.press(editor, ".who[fx-value-sid='S-1-5-11']");
await desk.press(editor, "button[fx-value-right='1'][fx-value-way='allow']");
await desk.press(editor, "button[fx-value-right='2'][fx-value-way='allow']");
out.controlTicked = await shows(editor);
await desk.picture(`${name}-control.png`);
await desk.press(editor, "footer .primary");
out.controlClosed = await gone();
out.controlValue = guest(`reg get '${sshd}' ServiceSecurity`);
out.afterControl = await until((d) => d.text?.includes("set for this service"), details);

// Who may change its definition: Everyone may read it, and then not.
editor = await open("definition");
out.definition = editor ? await shows(editor) : "no dialog";
if (!editor) await desk.finish(out, 1);
await desk.press(editor, ".under button:first-child");
await sleep(400);
await desk.type("Everyone");
await desk.press(editor, "form.naming button[type=submit]");
await desk.press(editor, "button[fx-value-right='1'][fx-value-way='allow']");
out.definitionTicked = await shows(editor);
await desk.picture(`${name}-definition.png`);
await desk.press(editor, "footer .primary");
out.definitionClosed = await gone();
out.keyWithEveryone = guest(`reg sd '${sshd}'`);
editor = await open("definition");
if (editor) {
    await desk.press(editor, ".who[fx-value-sid='S-1-1-0']");
    await desk.press(editor, ".under button:last-child");
    out.removed = await shows(editor);
    await desk.press(editor, "footer .primary");
    await gone();
}
out.keyAfter = guest(`reg sd '${sshd}'`);
await desk.picture(`${name}-after.png`);
out.log = manager.log;
await desk.finish(out);
