// The permissions editor's SACL and conditions, applied for real, in
// headless Chromium, as dana, an administrator: a resource claim added, an
// auditing rule for Authenticated Users, a continuous-auditing (alarm) entry
// made in Advanced mode, a conditional rule for alice, and Alt with ↑ or ↓
// moving an entry. All of it is applied, then the folder is opened again and
// read back through the editor: `sd show` reads the label, not the raw SACL.
//
//     node dev/browser/permissions-editor-sacl.mjs
import { guest, session, sleep } from "./harness.mjs";

const D = "S-1-5-21-1656784432-3555462761-4094152458";
const AT = "/srv/pe-check";
const out = {
    made: guest(`mkdir -p ${AT}/finance && sd set ${AT} 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)S:P(AU;OICIFA;0x10000;;;WD)' && \
        sd set ${AT}/finance 'O:${D}-1002G:BAD:(D;OICI;0x10156;;;${D}-1001)(A;OICI;0x1301bf;;;${D}-1002)(XA;OICI;0x1200a9;;;AU;(@User.Department == "Finance"))(A;OICIIO;GA;;;CO)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)S:(ML;OICI;NW;;;ME)(AU;OICISAFA;0x120089;;;${D}-1001)(RA;OICI;;;;WD;("Classification",TS,0x0,"Confidential"))(AU;OICIIDFA;0x10000;;;WD)' >/dev/null && echo made`).trim(),
    learnedBefore: guest(`reg get 'Machine\\Common\\SecurityDescriptorBuilder' UsedClaims 2>&1`).trim(),
};
const desk = await session(9374, { user: "dana", password: "dana-dev-password" });
const pic = (name) => desk.picture(`permissions-editor-sacl-${name}.png`);
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => s.dataset.id)`);
for (const id of await strips()) {
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch(`gexora ${AT}`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora" }, 1);

async function open() {
    desk.surface = '.fx-surface[data-role="window"]';
    await desk.menuOn(gexora, `.entries [fx-value-name="finance"]`);
    await desk.choose("Permissions…");
    for (let i = 0; i < 40; i++) {
        const editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
        if (editor) return editor;
        await sleep(300);
    }
    await desk.finish({ ...out, stopped: "no dialog" }, 1);
}

let editor = await open();
// What is pressed is scrolled into sight first, as a person would. `pick`
// is an expression for the element, for one no selector says alone.
const press = async (selector, pick) => {
    const there = await editor.js(`(() => {
        document.querySelectorAll("[data-t]").forEach((e) => e.removeAttribute("data-t"));
        const e = ${pick ?? `document.querySelector(${JSON.stringify(selector)})`};
        if (!e) return false;
        e.setAttribute("data-t", "");
        e.scrollIntoView({ block: "center" });
        return true;
    })()`);
    if (!there) out.missed = [...(out.missed ?? []), selector];
    await sleep(200);
    await desk.press(editor, "[data-t]");
    await sleep(500);
};
// A field changed as typing or choosing changes it: the page hears an input
// event for text, a change for a box or a list.
const set = async (pick, value) => {
    const said = await editor.js(`(() => {
        const f = ${pick};
        if (!f) return false;
        if (f.type === "checkbox") { f.checked = ${JSON.stringify(Boolean(value))}; f.dispatchEvent(new Event("change", { bubbles: true })); }
        else if (f.tagName === "SELECT") { f.value = ${JSON.stringify(String(value))}; f.dispatchEvent(new Event("change", { bubbles: true })); }
        else { f.focus(); f.value = ${JSON.stringify(String(value))}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); f.blur(); }
        return f.name;
    })()`);
    if (!said) out.missed = [...(out.missed ?? []), pick];
    await sleep(500);
    return said;
};
const last = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].at(-1)`;

// A resource claim.
await press(`.toptabs [fx-value-v="claims"]`);
await press(`[fx-click="cl-new"]`);
out.claimName = await set(last(`input[name^="cl."][name$=".name"]`), "Project");
await set(last(`input[name^="cl."][name$=".vals"]`), "Apollo, Gemini");
await editor.js(`document.scrollingElement.scrollTop = 0`);
await pic("claim");

// Failures by Authenticated Users recorded.
await press(`.toptabs [fx-value-v="access"]`);
await press(`.who[fx-value-sid="S-1-5-11"]`);
await press(`.tabs [fx-value-v="audit"]`);
await press(`[fx-click="a-new"]`);
await press(`a-tick`, `${last(".pane .rule:not(.inh)")}?.querySelector('[fx-click="a-tick"][fx-value-way="fail"]:not([disabled])')`);
await pic("audit");

// alice may read, but only from Engineering.
await press(`.who[fx-value-sid="${D}-1001"]`);
await press(`.tabs [fx-value-v="cond"]`);
await press(`[fx-click="c-new"]`);
await set(last(`.pane .rule:not(.inh) input[name^="c."][name$=".name"]`), "Department");
await set(last(`.pane .rule:not(.inh) input[name^="c."][name$=".val"]`), "Engineering");
await press(`ctick`, `${last(".pane .rule:not(.inh)")}?.querySelector('[fx-click="ctick"][fx-value-way="allow"]:not([disabled])')`);
out.cond = await editor.js(`${last(".pane .rule:not(.inh)")}?.innerText`);
await pic("condition");

// Advanced mode: Alt with ↓ then ↑ moves the first entry and back.
await press(`.advswitch input`);
await press(`.toptabs [fx-value-v="dacl"]`);
const order = () => editor.js(`[...document.querySelectorAll(".xlist .xrow")].map((r) => r.querySelector(".xw").textContent)`);
await press(`.xlist li:first-child .xrow`);
out.orderBefore = await order();
await desk.key("ArrowDown", { modifiers: 1, vk: 40 });
await sleep(400);
out.orderDown = await order();
await pic("moved");
await desk.key("ArrowUp", { modifiers: 1, vk: 38 });
await sleep(400);
out.orderBack = await order();

// A continuous-auditing entry, as it can only be made: in Advanced mode.
await press(`.toptabs [fx-value-v="sacl"]`);
await press(`[fx-click="x-add"]`);
const field = (k) => `document.querySelector('.xed [name$=".${k}"]')`;
await set(field("way"), "alarm");
await set(field("sid"), "Everyone");
await set(field("mask"), "0x10000");
await set(`document.querySelector('.xed [name$=".flag.64"]')`, true);
out.alarm = await editor.js(`document.querySelector(".xlist .xrow[aria-selected=true]")?.innerText.replace(/\\n/g, " | ")`);
await pic("alarm");
await press(`.toptabs [fx-value-v="desc"]`);
out.sddlSent = await editor.js(`document.querySelector("pre.sddl")?.textContent`);

await press(`footer [fx-click="apply"]`);
await sleep(1500);
out.applied = await editor.js(`({ status: document.querySelector("footer .status")?.textContent ?? null, trouble: document.querySelector(".trouble")?.textContent ?? null })`);
await pic("applied");
await press(`footer [fx-click="cancel"]`);
await sleep(1000);

out.dacl = guest(`sd show --sddl ${AT}/finance`).trim();
out.learnedAfter = guest(`reg get 'Machine\\Common\\SecurityDescriptorBuilder' UsedClaims 2>&1`).trim();

// Opened again, the editor reads the raw SACL back.
editor = await open();
await press(`.advswitch input`);
await press(`.toptabs [fx-value-v="desc"]`);
out.sddlRead = await editor.js(`document.querySelector("pre.sddl")?.textContent`);
await press(`.advswitch input`);
await press(`.toptabs [fx-value-v="access"]`);
await press(`.who[fx-value-sid="${D}-1001"]`);
await press(`.tabs [fx-value-v="cond"]`);
out.suggested = await editor.js(`[...document.querySelectorAll("datalist option")].map((o) => o.value + " — " + o.label)`);
await press(`footer [fx-click="cancel"]`);
await desk.finish(out);
