// Task Manager's Jobs, in headless Chromium (`node task-manager-jobs.mjs`,
// then `node task-manager-jobs.mjs alice`).
//
// A job is submitted from the console, as peios: `sleep 4400`, described as
// "Jobs view check". As dana, an administrator: Jobs lists it beside the
// desktop sessions' jobs, picked it is shown in full, and Stop job, which
// peinit says she may, stops it. As alice: Jobs lists only what she may see,
// which is nothing of peios's, and says that peinit leaves the rest out.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
guest(`svctl --no-wait job submit --description "Jobs view check" /usr/bin/sleep 4400 >/dev/null 2>&1; echo ok`);
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "task-manager-jobs-alice" : "task-manager-jobs";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
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
await gone(["Get started", "Task Manager"]);
await desk.launch("task");
await gone(["Get started"]);
const manager = await window("Task Manager", ".list");
if (!manager) {
    out.stopped = "no Task Manager window to attach to";
    await desk.finish(out, 1);
}
const details = () => manager.js(`document.querySelector(".details")?.innerText.replaceAll("\\n", " / ") ?? null`);
const rows = () => manager.js(`[...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | "))`);
const press = (selector) => manager.js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`).then(() => desk.press(manager, selector));
await sleep(2500);

await press('.tab[fx-value-by="Jobs"]');
await sleep(2500);
out.jobs = await rows();
out.note = await manager.js(`[...document.querySelectorAll(".said")].map((p) => p.textContent)`);
const id = await manager.js(`[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === "Jobs view check")?.getAttribute("fx-value-id") ?? null`);
if (id) {
    await press(`.entries button[fx-value-id="${id}"]`);
    await sleep(800);
    out.job = await details();
    await desk.picture(`${name}.png`);
    if (await manager.js(`!!document.querySelector('.details button[fx-click="stop-job"]')`)) {
        await press('.details button[fx-click="stop-job"]');
        await sleep(500);
        await press('.details button[fx-click="stop-job-confirm"]');
        await sleep(3000);
        out.after = await details();
    }
} else {
    await desk.picture(`${name}.png`);
}
await desk.finish(out);
