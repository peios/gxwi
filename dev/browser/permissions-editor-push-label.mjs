// Pushing the integrity label alone into what is inside a folder, in
// headless Chromium, as alice, who may read and change her folder's label
// but not its SACL: she lowers it to Low, passed down, and updates what is
// inside; the editor sends the label part with propagate, Gexora walks as
// labels, and a folder whose SACL is protected keeps its own.
//
//     node dev/browser/permissions-editor-push-label.mjs
import { guest, session, sleep } from "./harness.mjs";

const AT = "/home/alice/label-push";
// alice signs in before anything is made in her home (see the dev VM notes).
const desk = await session(9380);
const out = {
    made: guest(`A=$(sd show /home/alice | sed -n 's/.*Owner:.*(\\(.*\\))/\\1/p'); rm -rf ${AT}; mkdir -p ${AT}/sub ${AT}/locked && touch ${AT}/sub/f.txt ${AT}/locked/in.txt && \
        for p in ${AT} ${AT}/sub ${AT}/locked; do sd owner $p $A >/dev/null; done && for p in ${AT}/sub/f.txt ${AT}/locked/in.txt; do sd owner $p $A >/dev/null; done && \
        sd set ${AT} "O:$A""G:$A""D:P(A;OICI;FA;;;$A)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" >/dev/null && \
        sd set ${AT}/locked "S:P(ML;OICI;NW;;;ME)" >/dev/null && echo made`).trim(),
};
const shown = (p) => guest(`sd show --sddl ${AT}/${p} 2>&1 | tail -1`).trim();
await desk.launch(`gexora /home/alice`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora" }, 1);
desk.surface = '.fx-surface[data-role="window"]';
await desk.menuOn(gexora, `.entries [fx-value-name="label-push"]`);
await desk.choose("Permissions…");
let editor = null;
for (let i = 0; i < 40 && !editor; i++) {
    editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
    if (!editor) await sleep(300);
}
if (!editor) await desk.finish({ ...out, stopped: "no dialog" }, 1);
desk.surface = '.fx-surface[data-role="dialog"]';
await desk.press(editor, ".ownerbtn");
await sleep(500);
await editor.js(`(() => {
    const level = document.querySelector('[name="own.level"]'); level.value = "4096"; level.dispatchEvent(new Event("change", { bubbles: true }));
    const down = document.querySelector('[name="own.linh"]'); if (down && !down.checked) { down.checked = true; down.dispatchEvent(new Event("change", { bubbles: true })); }
})()`);
await sleep(600);
out.panel = await editor.js(`({ level: document.querySelector('[name="own.level"]')?.value ?? null, down: document.querySelector('[name="own.linh"]')?.checked ?? null })`);
await desk.press(editor, `.owners button[type="submit"]`);
await sleep(600);
await desk.press(editor, `footer [fx-click="apply"]`);
await sleep(600);
out.asked = await editor.js(`document.querySelector(".inherit.push p")?.textContent ?? null`);
await desk.press(editor, `[fx-click="push"][fx-value-v="all"]`);
await sleep(2500);
out.said = await editor.js(`({ status: document.querySelector("footer .status")?.textContent, banner: document.querySelector(".inherit.warn")?.innerText ?? null, trouble: document.querySelector(".trouble")?.textContent ?? null })`);
await desk.picture("permissions-editor-push-label.png");
out.labels = { folder: shown(""), sub: shown("sub"), file: shown("sub/f.txt"), locked: shown("locked"), lockedIn: shown("locked/in.txt") };
await desk.press(editor, `footer [fx-click="cancel"]`);
out.cleaned = guest(`rm -rf ${AT}; echo cleaned`).trim();
await desk.finish(out);
