// The default app for a file type, end to end (PEI-1276), in headless
// Chromium, as dana: chosen in Desktop Settings, and used by File Explorer when a
// file of that type is opened, for each of two choices; then put back.
//
// Only Text Editor says it opens text on the dev image, so there would be no
// choice to make. For this check the guest gets a second for a while: the
// test app, declared as opening text/plain, taken away again at the end.
//
//     node dev/browser/default-app.mjs
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) =>
    asGuest(command)
        .replace(/\n?rc=\d+\s*$/, "")
        .trim();
const AT = "/srv/default-app";
const OPENER = "dev.peios.check.opener";
guest(
    `printf '%s\\n' 'title = "Opener Check"' 'description = "Stands in for a second text app"' 'program = "/usr/bin/gxwi-hello-app"' 'opens = ["text/plain"]' > /usr/share/apps/${OPENER}.toml` +
        ` && mkdir -p ${AT} && printf 'hello\\n' > ${AT}/note.txt`,
);
const desk = await session(9366, { user: "dana", password: "dana-dev-password" });
const out = {};

const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
async function gone(titles) {
    for (const strip of await strips()) {
        if (titles && !titles.some((title) => strip.title.startsWith(title))) continue;
        const close = await desk.a.js(
            `(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
async function attach(title, has) {
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).filter((strip) => strip.title.startsWith(title));
        const frame = ours.length ? (await desk.frames(has)).at(-1) : null;
        if (frame) {
            frame.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
            return frame;
        }
        await sleep(300);
    }
    return null;
}
/** The titles of the windows opened since `before`. */
const opened = async (before) =>
    (await strips()).filter((s) => !before.some((b) => b.id === s.id)).map((s) => s.title);

await gone();
await desk.launch("desktop");
const settings = await attach("Desktop Settings", ".st-nav");
if (!settings) await desk.finish({ ...out, stopped: "no Desktop Settings" }, 1);
const put = (field, value) =>
    settings.js(
        `(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); })()`,
    );
await settings.js(`document.querySelector("#st-nav-files")?.scrollIntoView({ block: "center" })`);
await desk.press(settings, "#st-nav-files");
await sleep(1500);
const field = await settings.js(`(() => {
    const select = [...document.querySelectorAll('select[name^="app:"]')].find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(OPENER)}));
    return select ? { name: select.name, options: [...select.options].map((o) => o.textContent), label: select.closest(".st-row").querySelector("b").textContent } : null;
})()`);
out.field = field;
if (!field) await desk.finish({ ...out, stopped: "Desktop Settings offers no choice for text" }, 1);
await put(field.name, OPENER);
await sleep(1500);
out.chosen = await settings.js(`document.querySelector(".st-status .said")?.textContent ?? null`);
await desk.picture("default-app-chosen.png");

// File Explorer opens the file with what was chosen.
await desk.launch(`gxwi-file-explorer ${AT}`);
const gexora = await attach("File Explorer", ".listing");
if (!gexora) await desk.finish({ ...out, stopped: "no File Explorer" }, 1);
let before = await strips();
await desk.doublePress(gexora, `.entries [fx-value-name="note.txt"]`);
await sleep(3000);
out.openedChosen = await opened(before);
await desk.picture("default-app-opened-chosen.png");
await gone(out.openedChosen);

// The other choice, and that one opens it.
await put(field.name, "dev.peios.gxwi-text-editor");
await sleep(1500);
out.chosenEditor = await settings.js(
    `document.querySelector(".st-status .said")?.textContent ?? null`,
);
before = await strips();
await desk.doublePress(gexora, `.entries [fx-value-name="note.txt"]`);
await sleep(3000);
out.openedEditor = await opened(before);
await desk.picture("default-app-opened-editor.png");
await gone(out.openedEditor);

// Put back. With no default, which candidate opens it is File Explorer's own rule
// (PGSS §5.6): the first in the catalogue, by id.
await put(field.name, "");
await sleep(1500);
out.putBack = await settings.js(`document.querySelector(".st-status .said")?.textContent ?? null`);
before = await strips();
await desk.doublePress(gexora, `.entries [fx-value-name="note.txt"]`);
await sleep(3000);
out.openedNoDefault = await opened(before);
await gone(out.openedNoDefault);

out.removed = guest(`rm -f /usr/share/apps/${OPENER}.toml && rm -rf ${AT} && echo removed`);
out.log = gexora.log;
await desk.finish(out);
