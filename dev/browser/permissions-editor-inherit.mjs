// The permissions editor's inheritance, Effective Access for someone typed,
// and the dialog at a narrow width, in headless Chromium, as dana, an
// administrator. Access inheritance is stopped (dropping what was
// inherited) and applied, then turned back on, which Gexora's copy of the
// parent's descriptor makes possible, and applied again.
//
//     node dev/browser/permissions-editor-inherit.mjs
import { guest, session, sleep } from "./harness.mjs";

const D = "S-1-5-21-1656784432-3555462761-4094152458";
const AT = "/srv/pe-check";
const out = {
    made: guest(`mkdir -p ${AT}/finance && sd set ${AT} 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)S:P(AU;OICIFA;0x10000;;;WD)' && \
        sd set ${AT}/finance 'O:${D}-1002G:BAD:(D;OICI;0x10156;;;${D}-1001)(A;OICI;0x1301bf;;;${D}-1002)(A;OICIIO;GA;;;CO)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)S:(ML;OICI;NW;;;ME)(AU;OICIIDFA;0x10000;;;WD)' >/dev/null && echo made`).trim(),
};
const desk = await session(9375, { user: "dana", password: "dana-dev-password" });
const pic = (name) => desk.picture(`permissions-editor-inherit-${name}.png`);
for (const id of await desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => s.dataset.id)`)) {
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch(`gexora ${AT}`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora" }, 1);

let editor;
async function open() {
    desk.surface = '.fx-surface[data-role="window"]';
    await desk.menuOn(gexora, `.entries [fx-value-name="finance"]`);
    await desk.choose("Permissions…");
    for (let i = 0; i < 40; i++) {
        editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
        if (editor) return;
        await sleep(300);
    }
    await desk.finish({ ...out, stopped: "no dialog" }, 1);
}
const press = async (selector) => {
    const there = await editor.js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.scrollIntoView({ block: "center" }); return !!e; })()`);
    if (!there) out.missed = [...(out.missed ?? []), selector];
    await sleep(200);
    await desk.press(editor, selector);
    await sleep(500);
};
const look = () => editor.js(`({
    banners: [...document.querySelectorAll(".inherit p, .banner p")].map((p) => p.textContent),
    links: [...document.querySelectorAll(".inherit button, .banner button")].map((b) => b.textContent + (b.disabled ? " (off)" : "")),
    listed: [...document.querySelectorAll(".who")].map((n) => n.querySelector(".name").textContent + (n.querySelector(".from") ? " " + n.querySelector(".from").textContent : "")),
})`);
const apply = async (name) => {
    await press(`footer [fx-click="apply"]`);
    await sleep(1500);
    out[name] = await editor.js(`({ status: document.querySelector("footer .status")?.textContent ?? null, trouble: document.querySelector(".trouble")?.textContent ?? null })`);
};
const dacl = () => guest(`sd show --sddl ${AT}/finance`).trim().split("\n")[1];

// Stopped, and what was inherited dropped.
await open();
out.opened = await look();
await press(`[fx-click="inherit-stop"][fx-value-v="access"]`);
out.asking = await look();
await pic("asking");
await press(`[fx-click="inherit-drop"][fx-value-v="access"]`);
out.stopped = await look();
await pic("stopped");
await apply("appliedStop");
out.afterStop = dacl();
await press(`footer [fx-click="cancel"]`);
await sleep(1000);

// Opened again, and inheriting again from what Gexora sent of the parent.
await open();
out.reopened = await look();
await press(`[fx-click="inherit-on"][fx-value-v="access"]`);
out.inheriting = await look();
await pic("inheriting");
await apply("appliedOn");
out.afterOn = dacl();

// Effective Access for someone typed by name.
await press(`.toptabs [fx-value-v="eff"]`);
await editor.js(`(() => { const f = document.querySelector('[name="eff.name"]'); f.value = "alice"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await sleep(400);
await press(`.eff-find button[type="submit"]`);
await sleep(1500);
out.effective = await editor.js(`({
    who: document.querySelector('[name="eff.who"]')?.selectedOptions[0]?.textContent,
    chips: document.querySelector(".capchips")?.innerText,
    note: document.querySelector(".capchips")?.previousElementSibling?.textContent,
})`);
await editor.js(`document.scrollingElement.scrollTop = 0`);
await pic("effective");

// A narrow screen: the dialog fits, and nothing makes it scroll sideways.
for (const width of [720, 480]) {
    await desk.a.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    await press(`.toptabs [fx-value-v="access"]`);
    await press(`.who[fx-value-sid="${D}-1001"]`);
    await editor.js(`document.scrollingElement.scrollTop = 0`);
    out[`narrow${width}`] = await editor.js(`({ inner: innerWidth, sideways: (() => { const s = document.scrollingElement; s.scrollLeft = 1000; const moved = s.scrollLeft; s.scrollLeft = 0; return moved; })(), over: [...document.querySelectorAll(".editor *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => e.tagName + "." + e.className) })`);
    await pic(`narrow-${width}`);
    await editor.js(`document.querySelector(".pane")?.scrollIntoView({ block: "start" })`);
    await pic(`narrow-${width}-pane`);
}
await desk.a.send("Emulation.clearDeviceMetricsOverride");
await press(`footer [fx-click="cancel"]`);
await desk.finish(out);
