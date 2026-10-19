// Ending a process from Task Manager, in headless Chromium
// (`node task-manager-end.mjs`, then `node task-manager-end.mjs alice`).
//
// Two processes are started as the console's administrator, peios: a plain
// `sleep`, and a shell that ignores being asked to end. As dana, an
// administrator, the sleep is ended after asking; the shell is asked, stays,
// and after a few seconds is offered "End it now", which ends it at once.
// As alice, who isn't an administrator, a process of peios's offers no End,
// and says why.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
guest(
    `for p in /proc/[0-9]*; do case "$(cat $p/cmdline 2>/dev/null | tr '\\0' ' ')" in *"sleep 4101"*|*"sleep 4102"*) kill -9 \${p#/proc/};; esac; done; echo ok`,
);
// A subshell's background outlives the command; there is no setsid. The
// shell execs its last command, and an ignored signal stays ignored across
// exec, so the second sleep ignores being asked to end.
guest(
    `(sleep 4101 >/dev/null 2>&1 &); (sh -c 'trap "" TERM; sleep 4102' >/dev/null 2>&1 &); echo started`,
);
const pids = guest(
    `sleep 1; for p in /proc/[0-9]*; do c=$(cat $p/cmdline 2>/dev/null | tr '\\0' ' '); case "$c" in "sleep 4101 ") echo plain \${p#/proc/};; "sleep 4102 ") echo stubborn \${p#/proc/};; esac; done`,
);
const plain = pids.match(/plain (\d+)/)?.[1];
const stubborn = pids.match(/stubborn (\d+)/)?.[1];
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = { plain, stubborn };
const name = alice ? "task-manager-end-alice" : "task-manager-end";

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
if (!manager || !plain || !stubborn) {
    out.stopped = !manager
        ? "no Task Manager window to attach to"
        : "the test processes didn't start";
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
const alive = (pid) =>
    guest(`[ -e /proc/${pid} ] && echo alive || echo gone`).trim().split("\n")[0];
await sleep(2500);

await press(`.entries button[fx-value-pid="${plain}"]`);
out.picked = await until((d) => d.includes(`Process ${plain}`));
if (alice) {
    await desk.picture(`${name}-refused.png`);
    out.offered = await manager.js(`!!document.querySelector('.details button[fx-click="end"]')`);
    await desk.finish(out);
}

await press(`.details button[fx-click="end"]`);
out.asked = await until((d) => d.includes("Anything it hasn't saved is lost"));
await desk.picture(`${name}-asking.png`);
await press(`.details button[fx-click="end-confirm"]`);
await sleep(1500);
out.plainAfter = alive(plain);

await press(`.entries button[fx-value-pid="${stubborn}"]`);
await until((d) => d.includes(`Process ${stubborn}`));
await press(`.details button[fx-click="end"]`);
await until((d) => d.includes("Anything it hasn't saved is lost"));
await press(`.details button[fx-click="end-confirm"]`);
out.stubbornAsked = alive(stubborn);
out.offeredNow = await until((d) => d.includes("End it now"), 15000);
await desk.picture(`${name}-stubborn.png`);
await press(`.details button[fx-click="end-now"]`);
await sleep(1500);
out.stubbornAfter = alive(stubborn);
out.said = await details();
await desk.finish(out);
