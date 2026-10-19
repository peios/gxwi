// Task Manager, in headless Chromium, as dana, an administrator
// (`node task-manager.mjs`).
//
// It opens on every process in one list, and groups them by service when
// asked. sshd's main process picked is
// shown in full: what started it, who it runs as, its session, its
// protection. peinit, which no administrator can look into, is listed as a
// protected process, and its PSB still says what protects it. Grouped by
// person, each person's processes come together; finding narrows the list.
//
// As alice (`node task-manager.mjs alice`), who isn't an administrator: the
// window says whose processes she can't see, and only her own say who runs
// them.
import { session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "task-manager-alice" : "task-manager";

const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
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
        const close = await desk.a.js(
            `(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
await gone(["Get started", "Task Manager"]);
await desk.launch("task");
await gone(["Get started"]);
const manager = await window("Task Manager", ".list");
if (!manager) {
    out.stopped = "no Task Manager window to attach to";
    await desk.finish(out, 1);
}

/** What the window shows. */
const shows = () =>
    manager.js(`({
    tabs: [...document.querySelectorAll(".tab")].map((b) => b.textContent + (b.getAttribute("aria-pressed") === "true" ? " (shown)" : "")),
    groups: [...document.querySelectorAll(".entries .group")].map((g) => [...g.querySelectorAll("span")].map((s) => s.textContent).join(" | ")),
    rows: [...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | ") + (b.getAttribute("aria-selected") === "true" ? " (picked)" : "")),
    details: document.querySelector(".details")?.innerText.replaceAll("\\n", " / ") ?? null,
    said: [...document.querySelectorAll(".said")].map((p) => p.textContent),
    footer: document.querySelector(".status")?.innerText.replaceAll("\\n", " / ") ?? null,
})`);
async function until(ready, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 300) {
        const now = await shows();
        if (ready(now)) return now;
        await sleep(300);
    }
    return shows();
}
const press = (selector) =>
    manager
        .js(
            `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(manager, selector));
/** The PID of the first row whose name is `who`. */
const pidOf = (who) =>
    manager.js(
        `[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === ${JSON.stringify(who)})?.getAttribute("fx-value-pid") ?? null`,
    );
const find = async (text) => {
    await manager.js(
        `(() => { const f = document.querySelector("[name=filter]"); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    await sleep(600);
};

// One list at first; the CPU column fills from the second look.
const opened = await until((s) => s.rows.some((row) => /\d%/.test(row)));
out.opened = { tabs: opened.tabs, groups: opened.groups, rows: opened.rows.length };
await desk.picture(`${name}-opened.png`);

// Grouped by service.
await press(`.tab[fx-value-by="Service"]`);
const first = await until((s) => s.groups.length > 2);
out.groups = first.groups;
out.said = first.said;
out.footer = first.footer;
await desk.picture(`${name}-services.png`);

// sshd's main process, in full.
const sshd = await pidOf("sshd");
if (sshd) {
    await press(`.entries button[fx-value-pid="${sshd}"]`);
    out.sshd = (await until((s) => (s.details ?? "").includes("Belongs to"))).details;
    await desk.picture(`${name}-sshd.png`);
}

// peinit: a protected process, closed even to an administrator.
await press(`.entries button[fx-value-pid="1"]`);
out.peinit = (await until((s) => (s.details ?? "").includes("Process 1"))).details;
await desk.picture(`${name}-protected.png`);

// By person, and finding.
await press(`.tab[fx-value-by="Person"]`);
const people = await until((s) => s.tabs.includes("Person (shown)"));
out.people = people.groups;
await desk.picture(`${name}-people.png`);
await find("login");
out.found = (await shows()).rows;
await find("");

out.said = (await shows()).said;
await desk.finish(out);
