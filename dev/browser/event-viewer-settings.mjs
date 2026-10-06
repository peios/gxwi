// Event Viewer's Settings tab, in headless Chromium.
//
// As dana, an administrator (`node event-viewer-settings.mjs`): eventd's
// settings in their groups; one changed, which eventd takes and records as
// an eventd.config.changed, and put back to its default; a value out of
// its range refused; then who may read what, a pattern added for sshd's
// logs, opened in gxwi-sd-editor, and Authenticated Users' read taken
// away there.
//
// As alice, an ordinary user (`node event-viewer-settings.mjs alice`),
// after dana's run: the settings read-only, with why; the policy shown and
// not changeable; and sshd's logs hidden from her, which the Logs tab
// says. Then dana's run with `tidy` takes the pattern away again.
import { guest, session, sleep } from "./harness.mjs";

const mode = process.argv[2] ?? "dana";
const alice = mode === "alice";
const desk = await session(alice ? 9370 : 9369, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "event-viewer-settings-alice" : mode === "tidy" ? "event-viewer-settings-tidy" : "event-viewer-settings";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
async function gone(titles) {
    for (const strip of await strips()) {
        if (!titles.some((title) => strip.title.startsWith(title))) continue;
        const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
await gone(["Get started", "Event Viewer"]);
await desk.launch("event");
await gone(["Get started"]);
let viewer = null;
for (let i = 0; i < 40 && !viewer; i++) {
    const ours = (await strips()).filter((strip) => strip.title.startsWith("Event Viewer"));
    if (ours.length) {
        viewer = (await desk.frames("form.filters"))[0] ?? null;
        if (viewer) viewer.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
    }
    await sleep(300);
}
if (!viewer) {
    out.stopped = "no Event Viewer window";
    await desk.finish(out, 1);
}
await desk.press(viewer, '.tab[fx-value-kind="settings"]');

const shows = () => viewer.js(`({
    title: [...document.querySelectorAll(".tab")].filter((t) => t.getAttribute("aria-pressed") === "true").map((t) => t.textContent),
    note: document.querySelector(".settings-page > .note")?.textContent ?? null,
    groups: [...document.querySelectorAll(".settings-page .group h2")].map((h) => h.textContent + " (" + h.parentElement.querySelectorAll(".setting").length + ")"),
    health: (() => { const s = document.querySelector("#s-HealthMetricIntervalSeconds"); return s ? { input: s.querySelector("input")?.value, disabled: s.querySelector("input")?.disabled, facts: s.querySelector(".facts")?.textContent, said: s.querySelector(".said")?.textContent ?? null, buttons: [...s.querySelectorAll("button")].map((b) => b.textContent) } : null; })(),
    perUser: (() => { const s = document.querySelector("#s-MaxQueriesPerUser"); return s ? { input: s.querySelector("input")?.value, said: s.querySelector(".said")?.textContent ?? null } : null; })(),
    patterns: [...document.querySelectorAll(".pattern")].map((p) => p.querySelector(".covers").textContent + " | " + [...p.querySelectorAll(".grants li")].map((l) => l.textContent).join("; ") + " | " + [...p.querySelectorAll(".actions button")].map((b) => b.textContent).join(", ")),
    adds: document.querySelectorAll("form.add").length,
    said: [...document.querySelectorAll(".policy .said")].map((s) => s.textContent),
    footer: document.querySelector(".status")?.textContent ?? null,
})`);
async function until(ready, ms = 20000) {
    for (let waited = 0; waited < ms; waited += 400) {
        const now = await shows();
        if (ready(now)) return now;
        await sleep(400);
    }
    return shows();
}
/** Types `text` into the field called `field` and presses Enter. */
async function enter(field, text) {
    await viewer.js(`document.querySelector("input[name='${field}']").scrollIntoView({ block: "center" })`);
    await sleep(300);
    await desk.press(viewer, `input[name='${field}']`);
    await viewer.js(`document.querySelector("input[name='${field}']").select()`);
    await desk.type(text);
    await desk.key("Enter", { vk: 13 }, "\r");
    await sleep(1200);
}
const read = (s) => s.groups.length > 0 && s.patterns.length > 0;

if (mode === "tidy") {
    await until(read);
    if (await viewer.js(`!!document.querySelector("#p-logs-sshd")`)) {
        await viewer.js(`document.querySelector("#p-logs-sshd").scrollIntoView({ block: "center" })`);
        await sleep(300);
        await desk.press(viewer, '#p-logs-sshd button[fx-click="policy-remove-ask"]');
        out.asked = await viewer.js(`document.querySelector("#p-logs-sshd .note")?.textContent ?? null`);
        await desk.picture(`${name}-asked.png`);
        await desk.press(viewer, '#p-logs-sshd button[fx-click="policy-remove"]');
    }
    out.after = (await until((s) => !s.patterns.some((p) => p.startsWith("Logs from sshd")))).patterns;
    out.said = (await shows()).said;
    await desk.finish(out);
}

out.first = await until(read);
await desk.picture(`${name}.png`);

if (alice) {
    // sshd's logs, which dana's run kept from her.
    await desk.press(viewer, '.tab[fx-value-kind="logs"]');
    await sleep(2500);
    out.logsHidden = await viewer.js(`document.querySelector(".status .hidden")?.textContent`);
    await desk.picture(`${name}-logs.png`);
    await desk.finish(out);
}

// A setting changed, taken by eventd, and put back.
await enter("v-HealthMetricIntervalSeconds", "30");
out.changed = (await until((s) => s.health?.said?.startsWith("Saved"))).health;
out.registry = guest(`reg get "Machine\\System\\eventd" HealthMetricIntervalSeconds`).trim();
await sleep(1500);
out.recorded = guest(`evctl "EVENTS eventd.config.changed TAKE 1" | cut -c1-400`).trim();
await desk.picture(`${name}-changed.png`);
await desk.press(viewer, '#s-HealthMetricIntervalSeconds button[fx-click="setting-default"]');
out.defaulted = (await until((s) => s.health?.said?.startsWith("Back"))).health;
out.registryAfter = guest(`reg get "Machine\\System\\eventd" HealthMetricIntervalSeconds 2>&1`).trim();

// Out of its range: refused here, and nothing written.
await enter("v-MaxQueriesPerUser", "99999");
out.refused = (await until((s) => s.perUser?.said !== null)).perUser;
out.registryRefused = guest(`reg get "Machine\\System\\eventd" MaxQueriesPerUser 2>&1`).trim();

// A pattern for sshd's logs, opened in the editor, and Authenticated
// Users' read taken away.
await enter("add-logs", "sshd");
let editor = null;
for (let i = 0; i < 30 && !editor; i++) {
    editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
    if (!editor) await sleep(300);
}
out.editor = editor
    ? await editor.js(`({
        title: document.querySelector("header")?.innerText,
        listed: [...document.querySelectorAll(".who")].map((b) => b.querySelector(".name").textContent),
        rights: [...document.querySelectorAll(".rights tbody tr th")].map((th) => th.textContent),
    })`)
    : "no dialog";
await desk.picture(`${name}-editor.png`);
if (editor) {
    await desk.press(editor, ".who[fx-value-sid='S-1-5-11']");
    await desk.press(editor, "button[fx-value-right='0'][fx-value-way='allow']");
    await desk.press(editor, "footer .primary");
    await sleep(1500);
}
out.added = (await until((s) => s.patterns.some((p) => p.startsWith("Logs from sshd") && !p.includes("Authenticated Users")))).patterns.filter((p) => p.startsWith("Logs"));
await viewer.js(`[...document.querySelectorAll(".pattern")].find((p) => p.querySelector(".covers").textContent.startsWith("Logs from sshd"))?.scrollIntoView({ block: "center" })`);
await sleep(500);
await desk.picture(`${name}-added.png`);
await desk.finish(out);
