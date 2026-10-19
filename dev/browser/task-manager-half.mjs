// Task Manager at half the screen, in headless Chromium, as dana
// (`node task-manager-half.mjs`).
//
// A second window tiles the first to half the screen. With Event Viewer
// beside it, each grouping and the pane with the most in it (a process with a
// long command line, and a protected one) are pictured, and the window is
// checked for anything wider than it: a page that scrolls sideways, or a part
// of the pane cut off.
import { session, sleep } from "./harness.mjs";

const desk = await session(9366, { user: "dana", password: "dana-dev-password" });
const out = {};
const name = "task-manager-half";

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
await gone(["Get started", "Task Manager", "Event Viewer"]);
await desk.launch("task");
await gone(["Get started"]);
const manager = await window("Task Manager", ".list");
await desk.launch("event");
await sleep(2500);
if (!manager) {
    out.stopped = "no Task Manager window to attach to";
    await desk.finish(out, 1);
}

const press = (selector) =>
    manager
        .js(
            `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(manager, selector));
/** How wide the window is, and anything in it wider than its place. */
const fits = () =>
    manager.js(`(() => {
    const page = document.documentElement;
    const over = [...document.querySelectorAll(".details *, .list *, .bar *")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0)
        .map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
    const details = document.querySelector(".details");
    return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, pane: details ? Math.round(details.getBoundingClientRect().width) : null, over: [...new Set(over)].slice(0, 6) };
})()`);
const pick = async (label) => {
    const pid = await manager.js(
        `[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === ${JSON.stringify(label)})?.getAttribute("fx-value-pid") ?? null`,
    );
    if (pid) await press(`.entries button[fx-value-pid="${pid}"]`);
    await sleep(700);
};
const look = async (label) => {
    out[label] = await fits();
    await desk.picture(`${name}-${label}.png`);
};

await sleep(2500);
await pick("sshd");
await look("services");
await pick("peinit");
await look("protected");
await press(`.tab[fx-value-by="Person"]`);
await sleep(500);
await look("people");
await press(`.tab[fx-value-by="None"]`);
await sleep(500);
await look("none");
await gone(["Event Viewer"]);
await desk.finish(out);
