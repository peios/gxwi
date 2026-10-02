// Services Manager follows the registry as it changes, in headless Chromium:
// as dana (`node service-watch.mjs`) or alice (`node service-watch.mjs alice`).
//
// watched, a service defined for the purpose, is picked, and its key's
// descriptor is changed from a terminal, back and forth, between one that
// lets nobody but SYSTEM change the definition and one that lets everyone.
// Only the registry says which, and peinit is not asked it, so how soon the
// details pane's button says "Edit definition…" or "Definition…" is how soon
// the window heard of the change. Each change is timed from when the
// terminal's command is sent, which is before the change is made, and the
// button is watched the while. The command takes half a second to a second
// to reach the guest and come back. Told of the change, the window has it
// a few tenths after it is made, so within about a second of sending, every
// time; reading the registry every two seconds, as the window did before it
// watched, some of six would take well over that.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { guest, session, sleep } from "./harness.mjs";

const send = (command) => promisify(execFile)(new URL("../guest.sh", import.meta.url).pathname, [command]);

const alice = process.argv[2] === "alice";
const desk = await session(alice ? 9368 : 9367, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = { trials: [] };
const key = "Machine\\System\\Services\\watched";
const closed = "D:P(A;;KA;;;SY)(A;;KR;;;BA)(A;;KR;;;AU)";
const open = "D:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;KA;;;AU)";

/** The windows on the desktop, by the title on their strips. */
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
async function until(ready, look, ms = 15000, every = 300) {
    for (let waited = 0; waited < ms; waited += every) {
        const now = await look();
        if (ready(now)) return now;
        await sleep(every);
    }
    return look();
}
async function close(titles) {
    for (const strip of await strips()) {
        if (!titles.includes(strip.title)) continue;
        const at = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
        if (at) await desk.pressAt(at);
        await sleep(800);
    }
}

out.defined = guest(
    `svctl definition delete watched >/dev/null 2>&1; sleep 3; svctl definition create watched --set ImagePath=/usr/bin/true --set Type=Oneshot ` +
        `--set 'DisplayName=Watched one' 2>&1; reg sd '${key}' --dacl --set '${closed}' 2>&1; reg sd '${key}' 2>&1`,
).split("\n");

// A window left from an earlier run may be an older program.
await close(["Get started", "Services Manager"]);
await desk.launch("services");
await close(["Get started"]);
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
const id = await until((found) => found, () => manager.js(`[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === "Watched one")?.id ?? null`));
for (let tries = 0; tries < 3; tries++) {
    await manager.js(`document.getElementById(${JSON.stringify(id)})?.scrollIntoView({ block: "center" })`);
    await desk.press(manager, `#${id}`);
    if ((await until((title) => title === "Watched one", () => manager.js(`document.querySelector(".details h2")?.textContent`), 4000)) === "Watched one") break;
}
const label = () => manager.js(`document.querySelector(".details .open")?.textContent ?? null`);
out.before = await until((said) => said === "Definition…", label);

// Back and forth, three times each way.
for (let trial = 0; trial < 6; trial++) {
    const want = trial % 2 === 0 ? "Edit definition…" : "Definition…";
    const sent = Date.now();
    let returned = null;
    const sending = send(`reg sd '${key}' --dacl --set '${trial % 2 === 0 ? open : closed}' >/dev/null 2>&1`).then(() => (returned = Date.now() - sent));
    const said = await until((said) => said === want, label, 6000, 25);
    const seen = Date.now() - sent;
    await sending;
    out.trials.push({ want, said, seen, returned });
    await sleep(1500);
}
out.slowest = Math.max(...out.trials.map((trial) => (trial.said === trial.want ? trial.seen : Infinity)));
await desk.picture(alice ? "watch-alice.png" : "watch.png");
// Opened again first: closed, it lets nobody delete it but SYSTEM.
out.after = guest(`reg sd '${key}' --dacl --set '${open}' >/dev/null 2>&1; svctl definition delete watched 2>&1`).split("\n")[0];
await desk.finish(out);
