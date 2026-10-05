// Pushing a registry key's permissions into the keys under it, in headless
// Chromium, as dana, an administrator, from Registry Editor: a nested key
// and its subkey get what the key now passes down, and a protected key is
// left as it is.
//
//     node dev/browser/permissions-editor-push-registry.mjs
import { guest, session, sleep } from "./harness.mjs";

const D = "S-1-5-21-1656784432-3555462761-4094152458";
const KEY = "Machine\\Software\\PushCheck";
const out = {
    made: guest(`reg del -r '${KEY}' >/dev/null 2>&1; reg new -p '${KEY}\\a\\deep' && reg new '${KEY}\\locked' && \
        reg sd '${KEY}' --dacl --set 'D:P(A;CI;KA;;;BA)(A;CI;KA;;;${D}-1002)' && reg sd '${KEY}\\locked' --dacl --set 'D:P(A;CI;KA;;;BA)(A;CI;KA;;;${D}-1002)' && \
        reg sd '${KEY}\\locked' --sacl --set 'S:P(ML;CI;NW;;;ME)' && reg sd '${KEY}' --sacl --set 'S:(ML;;NW;;;ME)' && echo made`).trim(),
};
const sd = (key) => guest(`reg sd '${KEY}${key}'`).trim();
out.before = { a: sd("\\a"), deep: sd("\\a\\deep") };

const desk = await session(9379, { user: "dana", password: "dana-dev-password" });
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
for (const strip of await strips()) {
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch("registry");
let editor = null;
for (let i = 0; i < 40 && !editor; i++) {
    editor = (await desk.frames("nav.tree"))[0] ?? null;
    if (!editor) await sleep(300);
}
if (!editor) await desk.finish({ ...out, stopped: "no Registry Editor" }, 1);
editor.surface = '.fx-surface[data-role="window"]';
await desk.press(editor, "input[name=path]");
await editor.js(`document.querySelector("input[name=path]").select()`);
await desk.type(KEY);
await desk.key("Enter", { vk: 13 }, "\r");
await sleep(1200);
await desk.menuOn(editor, `.tree .name[aria-selected="true"]`);
await desk.choose("Permissions…");
let dialog = null;
for (let i = 0; i < 40 && !dialog; i++) {
    dialog = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
    if (!dialog) await sleep(300);
}
if (!dialog) await desk.finish({ ...out, stopped: "no dialog" }, 1);
const press = async (selector) => {
    await dialog.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`);
    await sleep(200);
    if (!(await desk.press(dialog, selector))) out.missed = [...(out.missed ?? []), selector];
    await sleep(500);
};
// Authenticated Users may read the key and the keys under it.
await press(`[fx-click="add"]`);
await dialog.js(`(() => { const f = document.querySelector('[name="who"]'); f.value = "Authenticated Users"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await sleep(400);
await press(`.naming button[type="submit"]`);
await press(`.tabs [fx-value-v="access"]`);
out.rights = await dialog.js(`[...document.querySelectorAll(".rights tbody th")].map((t) => t.textContent)`);
await press(`.rights [fx-value-right="1"][fx-value-way="allow"]`);
await press(`footer [fx-click="apply"]`);
out.asked = await dialog.js(`document.querySelector(".inherit.push p")?.textContent ?? null`);
await dialog.js(`document.querySelector(".inherit.push")?.scrollIntoView({ block: "center" })`);
await desk.picture("permissions-editor-push-registry-asking.png");
await press(`[fx-click="push"][fx-value-v="all"]`);
await sleep(2000);
out.said = await dialog.js(`({ status: document.querySelector("footer .status")?.textContent, banner: document.querySelector(".inherit.warn")?.innerText ?? null, trouble: document.querySelector(".trouble")?.textContent ?? null })`);
await desk.picture("permissions-editor-push-registry-done.png");
out.after = { key: sd(""), a: sd("\\a"), deep: sd("\\a\\deep"), locked: sd("\\locked") };

// The label alone, lowered to Low and passed down: pushed as labels, and
// the key whose SACL is protected keeps its own.
await press(`.ownerbtn`);
await dialog.js(`(() => {
    const level = document.querySelector('[name="own.level"]'); level.value = "4096"; level.dispatchEvent(new Event("change", { bubbles: true }));
    const down = document.querySelector('[name="own.linh"]'); if (down && !down.checked) { down.checked = true; down.dispatchEvent(new Event("change", { bubbles: true })); }
})()`);
await sleep(600);
out.ownerPanel = await dialog.js(`({ text: document.querySelector(".owners")?.innerText ?? null, level: document.querySelector('[name="own.level"]')?.value ?? null, down: document.querySelector('[name="own.linh"]')?.checked ?? null, disabled: document.querySelector('[name="own.level"]')?.disabled ?? null })`);
await press(`.owners button[type="submit"]`);
out.afterDone = await dialog.js(`({ apply: document.querySelector('footer [fx-click="apply"]')?.disabled, trouble: document.querySelector(".trouble")?.textContent ?? null, wrong: [...document.querySelectorAll(".wrong")].map((w) => w.textContent) })`);
await press(`footer [fx-click="apply"]`);
out.labelAsked = await dialog.js(`document.querySelector(".inherit.push p")?.textContent ?? null`);
await press(`[fx-click="push"][fx-value-v="all"]`);
await sleep(2000);
out.labelSaid = await dialog.js(`({ status: document.querySelector("footer .status")?.textContent, banner: document.querySelector(".inherit.warn")?.innerText ?? null, trouble: document.querySelector(".trouble")?.textContent ?? null })`);
const sacl = (key) => guest(`reg sd --sacl '${KEY}${key}'`).trim();
out.labels = { key: sacl(""), a: sacl("\\a"), deep: sacl("\\a\\deep"), locked: sacl("\\locked") };
await press(`footer [fx-click="cancel"]`);
out.cleaned = guest(`reg del -r '${KEY}' >/dev/null 2>&1; echo cleaned`).trim();
await desk.finish(out);
