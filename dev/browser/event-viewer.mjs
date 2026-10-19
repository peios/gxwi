// Event Viewer, in headless Chromium: eventd's events and logs, newest
// first and live, narrowed, and each record in full.
//
// As dana, an administrator (`node event-viewer.mjs`): the events, a type
// pattern and an event in full, the details pane widened by its edge, and
// a row's menu; then the logs, a record picked, a line logged while the
// window is open arriving at the top, errors only and one origin; then
// sshd's logs opened from Services Manager's Logs button.
//
// Paging (`node event-viewer.mjs paging`): eventd's store wants more than
// the window holds first, which the flood service of the dev VM recipe
// gives. Older pages to the end of what the window holds, and back to the
// newest.
//
// As alice, an ordinary user (`node event-viewer.mjs alice`): what the
// window says when eventd keeps things from her (PEI-1239).
//
// The dev VM puts Event Viewer in /usr/bin and declares it, so the launcher
// finds it as "event".
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const paging = process.argv[2] === "paging";
const desk = await session(
    alice ? 9364 : paging ? 9365 : 9363,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "event-viewer-alice" : paging ? "event-viewer-paging" : "event-viewer";

/** The windows on the desktop, by the title on their strips. */
const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
/** The frame of a window titled `title` that `not` is not, once it is there. */
async function window(title, has, not = null) {
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).filter((strip) => strip.title === title);
        if (ours.length > 0) {
            for (const frame of await desk.frames(has)) {
                if (frame.id === not?.id) continue;
                frame.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
                return frame;
            }
        }
        await sleep(300);
    }
    return null;
}
// A first sign-in brings Get started, which takes half the screen, and a
// window left from an earlier run may be an older program: they go.
async function gone(titles) {
    for (const strip of await strips()) {
        if (!titles.some((title) => strip.title.startsWith(title))) continue;
        const close = await desk.a.js(
            `(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}

await gone(["Get started", "Event Viewer", "Services Manager"]);
await desk.launch("event");
await gone(["Get started"]);
const viewer = await window("Event Viewer", "form.filters");
if (!viewer) {
    out.stopped = "no Event Viewer window to attach to";
    await desk.finish(out, 1);
}
/** What a window shows. */
const shows = (frame = viewer) =>
    frame.js(`({
    tab: document.querySelector('.tab[aria-pressed="true"]')?.textContent ?? null,
    rows: [...document.querySelectorAll(".entries .row")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | ") + (b.classList.contains("error") ? " | ERROR" : "") + (b.getAttribute("aria-selected") === "true" ? " | PICKED" : "")),
    trouble: document.querySelector(".trouble")?.textContent ?? null,
    note: document.querySelector(".note")?.textContent ?? null,
    more: [...document.querySelectorAll(".more")].map((p) => p.textContent),
    footer: document.querySelector(".status")?.textContent ?? null,
    live: document.querySelector(".bar .live")?.textContent ?? null,
    details: document.querySelector(".details") ? [...document.querySelectorAll(".details h2, .details .message, .details h3, .details dt, .details dd, .details.empty p, .details .actions button")].map((e) => e.textContent).join(" | ") : null,
})`);
/** Waits until `ready` says so of what the window shows, for up to `ms`. */
async function until(ready, ms = 15000, frame = viewer) {
    for (let waited = 0; waited < ms; waited += 300) {
        const now = await shows(frame);
        if (ready(now)) return now;
        await sleep(300);
    }
    return shows(frame);
}
/** Only the first `n` rows, to keep the output short. */
const first = (s, n = 5) => ({ ...s, rows: s.rows.slice(0, n), count: s.rows.length });
/** Types `text` into the field called `field` and presses Enter. */
async function enter(field, text) {
    await desk.press(viewer, `input[name=${field}]`);
    await viewer.js(`document.querySelector("input[name=${field}]").select()`);
    await desk.type(text);
    await desk.key("Enter", { vk: 13 }, "\r");
}

// It opens on the events.
out.first = first(
    await until((s) => s.rows.length > 0 || s.trouble !== null || s.more.length > 0),
    3,
);
await desk.picture(`${name}-events.png`);

/** Shows the logs. */
async function logs() {
    await desk.press(viewer, '.tab[fx-value-kind="logs"]');
    return until(
        (s) => s.tab === "Logs" && (s.rows.length > 0 || s.more.length > 0 || s.trouble !== null),
    );
}

if (alice) {
    out.logs = first(await logs());
    await desk.picture(`${name}-logs.png`);
    await desk.finish(out);
}

if (paging) {
    // Each page is 200; the window holds 1000, so the fifth goes past it.
    for (let page = 1; page <= 5; page++) {
        const before = (await shows()).rows.at(-1);
        await viewer.js(`document.querySelector(".older")?.scrollIntoView()`);
        if (!(await desk.press(viewer, ".older"))) break;
        const now = await until(
            (s) => s.rows.at(-1) !== before && s.more.every((m) => m !== "Reading older ones…"),
        );
        out[`page${page}`] = {
            count: now.rows.length,
            newest: now.rows[0],
            oldest: now.rows.at(-1),
            note: now.note,
            live: now.live,
            footer: now.footer,
        };
    }
    await viewer.js(`document.querySelector(".listing .scroll").scrollTop = 0`);
    await desk.picture(`${name}-back.png`);
    await viewer.js(`document.querySelector(".older")?.scrollIntoView()`);
    await desk.picture(`${name}-older.png`);
    await viewer.js(`document.querySelector(".listing .scroll").scrollTop = 0`);
    await desk.press(viewer, ".note .link");
    out.newest = first(await until((s) => s.note === null && s.live === "Pause"), 2);
    await desk.finish(out);
}

// A type pattern, and an event in full.
await enter("type", "job.*");
out.jobs = first(
    await until(
        (s) => s.rows.length > 0 && s.rows.every((r) => r.split(" | ")[1].startsWith("job.")),
    ),
    3,
);
await desk.press(viewer, ".entries li:nth-child(1) .row");
out.event = (await until((s) => s.details?.includes("Its fields"))).details;
await desk.picture(`${name}-event.png`);

// The details pane, widened by dragging its edge, from the pane's side.
const widths = () =>
    viewer.js(
        `({ listing: Math.round(document.querySelector(".listing").getBoundingClientRect().width), details: Math.round(document.querySelector(".details").getBoundingClientRect().width) })`,
    );
out.beforeDrag = await widths();
const middle = await desk.middle(viewer, ".details");
const from = { x: middle.x - out.beforeDrag.details / 2 + 2, y: middle.y };
const release = await desk.drag(from, { x: from.x - 200, y: from.y });
await release();
out.afterDrag = await widths();
await desk.picture(`${name}-widened.png`);
// And it stays as wide when what is shown changes.
await enter("type", "");
await until((s) => s.rows.length > 0 && !s.rows.every((r) => r.split(" | ")[1].startsWith("job.")));
out.afterRender = await widths();

// A row's menu: shows only that type.
out.menuSaid = await desk.menuOn(viewer, ".entries li:nth-child(1) .row");
out.menu = await desk.menu();
await desk.choose("Show only this type");
out.only = first(await until((s) => new Set(s.rows.map((r) => r.split(" | ")[1])).size === 1), 2);
out.onlyField = await viewer.js(`document.querySelector("input[name=type]").value`);

// The logs.
out.logs = first(await logs(), 3);
await desk.picture(`${name}-logs.png`);

// A record picked by a real press: all of it.
await desk.press(viewer, ".entries li:nth-child(2) .row");
out.picked = await until((s) => s.rows[1]?.endsWith("PICKED") && s.details?.includes("Copy"));
out.picked = { details: out.picked.details, row: out.picked.rows[1] };
await desk.picture(`${name}-picked.png`);

// Live: a line logged now arrives at the top, the one picked staying picked.
guest("svctl restart sshd");
out.live = first(await until((s) => s.rows[0]?.includes("sshd")), 3);
await desk.picture(`${name}-live.png`);

// Errors only, which applies when ticked.
await desk.press(viewer, "input[name=errors]");
out.errors = first(
    await until(
        (s) =>
            s.rows.length > 0 && s.rows.every((r) => r.endsWith("ERROR") || r.endsWith("PICKED")),
    ),
    3,
);
await desk.press(viewer, "input[name=errors]");

// One origin, typed: applied on Enter.
await enter("origin", "timed");
out.origin = first(
    await until(
        (s) => s.rows.length > 0 && s.rows.every((r) => r.split(" | ")[1].startsWith("timed")),
    ),
    3,
);
await desk.picture(`${name}-origin.png`);
await enter("origin", "");

// sshd's logs, from Services Manager.
await desk.launch("services");
const manager = await window("Services Manager", "input[name=find]");
await sleep(2000);
const at = await manager.js(`(() => {
    const rows = [...document.querySelectorAll(".entries button")];
    const at = rows.findIndex((b) => b.querySelector(".name").textContent === "SSH server");
    rows[at]?.scrollIntoView({ block: "center" });
    return at;
})()`);
// At half the screen its details pane is put away, so by the row's menu.
await desk.press(manager, `#service-${at}`);
await sleep(1500);
out.serviceMenu = (await desk.menuOn(manager, `#service-${at}`)) && (await desk.menu());
await desk.choose("Logs…");
const opened = await window("Event Viewer: sshd", "form.filters", viewer);
if (opened) {
    out.serviceLogs = first(
        await until((s) => s.rows.length > 0 || s.more.length > 0, 15000, opened),
        4,
    );
    out.serviceLogs.origin = await opened.js(`document.querySelector("input[name=origin]").value`);
} else {
    out.serviceLogs = "no second Event Viewer window";
}
await desk.picture(`${name}-from-services.png`);

out.log = viewer.log;
await desk.finish(out);
