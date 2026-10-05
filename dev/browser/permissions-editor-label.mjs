// The integrity label applied by itself, in headless Chromium, as alice:
// she may not read her file's SACL, so Gexora sends the editor the label
// alone and says it can apply it alone; she lowers it to Low, and the
// editor sends the label part, which Gexora applies as a label.
import { guest, session, sleep } from "./harness.mjs";

const AT = "/home/alice/label-check";
// alice signs in before anything is made in her home (see the dev VM notes).
const desk = await session(9373);
const out = {
    made: guest(`A=$(sd show /home/alice | sed -n 's/.*Owner:.*(\\(.*\\))/\\1/p'); rm -rf ${AT}; mkdir -p ${AT}; echo x > ${AT}/mine.txt; \
        sd set ${AT}/mine.txt "O:$A""G:$A""D:P(A;;FA;;;$A)(A;;FA;;;SY)(A;;FA;;;BA)" >/dev/null && echo made`).trim(),
};
await desk.launch(`gexora ${AT}`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora" }, 1);
await desk.menuOn(gexora, `.entries [fx-value-name="mine.txt"]`);
await desk.choose("Permissions…");
let editor = null;
for (let i = 0; i < 40 && !editor; i++) {
    editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
    if (!editor) await sleep(300);
}
if (!editor) await desk.finish({ ...out, stopped: "no dialog" }, 1);
await desk.press(editor, ".ownerbtn");
await sleep(500);
out.panel = await editor.js(`document.querySelector(".owners")?.innerText`);
// Choosing Low is a field's change, as the page sends one.
await editor.js(`(() => { const s = document.querySelector('[name="own.level"]'); s.value = "4096"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(600);
await desk.press(editor, `.owners button[type="submit"]`);
await sleep(600);
await desk.press(editor, `footer [fx-click="apply"]`);
await sleep(1500);
out.status = await editor.js(`({ status: document.querySelector("footer .status")?.textContent, trouble: document.querySelector(".trouble")?.textContent ?? null })`);
await desk.picture("permissions-editor-label.png");
out.after = guest(`sd show --sddl ${AT}/mine.txt`);
await desk.press(editor, `footer [fx-click="cancel"]`);
out.cleaned = guest(`rm -rf ${AT}`);
await desk.finish(out);
