// Upgrade Peios, in headless Chromium
// (`node upgrade-peios.mjs alice`, `node upgrade-peios.mjs light`, then
// `node upgrade-peios.mjs`).
//
// The VM needs the stand-in next release from
// ../gxwi-upgrade-peios/dev/repo.sh, and the medium's repository, whose
// information is months old. The upgrade can be made once a boot, so dana's
// run comes last.
//
// As dana: the release, the check refused for the stale repository and run
// anyway, the 2026.9 found with its plan; at half a screen, nothing wider
// than its place; the upgrade made, its proceed answered because the plan
// is the one shown, with its progress and its end; the release's settings
// then queued by hand for the next boot, shown waiting, and applied now.
// As alice, who isn't an administrator: the release, read-only, said once.
import { guest as asGuest, session, sleep } from "./harness.mjs";

/** A guest command's output, without the exit status the channel adds. */
const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();

const alice = process.argv[2] === "alice";
const light = process.argv[2] === "light";
// Only the release's settings, queued and applied: for a VM already
// upgraded this boot.
const settingsOnly = process.argv[2] === "settings";
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "upgrade-peios-alice" : light ? "upgrade-peios-light" : "upgrade-peios";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
async function window(title, has) {
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).filter((strip) => strip.title.startsWith(title));
        if (ours.length > 0) {
            const frame = (await desk.frames(has)).at(-1);
            if (frame) {
                frame.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
                return frame;
            }
        }
        await sleep(300);
    }
    return null;
}
async function gone(titles) {
    for (const strip of await strips()) {
        if (!titles.some((title) => strip.title.startsWith(title))) continue;
        const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
async function open() {
    await desk.launch("upgrade");
    await gone(["Get started"]);
    const w = await window("Upgrade Peios", ".st-head");
    if (!w) {
        out.stopped = "no Upgrade Peios window to attach to";
        await desk.finish(out, 1);
    }
    return w;
}
await gone([""]);
let w = await open();

const press = (selector) => w.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`).then(() => desk.press(w, selector));
const button = async (text) => {
    const found = await w.js(`(() => { const b = [...document.querySelectorAll(".st-page button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (!b) return false; b.setAttribute("data-test", "this"); return true; })()`);
    if (!found) return false;
    await press('[data-test="this"]');
    await w.js(`document.querySelector('[data-test="this"]')?.removeAttribute("data-test")`);
    return true;
};
const shows = () => w.js(`({
    said: document.querySelector(".st-status .said")?.textContent ?? null,
    hero: [...document.querySelectorAll(".st-hero")].map((h) => h.innerText.replaceAll("\\n", " | ")),
    banner: [...document.querySelectorAll(".st-banner")].map((b) => b.textContent),
    groups: [...document.querySelectorAll(".st-group")].map((g) => g.innerText.replaceAll("\\n", " | ").slice(0, 400)),
    asking: document.querySelector(".st-more.asking")?.innerText.replaceAll("\\n", " | ") ?? null,
    progress: document.querySelector(".st-progress")?.innerText ?? null,
    buttons: [...document.querySelectorAll(".st-page button")].filter((b) => !b.disabled).map((b) => b.textContent.trim()),
    focused: document.activeElement?.tagName === "BUTTON" ? document.activeElement.textContent.trim() : null,
})`);
/** Waits until what is shown passes `ok`, and gives it. */
async function until(ok, seconds = 60) {
    let now;
    for (let i = 0; i < seconds * 2; i++) {
        now = await shows();
        if (ok(now)) return now;
        await sleep(500);
    }
    now.timedOut = true;
    return now;
}
const settledCheck = () => until((s) => !s.progress && !s.groups.some((g) => g.startsWith("Reading")), 90);

out.first = await settledCheck();
await desk.picture(`${name}.png`);

if (light) {
    const scheme = { features: [{ name: "prefers-color-scheme", value: "light" }] };
    await desk.a.send("Emulation.setEmulatedMedia", scheme);
    await w.send("Emulation.setEmulatedMedia", scheme);
    await sleep(800);
    if (await button("Continue Anyway")) await settledCheck();
    await desk.picture(`${name}.png`);
    await desk.finish(out);
}

if (settingsOnly) {
    guest("reg del -r -y 'Machine/Software/Upgrade Peios Test'; upgrade-peios --seeds-only --on-reboot");
    await gone(["Upgrade Peios"]);
    w = await open();
    out.waiting = await until((s) => s.buttons.includes("Apply Now"), 30);
    await desk.picture(`${name}-waiting.png`);
    await button("Apply Now");
    out.applied = await until((s) => s.buttons.includes("Close") && !s.progress, 30);
    await desk.picture(`${name}-applied.png`);
    out.appliedValue = guest("reg get 'Machine/Software/Upgrade Peios Test' Release; ls /lcl/policy/autoapply.d");
    await desk.finish(out);
}

if (!alice) {
    // The medium's information is months old: carried on past, once.
    if (await button("Continue Anyway")) out.found = await settledCheck();
    await desk.picture(`${name}-available.png`);
}

// Half a screen: a second window tiles this one to half.
const wide = () => w.js(`(() => {
    const page = document.documentElement;
    const over = [...document.querySelectorAll(".st-page *")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0)
        .map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
    return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, over: [...new Set(over)].slice(0, 6) };
})()`);
await desk.launch("event");
await sleep(3000);
out.half = await wide();
await desk.picture(`${name}-half.png`);
await gone(["Event Viewer"]);
await sleep(1000);

if (!alice) {
    // The upgrade: the plan shown is the plan made, so nothing is asked.
    // With `reboot`, its settings are left for the next restart.
    if (process.argv.includes("reboot")) {
        await press('input[name="on-reboot"]');
        await sleep(400);
        out.switched = await w.js(`document.querySelector('input[name="on-reboot"]').checked`);
    }
    await button("Upgrade to 2026.9");
    out.running = await until((s) => s.progress !== null || s.asking !== null, 20);
    await desk.picture(`${name}-running.png`);
    out.done = await until((s) => !s.progress && s.buttons.includes("Close"), 120);
    await desk.picture(`${name}-done.png`);
    out.installed = guest("cat /usr/lib/os-release | head -3; reg get 'Machine/Software/Upgrade Peios Test' Release; upgrade-peios --status");
    await button("Close");
    out.after = await settledCheck();
    await desk.picture(`${name}-after.png`);

    // The release's settings waiting for the next boot — left there by the
    // upgrade itself with `reboot`, or queued by hand — then applied now
    // from the window.
    if (!process.argv.includes("reboot")) {
        guest("reg del -r -y 'Machine/Software/Upgrade Peios Test'; upgrade-peios --seeds-only --on-reboot");
        await gone(["Upgrade Peios"]);
        w = await open();
    }
    out.waiting = await until((s) => s.buttons.includes("Apply Now"), 30);
    await desk.picture(`${name}-waiting.png`);
    await button("Apply Now");
    out.applied = await until((s) => s.buttons.includes("Close") && !s.progress, 30);
    await desk.picture(`${name}-applied.png`);
    out.appliedValue = guest("reg get 'Machine/Software/Upgrade Peios Test' Release; ls /lcl/policy/autoapply.d");
    await button("Close");
}

out.log = w.log;
await desk.finish(out);
