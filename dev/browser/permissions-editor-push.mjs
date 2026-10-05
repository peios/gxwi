// Pushing a folder's permissions into what is already inside it, in
// headless Chromium, as dana, an administrator: a change to what the folder
// passes down asks whether to update what is inside; updating walks it
// parents first, leaves a protected folder as it is, carries on past a file
// dana cannot read and says so; a second walk is stopped partway.
//
//     node dev/browser/permissions-editor-push.mjs
import { guest, session, sleep } from "./harness.mjs";

const D = "S-1-5-21-1656784432-3555462761-4094152458";
const AT = "/srv/pe-check";
const P = `${AT}/push`;
const out = {
    // nope.txt, which nobody here may read, outlives an earlier run.
    made: guest(`rm -rf ${P} 2>/dev/null; mkdir -p ${P} && sd set ${P} 'O:${D}-1002G:BAD:P(A;OICI;FA;;;BA)(A;OICI;FA;;;${D}-1002)(A;OICIIO;GA;;;CO)' >/dev/null && \
        mkdir -p ${P}/a/deep ${P}/locked ${P}/many && touch ${P}/a/deep/f.txt ${P}/b.txt ${P}/locked/in.txt && \
        sd set ${P}/locked 'O:BAG:BAD:P(A;OICI;FA;;;BA)(A;OICI;FA;;;${D}-1002)' >/dev/null && \
        { ls ${P} | grep -qx nope.txt || { touch ${P}/nope.txt && sd set ${P}/nope.txt 'O:SYG:SYD:(A;;FA;;;SY)' >/dev/null; }; } && echo made`).trim(),
};
// Enough files that the walk can be watched and stopped, made a share at a
// time: the guest answers a command within a minute or not at all.
for (let from = 0; from < 30000; from += 5000) {
    guest(`i=${from}; while [ $i -lt ${from + 5000} ]; do : > ${P}/many/f$i; i=$((i+1)); done`);
}
out.many = guest(`ls ${P}/many | wc -l`).trim();
const shown = (path) => guest(`sd show --sddl ${path} 2>&1 | tail -1`).trim();

const desk = await session(9378, { user: "dana", password: "dana-dev-password" });
const pic = (name) => desk.picture(`permissions-editor-push-${name}.png`);
for (const id of await desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => s.dataset.id)`)) {
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch(`gexora ${AT}`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora" }, 1);
desk.surface = '.fx-surface[data-role="window"]';
await desk.menuOn(gexora, `.entries [fx-value-name="push"]`);
await desk.choose("Permissions…");
let editor = null;
for (let i = 0; i < 40 && !editor; i++) {
    editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
    if (!editor) await sleep(300);
}
if (!editor) await desk.finish({ ...out, stopped: "no dialog" }, 1);
desk.surface = '.fx-surface[data-role="dialog"]';
const press = async (selector) => {
    const there = await editor.js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.scrollIntoView({ block: "center" }); return !!e; })()`);
    if (!there) out.missed = [...(out.missed ?? []), selector];
    await sleep(200);
    await desk.press(editor, selector);
    await sleep(500);
};
const state = () => editor.js(`({
    push: [...document.querySelectorAll(".inherit.push p, .inherit.warn p, .inherit.warn li")].map((p) => p.textContent).filter(Boolean),
    status: document.querySelector("footer .status")?.textContent ?? null,
    trouble: document.querySelector(".trouble")?.textContent ?? null,
})`);
const settled = async (limit = 120) => {
    for (let i = 0; i < limit; i++) {
        if (!(await editor.js(`!!document.querySelector('[fx-click="stop-push"]')`))) return true;
        await sleep(500);
    }
    return false;
};

// Authenticated Users may read the folder and everything in it.
await press(`[fx-click="add"]`);
await editor.js(`(() => { const f = document.querySelector('[name="who"]'); f.value = "Authenticated Users"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await sleep(400);
await press(`.naming button[type="submit"]`);
await press(`.tabs [fx-value-v="access"]`);
await press(`.rights [fx-value-mask="1179785"][fx-value-way="allow"]`);
await press(`footer [fx-click="ok"]`);
out.asked = await state();
await editor.js(`document.querySelector(".inherit.push")?.scrollIntoView({ block: "center" })`);
await pic("asking");
await press(`[fx-click="push"][fx-value-v="all"]`);
await sleep(1500);
out.during = await state();
await pic("progress");
out.settled = await settled();
out.after = await state();
await editor.js(`document.querySelector(".inherit.warn")?.scrollIntoView({ block: "center" })`);
await pic("summary");
out.dacls = Object.fromEntries(["push", "push/a", "push/a/deep", "push/a/deep/f.txt", "push/b.txt", "push/locked", "push/locked/in.txt", "push/many/f7"].map((p) => [p, shown(`${AT}/${p}`)]));

// Again, and stopped partway: take Read away and push that.
await press(`.who[fx-value-sid="S-1-5-11"]`);
await press(`.rights [fx-value-mask="1179785"][fx-value-way="allow"]`);
await press(`footer [fx-click="apply"]`);
// The walk is quick: Stop is pressed the moment it is there.
await desk.press(editor, `[fx-click="push"][fx-value-v="all"]`);
out.stopSeen = await editor.js(`new Promise((done) => {
    const began = Date.now();
    const look = () => {
        const stop = document.querySelector('[fx-click="stop-push"]:not([disabled])');
        if (stop) { const said = stop.closest(".inherit")?.innerText; stop.click(); return done(said); }
        if (Date.now() - began > 5000) return done(null);
        setTimeout(look, 5);
    };
    look();
})`);
await sleep(150);
await pic("stopping");
out.stopping = await state();
out.stopSettled = await settled();
out.stoppedAfter = await state();
await editor.js(`document.querySelector(".inherit.warn")?.scrollIntoView({ block: "center" })`);
await pic("stopped");
out.manyFirst = shown(`${P}/many/f0`);
out.manyLast = shown(`${P}/many/f9999`);
await press(`footer [fx-click="cancel"]`);
await desk.finish(out);
