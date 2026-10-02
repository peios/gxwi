// Services Manager's definitions, in headless Chromium: a service's
// definition in a window of its own, read, changed, checked and saved; a
// new service defined; and one deleted.
//
// As dana, an administrator (`node service-definition.mjs`):
// - sshd's definition: a stop timeout typed as words is said to be wrong
//   and cannot be saved, then 20 is saved, and the registry has it; it is
//   put back after.
// - New service… defines demo, which sleeps; it is started, its Runs as is
//   changed and saved, which says it waits for a restart; and Delete…
//   deletes it, closing its window.
// As alice, an ordinary user (`node service-definition.mjs alice`): sshd's
// definition opens with every field fixed, and says why.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const desk = await session(alice ? 9368 : 9367, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "definition-alice" : "definition";
const sshd = "Machine\\System\\Services\\sshd";

/** The windows on the desktop, by the title on their strips. */
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
/** The frame of the window titled `title`, once it is there. */
async function window(title, has) {
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).find((strip) => strip.title === title);
        if (ours) {
            for (const frame of await desk.frames(has)) {
                if ((await frame.js(`document.querySelector("h1")?.textContent ?? document.title`)) === title || has === "input[name=find]") {
                    frame.surface = `.fx-surface[data-id="${ours.id}"]`;
                    return frame;
                }
            }
        }
        await sleep(300);
    }
    return null;
}
async function until(ready, look, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 300) {
        const now = await look();
        if (ready(now)) return now;
        await sleep(300);
    }
    return look();
}
/** Presses `selector` in `frame`, scrolled into sight, until `then` holds:
    a window takes a few seconds to come on a machine just started. */
async function press(frame, selector, then = async () => true) {
    for (let tries = 0; tries < 3; tries++) {
        await frame.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`);
        await desk.press(frame, selector);
        for (let waited = 0; waited < 10; waited++) {
            if (await then()) return true;
            await sleep(400);
        }
    }
    return false;
}
/** Types `text` into the field `field` of the editor, as a person does,
    and leaves it, which is when a field says it changed. */
async function type(editor, field, text) {
    await editor.js(`(() => { const f = document.getElementById(${JSON.stringify(field)}); f.scrollIntoView({ block: "center" }); f.focus(); f.select(); })()`);
    await desk.type(text);
    await editor.js(`document.activeElement.blur()`);
    await sleep(600);
}
const shows = (editor) => editor.js(`({
    title: document.querySelector("h1")?.textContent,
    banner: document.querySelector(".banner")?.textContent ?? null,
    wrong: [...document.querySelectorAll(".wrong")].map((p) => p.id + ": " + p.textContent),
    outcome: document.querySelector(".outcome")?.textContent ?? null,
    buttons: [...document.querySelectorAll("footer button")].map((b) => b.textContent + (b.disabled ? " (off)" : "")),
    disabled: document.querySelectorAll(".form :disabled").length,
    changed: [...document.querySelectorAll(".field.changed code")].map((c) => c.textContent),
})`);

// A first sign-in brings Get started, which takes half the screen, and with
// it the details pane: it goes, whenever it comes.
async function getStartedGoes() {
    for (const strip of await strips()) {
        if (strip.title !== "Get started") continue;
        const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
await getStartedGoes();
await desk.launch("services");
await getStartedGoes();
const manager = await window("Services Manager", "input[name=find]");
if (!manager) await desk.finish({ stopped: "no Services Manager window" }, 1);
await until((rows) => rows > 0, () => manager.js(`document.querySelectorAll(".entries button").length`));
const at = await manager.js(`[...document.querySelectorAll(".entries button")].findIndex((b) => b.querySelector(".name").textContent === "SSH server")`);
await press(manager, `#service-${at}`, async () => (await manager.js(`document.querySelector(".details h2")?.textContent`)) === "SSH server");
out.button = await until((label) => label?.includes("efinition"), () => manager.js(`document.querySelector(".details .open")?.textContent`));
out.newService = await manager.js(`(() => { const b = document.querySelector(".bar .new"); return b.textContent + (b.disabled ? " (" + b.title + ")" : ""); })()`);
await desk.picture(`${name}-details.png`);

// sshd's definition, in its own window.
await press(manager, ".details .open", async () => (await strips()).some((strip) => strip.title === "SSH server definition"));
let editor = await window("SSH server definition", ".definition");
if (!editor) await desk.finish({ ...out, stopped: "no definition window" }, 1);
out.opened = await shows(editor);
out.values = await editor.js(`({ ImagePath: document.getElementById("f-ImagePath").value, Requires: document.getElementById("f-Requires").value, Readiness: document.getElementById("f-Readiness").value, StopTimeout: document.getElementById("f-StopTimeout").placeholder })`);
await desk.picture(`${name}-opened.png`);

if (alice) {
    await press(editor, "footer button:last-child");
    out.closed = await until((gone) => gone, async () => !(await strips()).some((strip) => strip.title === "SSH server definition"));
    await desk.finish(out);
}

await type(editor, "f-StopTimeout", "ten");
out.wrong = await shows(editor);
await desk.picture(`${name}-wrong.png`);
await type(editor, "f-StopTimeout", "20");
out.right = await shows(editor);
await press(editor, "footer .primary", async () => (await shows(editor)).outcome?.startsWith("Saved"));
out.saved = await shows(editor);
out.inRegistry = guest(`reg get '${sshd}' StopTimeout`).split("\n")[0];
await desk.picture(`${name}-saved.png`);
// Put back as it was, and closed.
await type(editor, "f-StopTimeout", "");
await press(editor, "footer .primary", async () => (await shows(editor)).outcome?.startsWith("Saved"));
out.putBack = guest(`reg get '${sshd}' StopTimeout 2>&1`).split("\n")[0];
await press(editor, "footer button:last-child", async () => !(await strips()).some((strip) => strip.title === "SSH server definition"));

// A new service: demo, which sleeps.
await press(manager, ".bar .new", async () => (await strips()).some((strip) => strip.title === "New service"));
editor = await window("New service", ".definition");
if (!editor) await desk.finish({ ...out, stopped: "no New service window" }, 1);
await type(editor, "name", "demo");
out.unnamed = await shows(editor);
await type(editor, "f-DisplayName", "Demo sleeper");
await type(editor, "f-ImagePath", "/usr/bin/sleep");
await type(editor, "f-Arguments", "600");
// sleep never says it is ready: it is ready when it is running.
await editor.js(`(() => { const f = document.getElementById("f-Readiness"); f.value = "Alive"; f.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(600);
out.ready = await shows(editor);
await desk.picture(`${name}-new.png`);
await press(editor, "footer .primary", async () => (await shows(editor)).outcome?.includes("is defined"));
out.defined = await shows(editor);
// The svctl beside the image's, built from this tree, until a peinit with
// definitions is in the image.
out.demo = guest(`/share/svctl-dev definition validate demo 2>&1; sleep 2; svctl start demo | head -1`).split("\n").slice(0, 2);
// Runs as waits for a restart, and says so.
editor = await window("Demo sleeper definition", ".definition") ?? editor;
await type(editor, "f-Identity", "SYSTEM");
await press(editor, "footer .primary", async () => (await shows(editor)).outcome?.startsWith("Saved"));
out.changedRunning = await shows(editor);
await desk.picture(`${name}-running.png`);
// Deleted: asked first, and the window goes.
await press(editor, "footer button:nth-last-child(2)", async () => (await shows(editor)).buttons.includes("Keep it"));
out.asked = await shows(editor);
await desk.picture(`${name}-delete.png`);
await press(editor, "footer .danger", async () => !(await strips()).some((strip) => strip.title === "Demo sleeper definition"));
out.deleted = guest(`sleep 2; svctl status demo | head -3; svctl stop demo | head -1; sleep 2; svctl status demo 2>&1 | head -1`).split("\n").slice(0, 5);
out.log = editor.log;
await desk.finish(out);
