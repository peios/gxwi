// My Settings for someone with no password to prove (`node
// my-settings-kim.mjs`): kim, made with `lps add kim --no-password`. The
// password and key forms are not offered, and the window says who can
// change them; their name and language still can be.
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) =>
    asGuest(command)
        .replace(/\n?rc=\d+\s*$/, "")
        .trim();
guest("lps show kim >/dev/null 2>&1 || lps add kim --no-password --no-prompt");
const desk = await session(9368, { user: "kim", password: "" });
const out = {};
await sleep(2000);
await desk.launch("my");
await sleep(2500);
const w = (await desk.frames(".st-nav")).at(-1);
if (!w) {
    out.stopped = "no My Settings window";
    await desk.finish(out, 1);
}
const strips = await desk.a.js(
    `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
);
w.surface = `.fx-surface[data-id="${strips.filter((s) => s.title.startsWith("My Settings")).at(-1).id}"]`;
const shows = () =>
    w.js(`({
    groups: [...document.querySelectorAll(".st-group, .st-banner")].map((c) => c.innerText.replaceAll("\\n", " | ").slice(0, 300)),
    editable: [...document.querySelectorAll("input, select, textarea")].filter((f) => !f.disabled).map((f) => f.name),
})`);
out.account = await shows();
for (const id of ["password", "keys"]) {
    await desk.press(w, `#st-nav-${id}`);
    await sleep(1200);
    out[id] = await shows();
    await desk.picture(`my-settings-kim-${id}.png`);
}
out.log = w.log;
await desk.finish(out);
