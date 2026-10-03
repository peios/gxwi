// Frames of Event Viewer's Metrics tab as the charts move
// (`node event-viewer-metrics-film.mjs FRAMES SECONDS`): eventd's health
// over the last 15 minutes, as dana, a picture every SECONDS. A load to
// move them is the dev VM's flood service, started in bursts (see
// ../../target/vmshare/wave.sh when one was made). Frames are written to
// film/NNN.png beside this script.
import { mkdirSync } from "node:fs";
import { guest, session, sleep } from "./harness.mjs";

const frames = Number(process.argv[2] ?? 48);
const every = Number(process.argv[3] ?? 10) * 1000;
guest(`for k in $(reg ls Users); do reg del "Users\\\\\${k%/}\\\\Software\\\\gxwi-event-viewer" Dashboards >/dev/null 2>&1; done`);
const desk = await session(9368, { user: "dana", password: "dana-dev-password" });
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
for (const strip of await strips()) {
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch("event");
let viewer = null;
for (let i = 0; i < 40 && !viewer; i++) {
    const ours = (await strips()).filter((strip) => strip.title.startsWith("Event Viewer"));
    if (ours.length) {
        viewer = (await desk.frames("form.filters"))[0] ?? null;
        if (viewer) viewer.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
    }
    await sleep(300);
}
await desk.press(viewer, '.tab[fx-value-kind="metrics"]');
await sleep(1500);
await viewer.js(`(() => { const s = document.querySelector("select[name=span]"); s.value = "15m"; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(4000);
mkdirSync(new URL("film/", import.meta.url), { recursive: true });
for (let frame = 0; frame < frames; frame++) {
    await desk.picture(`film/${String(frame).padStart(3, "0")}.png`);
    await sleep(every);
}
await desk.finish({ frames });
