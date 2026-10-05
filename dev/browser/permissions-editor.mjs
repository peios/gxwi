// The permissions editor on a folder with a full descriptor, in headless
// Chromium, as dana, an administrator: every tab of the simple view, the
// owner dropdown, Advanced mode's lists and descriptor, and a change applied
// and read back from the folder.
//
//     node dev/browser/permissions-editor.mjs [light]
import { guest, session, sleep } from "./harness.mjs";

const light = process.argv.includes("light");
const D = "S-1-5-21-1656784432-3555462761-4094152458";
const AT = "/srv/pe-check";
const out = {
    made: guest(`mkdir -p ${AT}/finance && sd set ${AT} 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)S:P(AU;OICIFA;0x10000;;;WD)' && \
        sd set ${AT}/finance 'O:${D}-1002G:BAD:(D;OICI;0x10156;;;${D}-1001)(A;OICI;0x1301bf;;;${D}-1002)(XA;OICI;0x1200a9;;;AU;(@User.Department == "Finance"))(A;OICIIO;GA;;;CO)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)S:(ML;OICI;NW;;;ME)(AU;OICISAFA;0x120089;;;${D}-1001)(RA;OICI;;;;WD;("Classification",TS,0x0,"Confidential"))(AU;OICIIDFA;0x10000;;;WD)' >/dev/null && echo made`).trim(),
};
const desk = await session(light ? 9372 : 9371, { user: "dana", password: "dana-dev-password" });
if (light) await desk.a.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
const pic = (name) => desk.picture(`permissions-editor-${light ? "light-" : ""}${name}.png`);
// A first sign-in brings Get started, and an earlier run may leave Gexora:
// they go, so the dialog comes over a desktop with one window.
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
for (const strip of await strips()) {
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch(`gexora ${AT}`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora" }, 1);
desk.surface = '.fx-surface[data-role="window"]';
await desk.menuOn(gexora, `.entries [fx-value-name="finance"]`);
await desk.choose("Permissions…");
let editor = null;
for (let i = 0; i < 40 && !editor; i++) {
    editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
    if (!editor) await sleep(300);
}
if (!editor) await desk.finish({ ...out, stopped: "no dialog", trouble: await gexora.js(`document.querySelector(".trouble")?.textContent ?? null`) }, 1);
desk.surface = '.fx-surface[data-role="dialog"]';
const look = () => editor.js(`({
    tabs: [...document.querySelectorAll(".toptabs [role=tab]")].map((t) => t.textContent),
    banners: [...document.querySelectorAll(".inherit p")].map((p) => p.textContent),
    listed: [...document.querySelectorAll(".who .name")].map((n) => n.textContent),
    caption: document.querySelector(".caption")?.textContent ?? null,
    trouble: document.querySelector(".trouble")?.textContent ?? null,
    status: document.querySelector("footer .status")?.textContent ?? null,
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
})`);
// The dialog may be taller than the screen: what is pressed is scrolled
// into sight first, as a person would.
const press = async (selector) => {
    const there = await editor.js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.scrollIntoView({ block: "center" }); return !!e; })()`);
    if (!there) out.missed = [...(out.missed ?? []), selector];
    await sleep(200);
    await desk.press(editor, selector);
    await sleep(500);
};
const top = () => editor.js(`document.scrollingElement.scrollTop = 0`);
out.opened = await look();
await top();
await pic("open");
await press(`.who[fx-value-sid="S-1-5-11"]`);
await press(`.tabs [fx-value-v="cond"]`);
out.cond = await editor.js(`document.querySelector(".pane")?.innerText`);
await pic("conditionals");
await press(`.ownerbtn`);
out.owners = await editor.js(`document.querySelector(".owners")?.innerText`);
await top();
await pic("owner");
await press(`.owners [fx-click="keep"]`);
await press(`.toptabs [fx-value-v="claims"]`);
out.claims = await editor.js(`document.querySelector(".editor")?.innerText.slice(0, 600)`);
await top();
await pic("claims");
await press(`.toptabs [fx-value-v="eff"]`);
await sleep(1500);
out.effective = await editor.js(`document.querySelector(".capchips")?.innerText ?? document.querySelector(".editor")?.innerText.slice(0, 800)`);
await top();
await pic("effective");
await press(`.advswitch input`);
out.advanced = await editor.js(`[...document.querySelectorAll(".xrow")].map((r) => r.innerText.replace(/\\n/g, " | "))`);
await top();
await pic("advanced-dacl");
await press(`.toptabs [fx-value-v="sacl"]`);
out.sacl = await editor.js(`[...document.querySelectorAll(".xrow")].map((r) => r.innerText.replace(/\\n/g, " | "))`);
await top();
await pic("advanced-sacl");
await press(`.toptabs [fx-value-v="desc"]`);
out.sddl = await editor.js(`document.querySelector("pre.sddl")?.textContent`);
await top();
await pic("advanced-descriptor");
await press(`.advswitch input`);
// Give dana Full control, and apply it.
await press(`.toptabs [fx-value-v="access"]`);
await press(`.who[fx-value-sid="${D}-1002"]`);
await press(`.tabs [fx-value-v="access"]`);
await press(`.rights [fx-value-mask="2032127"][fx-value-way="allow"]`);
await press(`footer [fx-click="apply"]`);
await sleep(1500);
out.applied = await look();
out.after = guest(`sd show ${AT}/finance | sed -n '/DACL/,/SACL/p'`);
await pic("applied");
await press(`footer [fx-click="cancel"]`);
await desk.finish(out);
