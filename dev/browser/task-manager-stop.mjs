// Stopping a service or a job from Task Manager, and who is signed in, in
// headless Chromium (`node task-manager-stop.mjs`, then
// `node task-manager-stop.mjs alice`).
//
// A service, tmcheck2, runs `sleep 4200`, and a job runs `sleep 4300`, both
// set up from the console (see the end of this comment). As dana, an
// administrator: the service's process is its main process and offers Stop
// service, which peinit's own account of her rights says she may; stopping
// it stops the service. The job's process offers Stop job, likewise. Signed
// in lists the people signed in, and a session in full lists its processes.
// As alice: the service's process says she may not stop its service, and
// Signed in says she sees only her own sessions, and why.
//
//   svctl definition create tmcheck2 --set ImagePath=/usr/bin/sleep \
//       --set Arguments=4200 --set Type=Simple --set Readiness=Alive
//   svctl start tmcheck2
//   svctl --no-wait job submit --description "Task Manager check" /usr/bin/sleep 4300
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const pidOf = (arg) =>
    guest(
        `for p in /proc/[0-9]*; do [ "$(cat $p/cmdline 2>/dev/null | tr '\\0' ' ')" = "/usr/bin/sleep ${arg} " ] && echo \${p#/proc/}; done; true`,
    )
        .trim()
        .split("\n")[0];
const service = pidOf(4200);
const job = pidOf(4300);
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = { service, job };
const name = alice ? "task-manager-stop-alice" : "task-manager-stop";

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
if (!manager || !service || !job) {
    out.stopped = !manager
        ? "no Task Manager window to attach to"
        : "the test service or job isn't running";
    await desk.finish(out, 1);
}
const details = () =>
    manager.js(`document.querySelector(".details")?.innerText.replaceAll("\\n", " / ") ?? null`);
async function until(ready, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 300) {
        const now = await details();
        if (ready(now ?? "")) return now;
        await sleep(300);
    }
    return details();
}
const press = (selector) =>
    manager
        .js(
            `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(manager, selector));
const has = (selector) => manager.js(`!!document.querySelector(${JSON.stringify(selector)})`);
await sleep(2500);

await press(`.entries button[fx-value-pid="${service}"]`);
out.servicePicked = await until(
    (d) => d.includes(`Process ${service}`) && d.includes("Belongs to"),
);
await desk.picture(`${name}-service.png`);
out.stopServiceOffered = await has('.details button[fx-click="stop-service"]');
if (!alice && out.stopServiceOffered) {
    await press('.details button[fx-click="stop-service"]');
    out.asked = await until((d) => d.includes("stays stopped"));
    await press('.details button[fx-click="stop-service-confirm"]');
    out.said = await until((d) => d.includes("Asked peinit"));
    await sleep(2500);
    out.serviceAfter = guest("svctl status tmcheck2 | head -1").trim().split("\n")[0];
}

await press(`.entries button[fx-value-pid="${job}"]`);
out.jobPicked = await until((d) => d.includes(`Process ${job}`));
out.stopJobOffered = await has('.details button[fx-click="stop-job"]');
if (!alice && out.stopJobOffered) {
    await desk.picture(`${name}-job.png`);
    await press('.details button[fx-click="stop-job"]');
    await until((d) => d.includes("Everything in it ends"));
    await press('.details button[fx-click="stop-job-confirm"]');
    await until((d) => d.includes("Asked peinit"));
    await sleep(2500);
    out.jobAfter = guest("svctl job list | tail -n +2").trim();
}

// Who is signed in.
await press('.tab[fx-value-by="Signed in"]');
await sleep(1000);
out.signedIn = await manager.js(
    `[...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | "))`,
);
out.signedNote = await manager.js(
    `[...document.querySelectorAll(".said")].map((p) => p.textContent)`,
);
const first = await manager.js(
    `document.querySelector(".entries button")?.getAttribute("fx-value-id") ?? null`,
);
if (first) {
    await press(`.entries button[fx-value-id="${first}"]`);
    out.session = await until((d) => d.includes("Session"));
}
await desk.picture(`${name}-signed-in.png`);
await desk.finish(out);
