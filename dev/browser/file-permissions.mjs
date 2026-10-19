// File Explorer's Permissions…, in headless Chromium, as alice: what she may change
// of a file's descriptor is asked of the system, and what she may not is
// shown and not offered.
//
// The VM's administrator makes two files in her home, each with a descriptor
// of its own: open.txt is hers, and the owner of something may always change
// who may use it; locked.txt is Administrators', and she may only read it.
import { guest, session, sleep } from "./harness.mjs";

const AT = "/home/alice/permission-check";
const out = {
    made: guest(`A=$(sd show /home/alice | sed -n 's/.*Owner:.*(\\(.*\\))/\\1/p'); rm -rf ${AT}; mkdir -p ${AT}; echo open > ${AT}/open.txt; echo locked > ${AT}/locked.txt; \
        sd set ${AT}/open.txt "O:$A""G:$A""D:P(A;;FA;;;$A)(A;;FA;;;SY)(A;;FA;;;BA)" && sd set ${AT}/locked.txt "O:BAG:BAD:P(A;;FA;;;BA)(A;;FR;;;$A)" && ls ${AT}`)
        .trim()
        .split("\n"),
};
const desk = await session(9365);
await desk.launch(`gxwi-file-explorer ${AT}`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no File Explorer: is it in the catalogue?" }, 1);

async function dialog() {
    for (let i = 0; i < 30; i++) {
        const found = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
        if (found) return found;
        await sleep(300);
    }
    return null;
}
const shows = (editor) =>
    editor.js(`({
    title: document.querySelector("header")?.innerText,
    owner: document.querySelector(".owner")?.innerText,
    fixed: document.querySelector(".fixed")?.textContent ?? null,
    listed: [...document.querySelectorAll(".who .name")].map((n) => n.textContent),
    under: [...document.querySelectorAll(".under button")].map((b) => b.textContent),
    footer: [...document.querySelectorAll("footer button")].map((b) => b.textContent),
})`);

for (const name of ["open.txt", "locked.txt"]) {
    await desk.menuOn(gexora, `.entries [fx-value-name="${name}"]`);
    await desk.choose("Permissions…");
    const editor = await dialog();
    out[name] = editor
        ? await shows(editor)
        : {
              stopped: "no dialog",
              trouble: await gexora.js(`document.querySelector(".trouble")?.textContent ?? null`),
          };
    await desk.picture(`file-permissions-${name.replace(".txt", "")}.png`);
    if (editor) {
        // Cancel where it may be changed, Close where it may not.
        const buttons = await editor.js(`document.querySelectorAll("footer button").length`);
        await desk.press(editor, buttons > 1 ? "footer button:nth-child(2)" : "footer .primary");
        for (
            let i = 0;
            i < 20 &&
            !(await desk.a.js(`!document.querySelector('.fx-surface[data-role="dialog"]')`));
            i++
        ) {
            await sleep(300);
        }
    }
}
out.cleaned = guest(`rm -rf ${AT}`);
await desk.finish(out);
