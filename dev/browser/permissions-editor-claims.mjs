// The permissions editor's claim suggestions from the machine's catalogue,
// in headless Chromium: Machine\Common\SecurityDescriptorBuilder must hold
// KnownClaims\User.Department and \Resource.Classification (as
// target/vmshare/pe-check/known-claims.reg makes them). dana, an
// administrator, sees defined claims first, a defined resource claim made
// its kind, and her rule counted in UsedClaims; alice, who may not write the
// key, gets the same suggestions and no "Forget What's Been Used".
//
//     node dev/browser/permissions-editor-claims.mjs
import { guest, session, sleep } from "./harness.mjs";

const D = "S-1-5-21-1656784432-3555462761-4094152458";
const AT = "/srv/pe-check";
const KEY = "Machine\\Common\\SecurityDescriptorBuilder";
const out = {
    made: guest(`mkdir -p ${AT}/finance && sd set ${AT} 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)' && \
        sd set ${AT}/finance 'O:${D}-1002G:BAD:(A;OICI;0x1301bf;;;${D}-1002)(A;OICI;0x1200a9;;;${D}-1001)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)' >/dev/null && \
        reg del '${KEY}' UsedClaims >/dev/null 2>&1; reg tree '${KEY}' && echo made`).trim(),
};

async function opened(desk) {
    for (const id of await desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => s.dataset.id)`)) {
        const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
    await desk.launch(`gexora ${AT}`);
    const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
    if (!gexora) await desk.finish({ ...out, stopped: "no Gexora" }, 1);
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

function driving(desk, editor) {
    const press = async (selector) => {
        const there = await editor.js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.scrollIntoView({ block: "center" }); return !!e; })()`);
        if (!there) out.missed = [...(out.missed ?? []), selector];
        await sleep(200);
        await desk.press(editor, selector);
        await sleep(500);
    };
    const set = async (selector, value) => {
        await editor.js(`(() => { const f = [...document.querySelectorAll(${JSON.stringify(selector)})].at(-1); f.focus(); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event(f.tagName === "SELECT" ? "change" : "input", { bubbles: true })); f.blur(); })()`);
        await sleep(600);
    };
    const offered = (selector) => editor.js(`(() => { const f = [...document.querySelectorAll(${JSON.stringify(selector)})].at(-1); return [...(f?.list?.options ?? [])].map((o) => o.value + " — " + o.label); })()`);
    return { press, set, offered };
}

// dana.
let desk = await session(9376, { user: "dana", password: "dana-dev-password" });
let editor = await opened(desk);
let { press, set, offered } = driving(desk, editor);
await press(`.who[fx-value-sid="${D}-1001"]`);
await press(`.tabs [fx-value-v="cond"]`);
await press(`[fx-click="c-new"]`);
out.userNames = await offered(`.pane .rule input[name$=".name"]`);
await set(`.pane .rule input[name$=".name"]`, "Department");
out.departmentValues = await offered(`.pane .rule input[name$=".val"]`);
await set(`.pane .rule input[name$=".val"]`, "Engineering");
await press(`.pane .rule [fx-click="ctick"][fx-value-way="allow"][fx-value-mask="1179817"]`);
await editor.js(`document.querySelector(".pane .rule input[name$='.name']")?.scrollIntoView({ block: "center" })`);
await desk.picture("permissions-editor-claims-condition.png");
await press(`.toptabs [fx-value-v="claims"]`);
await press(`[fx-click="cl-new"]`);
out.resourceNames = await offered(`input[name^="cl."][name$=".name"]`);
await set(`input[name^="cl."][name$=".name"]`, "Classification");
out.classificationKind = await editor.js(`[...document.querySelectorAll('select[name^="cl."][name$=".kind"]')].at(-1)?.value`);
out.classificationValues = await offered(`input[name^="cl."][name$=".vals"]`);
await set(`input[name^="cl."][name$=".vals"]`, "Internal");
await editor.js(`document.scrollingElement.scrollTop = 0`);
await desk.picture("permissions-editor-claims-claim.png");
await press(`footer [fx-click="apply"]`);
await sleep(1500);
out.applied = await editor.js(`({ status: document.querySelector("footer .status")?.textContent ?? null, trouble: document.querySelector(".trouble")?.textContent ?? null })`);
await press(`footer [fx-click="cancel"]`);
out.used = guest(`reg get '${KEY}' UsedClaims 2>&1`).trim();
await desk.a.js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
await sleep(1500);
desk.close();

// alice may read the key, not write it.
desk = await session(9377);
editor = await opened(desk);
({ press, offered } = driving(desk, editor));
await press(`.who[fx-value-sid="${D}-1001"]`);
await press(`.tabs [fx-value-v="cond"]`);
out.aliceForget = await editor.js(`!!document.querySelector('[fx-click="forget"]')`);
out.aliceNote = await editor.js(`[...document.querySelectorAll(".pane .note")].at(-1)?.textContent`);
await press(`footer [fx-click="cancel"]`);
await desk.finish(out);
