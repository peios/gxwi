// Permissions… chosen again while its dialog is open brings that dialog to
// the front with the keyboard, rather than a second dialog or a "open
// already" (PEI-1219), in headless Chromium, as dana.
//
//     node dev/browser/permissions-raise.mjs
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) =>
    asGuest(command)
        .replace(/\n?rc=\d+\s*$/, "")
        .trim();
const AT = "/srv/pe-raise";
const out = { made: guest(`mkdir -p ${AT} && printf 'x\\n' > ${AT}/a.txt && echo made`) };
const desk = await session(9366, { user: "dana", password: "dana-dev-password" });

const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
for (const strip of await strips()) {
    const close = await desk.a.js(
        `(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
    );
    if (close) await desk.pressAt(close);
    await sleep(800);
}
/** Which surface has the keyboard on this device, and how many dialogs are up. */
const focus = () =>
    desk.a.js(`(() => {
    const f = document.querySelector('.fx-surface[data-focused="true"]');
    return { role: f?.dataset.role ?? null, title: f?.innerText.split("\\n")[0].trim() ?? null, dialogs: document.querySelectorAll('.fx-surface[data-role="dialog"]').length };
})()`);

await desk.launch(`gxwi-file-explorer ${AT}`);
let gexora = null;
for (let i = 0; i < 40 && !gexora; i++) {
    const ours = (await strips()).filter((s) => s.title.startsWith("File Explorer"));
    gexora = ours.length ? ((await desk.frames(".listing")).at(-1) ?? null) : null;
    if (gexora) gexora.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
    else await sleep(300);
}
if (!gexora) await desk.finish({ ...out, stopped: "no File Explorer" }, 1);

async function permissions() {
    desk.surface = gexora.surface;
    await desk.menuOn(gexora, `.entries [fx-value-name="a.txt"]`);
    await desk.choose("Permissions…");
    await sleep(2000);
}

await permissions();
out.opened = await focus();
// The keyboard back to File Explorer: a press on its strip, near the left, which
// the dialog over the middle doesn't cover.
const strip = await desk.a.js(
    `(() => { const r = document.querySelector('${gexora.surface} .fx-strip')?.getBoundingClientRect(); return r ? { x: r.left + 60, y: r.top + r.height / 2 } : null; })()`,
);
await desk.pressAt(strip);
await sleep(800);
out.backToGexora = await focus();
await desk.picture("permissions-raise-behind.png");
// Asked for again.
await permissions();
out.askedAgain = await focus();
out.trouble = await gexora.js(
    `document.querySelector(".trouble, .wrong, [role=alert]")?.textContent ?? null`,
);
out.raisedCount = await (
    await desk.frame(".editor", '.fx-surface[data-role="dialog"]')
)?.js(`document.querySelector("[fx-raise]")?.getAttribute("fx-raise") ?? null`);
await desk.picture("permissions-raise-raised.png");

const editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
if (editor) await desk.press(editor, `footer [fx-click="cancel"]`);
await sleep(800);
out.removed = guest(`rm -rf ${AT} && echo removed`);
await desk.finish(out);
