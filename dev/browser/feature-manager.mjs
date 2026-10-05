// Feature Manager, in headless Chromium
// (`node feature-manager.mjs`, then `node feature-manager.mjs alice`, and
// `node feature-manager.mjs light`).
//
// The VM needs the features from ../gxwi-feature-manager/dev/repo.sh:
// dynamic-boot, and an example whose scripts take a few seconds each and
// whose turning on fails while /tmp/feat-example-fail exists.
//
// As dana, an administrator: both features listed, not installed; the
// example turned on, watched while its scripts run, and off again; its
// turning on made to fail, with what the script said, left interrupted and
// tried again; its removal asked about and made; dynamic-boot installed
// without turning it on. Then the example's package removed while it is
// on, which leaves its state and no definition, said as such. At half a
// screen, nothing is wider than its place, and a window closed mid-change
// stays until the change is made. As alice, who isn't an administrator,
// everything reads and nothing can be changed, said once.
import { guest as asGuest, session, sleep } from "./harness.mjs";

/** A guest command's output, without the exit status the channel adds. */
const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();

const alice = process.argv[2] === "alice";
const light = process.argv[2] === "light";
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "feature-manager-alice" : light ? "feature-manager-light" : "feature-manager";

if (!alice && !light) {
    guest("rm -f /tmp/feat-example-fail; feat remove example; feat remove dynamic-boot; peipkg info dev.peios.feat-example > /dev/null 2>&1 || peipkg install --yes --allow-stale dev.peios.feat-example");
}
out.before = guest("feat list");

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
    await desk.launch("feature");
    await gone(["Get started"]);
    const w = await window("Feature Manager", ".st-head");
    if (!w) {
        out.stopped = "no Feature Manager window to attach to";
        await desk.finish(out, 1);
    }
    return w;
}
await gone([""]);
let w = await open();

const press = (selector) => w.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`).then(() => desk.press(w, selector));
/** Presses a feature's button: its event and verb, as the page sends them. */
const change = (feature, event, verb) => press(`button[fx-click="${event}"][fx-value-name="${feature}"]${verb ? `[fx-value-verb="${verb}"]` : ""}`);
const button = async (text) => {
    const found = await w.js(`(() => { const b = [...document.querySelectorAll(".st-page button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (!b) return false; b.setAttribute("data-test", "this"); return true; })()`);
    if (!found) return false;
    await press('[data-test="this"]');
    await w.js(`document.querySelector('[data-test="this"]')?.removeAttribute("data-test")`);
    return true;
};
const shows = () => w.js(`({
    said: document.querySelector(".st-status .said")?.textContent ?? null,
    banner: [...document.querySelectorAll(".st-banner")].map((b) => b.textContent),
    cards: [...document.querySelectorAll(".st-group")].map((g) => g.innerText.replaceAll("\\n", " | ").slice(0, 400)),
    asking: document.querySelector(".st-more.asking")?.innerText.replaceAll("\\n", " | ") ?? null,
    progress: document.querySelector(".st-progress")?.innerText ?? null,
    log: document.querySelector(".st-more pre")?.textContent ?? null,
    buttons: [...document.querySelectorAll(".st-page button")].filter((b) => !b.disabled).map((b) => b.textContent.trim()),
    disabled: [...document.querySelectorAll(".st-page button")].filter((b) => b.disabled).map((b) => b.textContent.trim()),
    focused: document.activeElement?.textContent?.trim() ?? null,
})`);
/** Waits until what is shown passes `ok`, and gives it. */
async function until(ok, seconds = 30) {
    let now;
    for (let i = 0; i < seconds * 2; i++) {
        now = await shows();
        if (ok(now)) return now;
        await sleep(500);
    }
    now.timedOut = true;
    return now;
}
/** Waits for a change to end, in the status line or a failure. */
const ended = () => until((s) => !s.progress, 60);

out.list = await until((s) => s.cards.length > 0 && !s.cards[0].startsWith("Reading"));
await desk.picture(`${name}.png`);

if (light) {
    const scheme = { features: [{ name: "prefers-color-scheme", value: "light" }] };
    await desk.a.send("Emulation.setEmulatedMedia", scheme);
    await w.send("Emulation.setEmulatedMedia", scheme);
    await sleep(800);
    await desk.picture(`${name}.png`);
    await desk.finish(out);
}

if (!alice) {
    // Turned on: install, then enable, each script watched.
    await change("example", "change", "add");
    out.running = await until((s) => (s.progress ?? "").includes("script"), 10);
    await desk.picture(`${name}-running.png`);
    out.on = await ended();
    await desk.picture(`${name}-on.png`);
    out.onState = guest("feat list; reg get 'Machine/Software/Feature Example' On");

    await change("example", "change", "disable");
    out.off = await ended();

    // Made to fail: what the script said, then interrupted, then again.
    guest("touch /tmp/feat-example-fail");
    await change("example", "change", "enable");
    out.failed = await ended();
    await desk.picture(`${name}-failed.png`);
    await button("Close");
    await sleep(600);
    out.interrupted = await until((s) => s.cards.some((c) => c.includes("Interrupted")), 10);
    await desk.picture(`${name}-interrupted.png`);
    guest("rm -f /tmp/feat-example-fail");
    await button("Try Again");
    out.retried = await ended();

    // Removed, after being asked.
    await change("example", "ask-remove");
    await sleep(600);
    out.asking = await shows();
    await desk.picture(`${name}-remove-asking.png`);
    await press('.st-more.asking button.danger');
    out.removed = await ended();

    // Installed without turning on.
    await change("dynamic-boot", "change", "install");
    out.installedOnly = await ended();
    await desk.picture(`${name}-installed-only.png`);
    out.services = guest("reg get Machine/System/Services/mkuki-watch Disabled");

    // Its package removed while it is on: the registry still says on, and
    // the definition is gone.
    await change("example", "change", "add");
    await ended();
    guest("peipkg uninstall --yes dev.peios.feat-example");
    await gone(["Feature Manager"]);
    w = await open();
    out.orphan = await until((s) => s.cards.some((c) => c.includes("Definition Missing")), 15);
    await desk.picture(`${name}-orphan.png`);
    guest("peipkg install --yes --allow-stale dev.peios.feat-example; feat remove example");
    await gone(["Feature Manager"]);
    w = await open();
    await until((s) => s.cards.length > 1);
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

// Closed mid-change: it stays, saying it will go, and goes once it is made.
if (!alice) {
    await change("example", "change", "add");
    await until((s) => s.progress !== null, 10);
    const close = await desk.a.js(`(() => { const r = document.querySelector('${w.surface} [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    await desk.pressAt(close);
    await sleep(500);
    out.closing = await shows().catch(() => ({ gone: true }));
    await desk.picture(`${name}-closing.png`);
    let left = false;
    for (let i = 0; i < 60 && !left; i++) {
        await sleep(500);
        left = !(await strips()).some((strip) => strip.title.startsWith("Feature Manager"));
    }
    out.closedWhenDone = { left, state: guest("feat list") };
}
await gone(["Event Viewer"]);

out.log = w.log;
await desk.finish(out);
