// Event Viewer's Metrics tab, in headless Chromium, as dana, an
// administrator (`node event-viewer-metrics.mjs`).
//
// The tab, between Events and Logs, with eventd's health as the dashboard
// a person has before saving any; a chart's readout under the pointer; a
// chart's settings, and a change made there; a new dashboard, named, with
// a chart picked from the catalogue over the last 15 minutes; Event Viewer
// closed and opened again with the dashboards as they were left; and the
// new one deleted.
//
// Everyone's saved dashboards are deleted first, so that each run starts
// from eventd's health.
//
// As alice (`node event-viewer-metrics.mjs alice`), after dana's run:
// her dashboards are her own, so she has eventd's health and not dana's.
//
// eventd's own health metrics fill the charts, so the dev VM wants eventd
// with them (PEI-1236 slice 4).
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
if (!alice) out0(guest(`for k in $(reg ls Users); do reg del "Users\\\\\${k%/}\\\\Software\\\\gxwi-event-viewer" Dashboards >/dev/null 2>&1; done; echo reset`));
function out0(said) {
    if (!said.includes("reset")) throw new Error(`could not reset the dashboards: ${said}`);
}
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "event-viewer-metrics-alice" : "event-viewer-metrics";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
/** The frame of the window whose title starts `title`, once it is there. */
async function window(title, has) {
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).filter((strip) => strip.title.startsWith(title));
        if (ours.length > 0) {
            const frame = (await desk.frames(has))[0];
            if (frame) {
                frame.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
                return frame;
            }
        }
        await sleep(300);
    }
    return null;
}
async function gone(titles) {
    for (const strip of await strips()) {
        if (!titles.some((title) => strip.title.startsWith(title))) continue;
        const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
/** Event Viewer, opened afresh and on its Metrics tab. */
async function open() {
    await gone(["Get started", "Event Viewer"]);
    await desk.launch("event");
    await gone(["Get started"]);
    const viewer = await window("Event Viewer", "form.filters");
    if (!viewer) {
        out.stopped = "no Event Viewer window to attach to";
        await desk.finish(out, 1);
    }
    await desk.press(viewer, '.tab[fx-value-kind="metrics"]');
    return viewer;
}
let viewer = await open();
/** What the tab shows. */
const shows = () => viewer.js(`({
    tabs: [...document.querySelectorAll(".tab")].map((t) => t.textContent + (t.getAttribute("aria-pressed") === "true" ? " (shown)" : "")),
    title: document.title,
    dashboards: [...document.querySelectorAll("select[name=board] option")].map((o) => o.textContent + (o.selected ? " (shown)" : "")),
    span: document.querySelector("select[name=span]")?.value ?? null,
    catalogue: [...document.querySelectorAll(".catalogue .metric")].map((b) => b.querySelector(".name").textContent + " | " + b.querySelector(".latest").textContent),
    charts: [...document.querySelectorAll(".chart")].map((c) => c.querySelector(".name").textContent + " | " + c.querySelector(".how").textContent + " | " + (c.querySelector(".plot") ? c.querySelectorAll("polyline").length + " runs, " + c.querySelectorAll(".col").length + " windows, y " + [...c.querySelectorAll(".y span")].map((s) => s.textContent).join("/") + (c.querySelector(".legend") ? ", legend " + [...c.querySelectorAll(".legend li")].map((l) => l.textContent).join("; ") : "") : (c.querySelector(".more, .trouble, .no-samples")?.textContent ?? "?"))),
    notes: [...document.querySelectorAll(".board .note")].map((n) => n.textContent),
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
/** Sets a list in the window to `value`, as picking from it does. */
async function choose(field, value) {
    await viewer.js(`(() => { const s = document.querySelector("select[name=${field}]"); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(1200);
}
const drawn = (s) => s.charts.length > 0 && s.charts.every((c) => !c.includes("Reading"));

// The tab, and eventd's health, which is what a person has before saving.
out.health = await until((s) => drawn(s) && s.catalogue.length > 0);
// A series no longer sampled says when it last was.
out.stale = await viewer.js(`[...document.querySelectorAll(".catalogue .metric")].filter((b) => b.title.includes("last recorded") || b.classList.contains("stopped")).map((b) => b.querySelector(".name").textContent + ": " + b.title.replaceAll("\\n", "; "))`);
await desk.picture(`${name}-health.png`);
if (alice) await desk.finish(out);

// The first chart's right-click menu: its change in each window instead.
await viewer.js(`document.querySelector(".chart:nth-child(1)").scrollIntoView({ block: "center" })`);
out.menu = (await desk.menuOn(viewer, ".chart:nth-child(1) .plot")) && (await desk.menu());
await desk.choose("Change in each window");
out.byMenu = (await until((s) => drawn(s) && s.charts[0].includes("Change in each window"))).charts[0];

// The pointer over a window of the store sizes' chart, brought into sight
// first: every line's value there.
await viewer.js(`document.querySelector(".chart:nth-child(5)").scrollIntoView({ block: "center" })`);
await sleep(400);
const at = await desk.middle(viewer, ".chart:nth-child(5) .col:nth-child(40)");
await desk.hoverAt(at);
out.readout = await viewer.js(`[...document.querySelectorAll(".chart:nth-child(5) .col:nth-child(40) .tip span")].map((s) => s.textContent)`);
out.readoutShown = await viewer.js(`getComputedStyle(document.querySelector(".chart:nth-child(5) .col:nth-child(40) .tip")).display`);
await desk.picture(`${name}-readout.png`);
await desk.hoverAt({ x: 5, y: 5 });

// A chart's settings: store sizes, one line for all of them.
await desk.press(viewer, ".chart:nth-child(5) .more-button");
await sleep(600);
out.settings = await viewer.js(`[...document.querySelectorAll(".chart:nth-child(5) .settings select")].map((s) => s.name + "=" + s.value + " of " + [...s.options].map((o) => o.textContent).join("/"))`);
await desk.picture(`${name}-settings.png`);
await choose("edit-lines", "each");
await choose("edit-function", "max");
await choose("edit-lines", "one");
out.changed = (await until((s) => drawn(s) && s.charts[4].includes("all series together"))).charts[4];
await desk.press(viewer, ".chart:nth-child(5) .settings .actions button:last-child");
await sleep(600);

// A dashboard of one's own: named, one chart from the catalogue, the last
// 15 minutes.
await desk.press(viewer, 'button[fx-click="board-new"]');
await until((s) => s.dashboards.some((d) => d.startsWith("Dashboard 1")));
await desk.press(viewer, "input[name=boardname]");
await viewer.js(`document.querySelector("input[name=boardname]").select()`);
await desk.type("Stores");
await desk.key("Enter", { vk: 13 }, "\r");
await sleep(800);
await viewer.js(`(() => { const f = document.querySelector("input[name=find]"); f.value = "store.bytes"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await sleep(800);
out.found = (await shows()).catalogue;
await desk.press(viewer, '.catalogue .metric[fx-value-metric="eventd.store.bytes"]');
await choose("span", "15m");
out.own = await until((s) => drawn(s) && s.charts.length === 1);
await desk.picture(`${name}-own.png`);

// Closed and opened again: the dashboards are the person's, kept.
viewer = await open();
await choose("board", "1");
out.reopened = await until((s) => drawn(s) && s.charts.length === 1);
await desk.picture(`${name}-reopened.png`);

// Deleted, after saying so.
await desk.press(viewer, 'button[fx-click="board-delete-ask"]');
out.asked = (await shows()).notes;
await desk.press(viewer, 'button[fx-click="board-delete"]');
out.deleted = await until((s) => s.dashboards.length === 1 && drawn(s));
await desk.picture(`${name}-deleted.png`);
await desk.finish(out);
