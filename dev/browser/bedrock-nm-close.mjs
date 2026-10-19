// Network Manager on a release image: a firewall rule change waiting on its
// keep bar is undone when the window is closed, not kept (PEI-1363).
//
//     GXWI_DESK=http://127.0.0.1:47780/ BEDROCK_USER=tester BEDROCK_PASSWORD=… \
//     BEDROCK_SSH=./ssh-to-it BEDROCK_CONSOLE=console.log node dev/browser/bedrock-nm-close.mjs
//
// BEDROCK_SSH is a command that runs its argument on the machine, and
// BEDROCK_CONSOLE the machine's serial console, where the kernel says each
// policy NTFE takes: the save is one and the undo another, so when the undo
// came is seen, not guessed.
//
// The exception goes on a rule the shell reaching the machine doesn't use:
// one under ssh would refuse that shell's next connection, and Network
// Manager undoes at once a change that cuts someone off.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { session, sleep } from "./harness.mjs";

const UNDER = process.env.BEDROCK_UNDER ?? "dev-viewer-ports";
const guest = (command) =>
    execFileSync(process.env.BEDROCK_SSH, [command], { encoding: "utf8" }).trim();
const rule = () =>
    guest(
        `reg ls "Machine\\System\\Network\\Rules\\Flow\\${UNDER}\\lan-only" >/dev/null 2>&1 && echo there || echo gone`,
    );
const generations = () =>
    readFileSync(process.env.BEDROCK_CONSOLE, "utf8")
        .split("\n")
        .filter((l) => /ntfe: (policy generation|rules refresh failed)/.test(l))
        .map((l) => l.replace(/^.*\] /, "").trim());

const desk = await session(9379, {
    user: process.env.BEDROCK_USER,
    password: process.env.BEDROCK_PASSWORD,
});
const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
const out = {};
await sleep(3000);
await desk.pressAt({ x: 600, y: 400 });
await sleep(500);
await desk.launch("network manager");
let w = null;
for (let i = 0; i < 40 && !w; i++) {
    const ours = (await strips()).filter((s) => s.title.startsWith("Network Manager"));
    const frame = ours.length ? (await desk.frames("nav.side")).at(-1) : null;
    if (frame) {
        frame.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
        w = frame;
    } else {
        await sleep(300);
    }
}
if (!w) await desk.finish({ stopped: "no Network Manager window" }, 1);

const press = (selector) =>
    w
        .js(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(w, selector));
const button = async (text, within) => {
    const found = await w.js(
        `(() => { const b = [...document.querySelectorAll(${JSON.stringify(within + " button, " + within + " tr.click")})].find((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!b) return false; b.setAttribute("data-test", "this"); return true; })()`,
    );
    if (!found) return false;
    await press('[data-test="this"]');
    await w.js(`document.querySelector('[data-test="this"]')?.removeAttribute("data-test")`);
    await sleep(900);
    return true;
};
const put = (field, value) =>
    w
        .js(
            `(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); })()`,
        )
        .then(() => sleep(700));

out.before = rule();
await press('nav.side button[fx-value-section="rules"]');
await sleep(1300);
out.opened = await button(UNDER, ".rtable");
out.exception = await button("Add exception", ".drawer");
await put("r-name", "lan-only");
await put("cv0", "10.0.0.0/8");
const g0 = generations().length;
out.saved = await button("Save", ".drawer");
await sleep(2500);
out.keepbar = await w.js(
    `document.querySelector(".keepbar")?.innerText.replaceAll("\\n", " ") ?? null`,
);
out.whileAsked = rule();
out.onSave = generations().slice(g0);
await desk.picture("bedrock-nm-keepbar.png");

// Closed while it asks, as a person closes a window.
const id = w.surface.match(/"(\d+)"/)[1];
const close = await desk.a.js(
    `(() => { const r = document.querySelector('.fx-surface[data-id="${id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
);
const g1 = generations().length;
await desk.pressAt(close);
await sleep(5000);
out.windowAfter = (await strips()).filter((s) => s.title.startsWith("Network Manager")).length;
out.onClose = generations().slice(g1);
out.afterClose = rule();
// The countdown's own time going by: an undo that came only now would be
// the countdown's, not the close's.
await sleep(30000);
out.later = generations().slice(g1 + out.onClose.length);
out.undone =
    out.whileAsked === "there" &&
    out.afterClose === "gone" &&
    out.onClose.length > 0 &&
    out.later.length === 0;
await desk.finish(out, out.undone && out.windowAfter === 0 ? 0 : 1);
