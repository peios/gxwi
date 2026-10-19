// Signing a session out from Task Manager, in headless Chromium
// (`node task-manager-signout.mjs`, `… alice`, then `… stubborn`).
//
// As dana, an administrator, with alice signed in on the desktop too:
// Signed in lists alice's session; picked, it offers Sign out, which authd
// says dana may; signing her out ends every process of that session, and the
// kernel's list no longer has it. As alice: Signed in lists only her own
// session, which offers Sign out.
//
// Stubborn: alice signs in over SSH instead, leaving a process that ignores
// SIGTERM and SIGHUP in sshd's cgroup, where no job's ending takes it with
// it. authd ends it only after its grace period, and the window waits those
// seconds for the answer and says what came of it. (On the desktop the grace
// period is never reached: the session job's cgroup goes with the
// compositor.) Needs /tmp/pw on the guest, printing alice's password.
import { guest, session, sleep } from "./harness.mjs";

const asAlice = process.argv[2] === "alice";
const stubborn = process.argv[2] === "stubborn";
const out = {};
const name = asAlice
    ? "task-manager-signout-alice"
    : stubborn
      ? "task-manager-signout-stubborn"
      : "task-manager-signout";

// alice signs in first, so that dana has a session of hers to end.
const alice = asAlice || stubborn ? null : await session(9367);
if (stubborn) {
    out.ssh = guest(
        `SSH_ASKPASS=/tmp/pw SSH_ASKPASS_REQUIRE=force DISPLAY=x ssh -o StrictHostKeyChecking=no -o PubkeyAuthentication=no alice@127.0.0.1 'sh -c "trap \\"\\" TERM HUP; exec sleep 600" </dev/null >/dev/null 2>&1 & echo started' </dev/null 2>&1 | tail -1`,
    ).trim();
}
const desk = asAlice
    ? await session(9367)
    : await session(9366, { user: "dana", password: "dana-dev-password" });
// alice's shell on the desktop, or her stubborn process over SSH, and dana's.
const aliceSession = () =>
    guest(
        `for p in /proc/[0-9]*; do case "$(cat $p/comm 2>/dev/null)" in fenesh|sleep) grep -q "SigIgn:.*4007" $p/status || [ "$(cat $p/comm)" = fenesh ] && /tmp/tokcheck \${p#/proc/};; esac; done; true`,
    );

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
    alice?.close();
    await desk.finish(out, 1);
}
const details = () =>
    manager.js(`document.querySelector(".details")?.innerText.replaceAll("\\n", " / ") ?? null`);
const press = (selector) =>
    manager
        .js(
            `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(manager, selector));
const rowOf = (who) =>
    manager.js(
        `[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === ${JSON.stringify(who)})?.getAttribute("fx-value-id") ?? null`,
    );
await sleep(2500);
await press('.tab[fx-value-by="Signed in"]');
await sleep(2000);
out.signedIn = await manager.js(
    `[...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | "))`,
);

if (asAlice) {
    const own = await rowOf("alice");
    if (own) {
        await press(`.entries button[fx-value-id="${own}"]`);
        await sleep(1500);
        out.own = await details();
    }
    const peios = await rowOf("peios");
    out.peiosListed = !!peios;
    await desk.picture(`${name}.png`);
    await desk.finish(out);
}

out.aliceBefore = aliceSession();
const id = await rowOf("alice");
if (!id) {
    out.stopped = "alice isn't listed as signed in";
    alice?.close();
    await desk.finish(out, 1);
}
await press(`.entries button[fx-value-id="${id}"]`);
await sleep(1500);
out.picked = await details();
await desk.picture(`${name}-picked.png`);
await press('.details button[fx-click="sign-out"]');
await sleep(600);
out.asked = await details();
const pressed = Date.now();
await press('.details button[fx-click="sign-out-confirm"]');
// The answer comes when authd has ended the session, after its grace
// period for a process that ignores being asked.
for (let i = 0; i < 40; i++) {
    out.said = await details();
    if (out.said?.includes("ended") || out.said?.includes("couldn't")) break;
    await sleep(500);
}
out.answeredAfterMs = Date.now() - pressed;
await desk.picture(`${name}-done.png`);
await sleep(3000);
out.aliceAfter = aliceSession();
out.listedAfter = guest(
    `cat /sys/kernel/security/kacs/sessions | while read a b c; do case "$a" in *=${id}) echo still listed;; esac; done; echo checked`,
).trim();
alice?.close();
await desk.finish(out);
