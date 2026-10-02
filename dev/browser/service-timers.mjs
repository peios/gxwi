// Services Manager's timers, in headless Chromium, as dana, an administrator
// (`node service-timers.mjs`): tidy, a Oneshot defined for the purpose, has
// a timer every two minutes with forty seconds of jitter, and one that never
// comes round (`*-02-30`).
// - svctl status and list say when each fires, and why the other does not.
// - The list's Next run column has tidy's soonest firing; the details pane
//   has both timers, the first with its next run and its random delay, the
//   second saying why it never runs.
// - Once it has fired, its last run is there too.
// tidy is deleted after.
import { guest, session, sleep } from "./harness.mjs";

const desk = await session(9367, { user: "dana", password: "dana-dev-password" });
const out = {};

/** The windows on the desktop, by the title on their strips. */
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
async function until(ready, look, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 300) {
        const now = await look();
        if (ready(now)) return now;
        await sleep(300);
    }
    return look();
}
/** Presses `selector` in `frame`, scrolled into sight, until `then` holds. */
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

// tidy, defined from a terminal.
out.defined = guest(
    `svctl definition delete tidy >/dev/null 2>&1; sleep 3; svctl definition create tidy --set ImagePath=/usr/bin/true --set Type=Oneshot ` +
        `--set 'DisplayName=Tidy temporary files' --set 'Triggers=timer:*-*-* *:0/2:00' --set 'Triggers=timer:*-02-30 00:00:00' ` +
        `--set TimerJitter=40 2>&1; sleep 4; svctl status tidy 2>&1; svctl list 2>&1 | grep -E 'NEXT TIMER|tidy'`,
).split("\n");

await getStartedGoes();
await desk.launch("services");
await getStartedGoes();
// The window, with the surface its presses land on.
let manager = null;
for (let i = 0; i < 40 && !manager; i++) {
    const strip = (await strips()).find((strip) => strip.title === "Services Manager");
    for (const frame of strip ? await desk.frames("input[name=find]") : []) {
        frame.surface = `.fx-surface[data-id="${strip.id}"]`;
        manager = frame;
    }
    if (!manager) await sleep(300);
}
if (!manager) await desk.finish({ ...out, stopped: "no Services Manager window" }, 1);
await until((rows) => rows > 0, () => manager.js(`document.querySelectorAll(".entries button").length`));
const row = () => manager.js(`(() => { const b = [...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === "Tidy temporary files"); return b ? { id: b.id, state: b.querySelector(".state").textContent, next: b.querySelector(".next")?.textContent ?? null } : null; })()`);
const tidy = await until((found) => found?.next, row);
out.row = tidy;
out.head = await manager.js(`[...document.querySelectorAll(".head span")].map((s) => s.textContent)`);
await press(manager, `#${tidy.id}`, async () => (await manager.js(`document.querySelector(".details h2")?.textContent`)) === "Tidy temporary files");
const timers = () => manager.js(`[...document.querySelectorAll(".details .timer")].map((t) => t.innerText.replace(/\\n+/g, " | "))`);
out.timers = await until((said) => said.length === 2, timers);
await manager.js(`document.querySelector(".details .timers")?.scrollIntoView({ block: "center" })`);
await desk.picture("timers-details.png");

// It fires within two minutes and its delay: then it says when it last ran,
// and the next run is another.
out.fired = await until((said) => said.length === 2 && !said[0].includes("Not since"), timers, 200000);
out.rowAfter = await row();
await manager.js(`document.querySelector(".details .timers")?.scrollIntoView({ block: "center" })`);
await desk.picture("timers-fired.png");
out.after = guest(`svctl status tidy 2>&1 | sed -n '1p;/^cause/p;/timers:/,$p'; svctl definition delete tidy 2>&1`).split("\n");
await desk.finish(out);
