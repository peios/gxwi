// My Settings for someone with no password to prove (`node
// my-settings-kim.mjs`): kim, made with `lps add kim --no-password`. The
// password and key forms are not offered, and the window says who can
// change them; their name and language still can be.
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();
guest("lps show kim >/dev/null 2>&1 || lps add kim --no-password --no-prompt");
const desk = await session(9368, { user: "kim", password: "" });
const out = {};
await sleep(2000);
await desk.launch("my");
await sleep(2500);
const w = (await desk.frames(".cards")).at(-1);
if (!w) {
    out.stopped = "no My Settings window";
    await desk.finish(out, 1);
}
out.shown = await w.js(`({
    cards: [...document.querySelectorAll(".card")].map((c) => c.innerText.replaceAll("\\n", " | ").slice(0, 300)),
    editable: [...document.querySelectorAll("input, select, textarea")].filter((f) => !f.disabled).map((f) => f.name),
})`);
await desk.picture("my-settings-kim.png");
out.log = w.log;
await desk.finish(out);
