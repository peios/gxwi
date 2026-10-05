// The permissions editor's last pieces, in headless Chromium, as dana, an
// administrator:
//
// - the whole descriptor edited as SDDL text and applied, with libpeios
//   reading the text back, alarm entry and all (PEI-1391);
// - text libpeios can't read, said entry by entry;
// - an access list entry dragged to the top;
// - an eventd pattern opened from Event Viewer, a rule for one of its fields
//   made in Specific Rights, and another field named by typing it.
//
//     node dev/browser/permissions-editor-text.mjs
import { guest, session, sleep } from "./harness.mjs";

const D = "S-1-5-21-1656784432-3555462761-4094152458";
const AT = "/srv/pe-check";
const out = {
    // The events pattern this check adds, gone from any run before.
    unmade: guest(`reg del -r 'Machine\\System\\eventd\\Security\\Events\\pe-check' 2>&1 | tail -1`).trim(),
    made: guest(`mkdir -p ${AT}/text && sd set ${AT}/text 'O:${D}-1002G:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)(A;OICI;0x1301bf;;;${D}-1002)S:(AL;OICISA;0x10000;;;WD)(AU;OICIFA;0x10156;;;WD)' >/dev/null && echo made`).trim(),
};
const desk = await session(9374, { user: "dana", password: "dana-dev-password" });
const pic = (name) => desk.picture(`permissions-editor-text-${name}.png`);
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => s.dataset.id)`);
for (const id of await strips()) {
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch(`gexora ${AT}`);
let gexora = null;
for (let i = 0; i < 40 && !gexora; i++) {
    gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
    if (!gexora) await sleep(300);
}
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora" }, 1);

async function dialog() {
    for (let i = 0; i < 40; i++) {
        const editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
        if (editor) return editor;
        await sleep(300);
    }
    return null;
}
async function open() {
    desk.surface = '.fx-surface[data-role="window"]';
    await desk.menuOn(gexora, `.entries [fx-value-name="text"]`);
    await desk.choose("Permissions…");
    return (await dialog()) ?? desk.finish({ ...out, stopped: "no dialog" }, 1);
}

let editor = await open();
const press = async (selector) => {
    const there = await editor.js(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return false;
        e.scrollIntoView({ block: "center" });
        return true;
    })()`);
    if (!there) out.missed = [...(out.missed ?? []), selector];
    await sleep(200);
    await desk.press(editor, selector);
    await sleep(600);
};
const set = async (selector, value) => {
    const said = await editor.js(`(() => {
        const f = document.querySelector(${JSON.stringify(selector)});
        if (!f) return false;
        if (f.type === "checkbox") { f.checked = ${JSON.stringify(Boolean(value))}; f.dispatchEvent(new Event("change", { bubbles: true })); }
        else { f.focus(); f.value = ${JSON.stringify(String(value))}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); }
        return f.name;
    })()`);
    if (!said) out.missed = [...(out.missed ?? []), selector];
    await sleep(600);
};

// ---- the descriptor as text

await set(`input[name="advmode"]`, true);
await press(`.toptabs [fx-value-v="desc"]`);
await press(`[fx-click="x-text"]`);
const text = await editor.js(`document.querySelector('textarea[name="x.sddl"]')?.value ?? null`);
out.textAsShown = text;
await pic("editing");
// Wrong first: an entry libpeios has no code for.
await set(`textarea[name="x.sddl"]`, text.replace("(A;OICI;0x1200a9;;;AU)", "(QQ;OICI;0x1200a9;;;AU)"));
await press(`[fx-click="x-text-use"]`);
out.wrong = await editor.js(`document.querySelector(".fld .wrong")?.textContent ?? null`);
await pic("wrong");
// Then right: Authenticated Users down to Read, and a refusal for alice
// written in at the top.
const edited = text.replace("(A;OICI;0x1200a9;;;AU)", "(A;OICI;0x120089;;;AU)").replace("D:P\n", `D:P\n  (D;OICI;0x10000;;;${D}-1001)\n`);
out.edited = edited;
await set(`textarea[name="x.sddl"]`, edited);
await press(`[fx-click="x-text-use"]`);
out.afterUse = await editor.js(`({
    status: document.querySelector(".status")?.textContent ?? null,
    sddl: document.querySelector("pre.sddl")?.textContent ?? null,
    wrong: document.querySelector(".fld .wrong")?.textContent ?? null,
})`);
await pic("used");

// ---- an entry dragged

await press(`.toptabs [fx-value-v="dacl"]`);
const ids = await editor.js(`[...document.querySelectorAll(".xlist > li[fx-drag]")].map((li) => li.id)`);
out.orderBefore = await editor.js(`[...document.querySelectorAll(".xlist > li .xw")].map((w) => w.textContent)`);
const [from, to] = [await desk.middle(editor, `#${ids.at(-1)} .xn`), await desk.middle(editor, `#${ids[0]} .xn`)];
const letGo = await desk.drag(from, { x: to.x, y: to.y - 4 });
await pic("dragging");
await letGo();
out.orderAfter = await editor.js(`[...document.querySelectorAll(".xlist > li .xw")].map((w) => w.textContent)`);
await pic("dragged");

// Applied, then read back.
await press(`footer [fx-click="apply"]`);
// What the folder passes down changed, so it asks about what is inside.
out.asked = await editor.js(`document.querySelector(".ask")?.closest(".banner, .push, div")?.innerText ?? null`);
await pic("asked");
await press(`[fx-click="push"][fx-value-v="here"]`);
await sleep(1500);
out.status = await editor.js(`document.querySelector(".status")?.textContent ?? null`);
out.onDisk = guest(`sd show --sddl ${AT}/text 2>&1`).trim();
await press(`footer [fx-click="cancel"]`);
await sleep(1000);

// ---- eventd's fields, from Event Viewer

await desk.launch("event");
const titled = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
let viewer = null;
for (let i = 0; i < 40 && !viewer; i++) {
    const ours = (await titled()).filter((strip) => strip.title.startsWith("Event Viewer"));
    if (ours.length) {
        viewer = (await desk.frames("form.filters"))[0] ?? null;
        if (viewer) viewer.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
    }
    await sleep(300);
}
if (!viewer) await desk.finish({ ...out, stopped: "no Event Viewer" }, 1);
await desk.press(viewer, '.tab[fx-value-kind="settings"]');
await sleep(1500);
out.patternBefore = await viewer.js(`[...document.querySelectorAll(".pattern")].map((p) => p.querySelector(".covers").textContent).filter((c) => c.includes("pe-check"))`);
if (!out.patternBefore.length) {
    await viewer.js(`document.querySelector("input[name='add-events']").scrollIntoView({ block: "center" })`);
    await sleep(300);
    await desk.press(viewer, "input[name='add-events']");
    await desk.type("pe-check");
    await desk.key("Enter", { vk: 13 }, "\r");
} else {
    await viewer.js(`document.querySelector('[fx-click="policy-edit"][fx-value-pattern="pe-check"]').scrollIntoView({ block: "center" })`);
    await sleep(300);
    await desk.press(viewer, '[fx-click="policy-edit"][fx-value-pattern="pe-check"]');
}
editor = await dialog();
if (!editor) await desk.finish({ ...out, stopped: "no dialog from Event Viewer" }, 1);
await press(`.who[fx-value-sid="S-1-5-11"]`);
await press(`.tabs [fx-value-v="specific"]`);
await press(`[fx-click="r-new"]`);
out.specific = await editor.js(`({
    chips: [...document.querySelectorAll(".chips .chip")].map((c) => c.textContent),
    rights: [...document.querySelectorAll(".rule .rights tbody th")].map((th) => th.textContent),
    named: document.querySelector('input[name$=".named"]')?.placeholder ?? null,
})`);
const named = await editor.js(`document.querySelector('input[name$=".named"]')?.name`);
await set(`input[name="${named}"]`, "source.name");
await press(`[fx-click="r-named"]`);
out.specificAfter = await editor.js(`[...document.querySelectorAll(".chips .chip")].map((c) => c.textContent)`);
await pic("fields");
await press(`footer .primary`);
await sleep(2000);
out.grants = await viewer.js(`[...document.querySelectorAll(".pattern")].filter((p) => p.querySelector(".covers").textContent.includes("pe-check")).map((p) => [...p.querySelectorAll(".grants li")].map((l) => l.textContent).join("; "))`);
await viewer.js(`[...document.querySelectorAll(".pattern")].find((p) => p.querySelector(".covers").textContent.includes("pe-check"))?.scrollIntoView({ block: "center" })`);
await sleep(500);
await pic("fields-granted");
await desk.finish(out);
