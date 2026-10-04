// Task Manager's Performance view, in headless Chromium
// (`node task-manager-perf.mjs`, then `node task-manager-perf.mjs alice`).
//
// As dana, with the guest kept busy for a while (a loop on one processor,
// a disk read in full): every resource is listed down the side with a
// small graph; the CPU in full graphs the last two minutes, and each
// processor on its own when asked; memory says what it is made of; the
// disk graphs its active time and transfer rate; the network interface
// its throughput. As alice, who isn't an administrator, the view is the
// same: everything it reads is the kernel's, which anyone may read. At
// half a screen, the side narrows and the pane keeps its graphs.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "task-manager-perf-alice" : "task-manager-perf";

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
const press = (selector) => manager.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`).then(() => desk.press(manager, selector));
/** What the view shows: the side, the pane's heading, its figures and its graphs. */
const shows = () => manager.js(`({
    side: [...document.querySelectorAll(".resources .item")].map((b) => b.innerText.replaceAll("\\n", " | ") + (b.getAttribute("aria-pressed") === "true" ? " (shown)" : "")),
    heading: document.querySelector(".resource header")?.innerText.replaceAll("\\n", " | ") ?? null,
    facts: [...document.querySelectorAll(".resource .facts dt")].map((dt) => dt.textContent + ": " + dt.nextElementSibling?.textContent),
    graphs: [...document.querySelectorAll(".resource figure")].map((f) => (f.querySelector("figcaption")?.innerText.replaceAll("\\n", " | ") ?? "") + " — " + f.querySelectorAll("polyline").length + " lines, " + [...f.querySelectorAll("polyline")].reduce((n, p) => n + p.getAttribute("points").split(" ").length, 0) + " points"),
    legend: [...document.querySelectorAll(".resource .legend li")].map((li) => li.textContent),
    said: [...document.querySelectorAll(".resource .said")].map((p) => p.textContent),
})`);

// Keep the guest busy for a while: one processor looping, and, once the view
// is open, the disk read in full. Only the first run after a boot reaches the
// disk: the page cache answers any later one, and only SYSTEM may drop it.
guest(`(sh -c 'end=$(($(date +%s)+40)); while [ $(date +%s) -lt $end ]; do :; done' >/dev/null 2>&1 &); echo busy`);

await press('.tab[fx-value-by="Performance"]');
await sleep(10000);
guest(`(dd if=/dev/vda of=/dev/null bs=1M >/dev/null 2>&1 &); echo reading`);
// Long enough for a dozen looks.
await sleep(16000);
out.cpu = await shows();
await desk.picture(`${name}-cpu.png`);

await press('.tab[fx-value-by="each"]');
await sleep(2500);
out.eachCpu = (await shows()).graphs;
await desk.picture(`${name}-each.png`);
await press('.tab[fx-value-by="all"]');

await press('.item[fx-value-id="memory"]');
await sleep(2500);
out.memory = await shows();
await desk.picture(`${name}-memory.png`);

const disk = await manager.js(`document.querySelector('.item[fx-value-id^="disk:"]')?.getAttribute("fx-value-id") ?? null`);
if (disk) {
    await press(`.item[fx-value-id="${disk}"]`);
    await sleep(2500);
    out.disk = await shows();
    await desk.picture(`${name}-disk.png`);
}
const net = await manager.js(`document.querySelector('.item[fx-value-id^="net:"]')?.getAttribute("fx-value-id") ?? null`);
if (net) {
    await press(`.item[fx-value-id="${net}"]`);
    await sleep(2500);
    out.net = await shows();
    await desk.picture(`${name}-net.png`);
}

if (!alice) {
    // Half a screen: a second window tiles this one to half. Nothing in it
    // may be wider than its place.
    await desk.launch("event");
    await sleep(3000);
    await press('.item[fx-value-id="cpu"]');
    await sleep(2500);
    out.half = await manager.js(`(() => {
        const page = document.documentElement;
        const over = [...document.querySelectorAll(".resources *, .resource *, .bar *")]
            .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0)
            .map((e) => e.tagName.toLowerCase() + (e.className?.baseVal ?? e.className ? "." + String(e.className?.baseVal ?? e.className).split(" ")[0] : ""));
        return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, over: [...new Set(over)].slice(0, 6) };
    })()`);
    out.half.side = (await shows()).side;
    await desk.picture(`${name}-half.png`);
    await gone(["Event Viewer"]);
}

out.log = manager.log;
await desk.finish(out);
