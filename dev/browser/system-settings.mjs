// System Settings, in headless Chromium
// (`node system-settings.mjs`, then `node system-settings.mjs alice`).
//
// As dana, an administrator: the time and how it is kept; choosing a time
// zone, which timed puts in /etc/localtime; setting the clock by hand and
// back; the console's layout, loaded at once; the machine's name, which
// netd applies; the startup tab. Everything changed is put back. As alice,
// who isn't an administrator, every tab reads, nothing can be changed, and
// each part says why. At half a screen, nothing is wider than its place.
import { guest as asGuest, session, sleep } from "./harness.mjs";

/** A guest command's output, without the exit status the channel adds. */
const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();

const alice = process.argv[2] === "alice";
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "system-settings-alice" : "system-settings";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
async function window(title, has) {
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).filter((strip) => strip.title.startsWith(title));
        if (ours.length > 0) {
            // The newest: a window closed a moment ago can still be listed.
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
await gone(["Get started", "System Settings"]);
await desk.launch("system");
await gone(["Get started"]);
const settings = await window("System Settings", ".cards");
if (!settings) {
    out.stopped = "no System Settings window to attach to";
    await desk.finish(out, 1);
}
const press = (selector) => settings.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`).then(() => desk.press(settings, selector));
const put = (field, value) => settings.js(`(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
/** What the tab shows: each card's heading and text, what can be changed, and what was said. */
const shows = () => settings.js(`({
    tab: document.querySelector('.tab[aria-pressed="true"]')?.textContent ?? null,
    said: document.querySelector(".said")?.textContent ?? null,
    cards: [...document.querySelectorAll(".card")].map((c) => c.innerText.replaceAll("\\n", " | ").slice(0, 400)),
    editable: [...document.querySelectorAll("input, select, textarea")].filter((f) => !f.disabled).map((f) => f.name),
    saves: [...document.querySelectorAll(".actions button")].map((b) => b.textContent + (b.disabled ? " (off)" : "")),
    why: [...document.querySelectorAll(".why")].map((p) => p.textContent),
})`);
const tab = async (by) => {
    await press(`.tab[fx-value-by="${by}"]`);
    await sleep(1200);
};

out.time = await shows();
await desk.picture(`${name}-time.png`);

if (!alice) {
    // A time zone: chosen, saved, and in /etc/localtime within a second.
    await put("zone", "Europe/London");
    await sleep(500);
    await press('form[fx-submit="save-zone"] button.primary');
    await sleep(2500);
    out.zone = { said: (await shows()).said, now: (await shows()).cards[0], guest: guest("date; clock status | head -2").trim() };
    await desk.picture(`${name}-zone.png`);

    // By hand: the form to set the clock, set to what it already is, and back.
    await press('button[fx-click="by-hand"]');
    await sleep(2000);
    out.byHand = await shows();
    await desk.picture(`${name}-by-hand.png`);
    const local = guest("date +%Y-%m-%dT%H:%M:%S").trim();
    await put("date", local.slice(0, 10));
    await put("clock", local.slice(11));
    await press('form[fx-submit="set-time"] button.primary');
    await sleep(2000);
    out.setClock = { said: (await shows()).said, guest: guest("clock status | head -3").trim() };
    await press('button[fx-click="automatic"]');
    await sleep(2000);
    out.automaticAgain = (await shows()).said;

    // UTC again.
    await put("zone", "");
    await sleep(400);
    out.zoneBackBefore = await settings.js(`({ value: document.querySelector("[name='zone']").value, save: document.querySelector('form[fx-submit="save-zone"] button.primary')?.outerHTML })`);
    await press('form[fx-submit="save-zone"] button.primary');
    await sleep(2000);
    out.zoneBack = { said: (await shows()).said, guest: guest("date") };
}

await tab("Language");
out.language = await shows();
await desk.picture(`${name}-language.png`);
if (!alice) {
    await put("keymap", "uk");
    await sleep(400);
    await press('form[fx-submit="save-keymap"] button.primary');
    await sleep(2500);
    out.keymap = { said: (await shows()).said, guest: guest('dumpkeys -C /dev/tty1 | grep "^keycode  43"').trim() };
    await put("keymap", "");
    await sleep(400);
    await press('form[fx-submit="save-keymap"] button.primary');
    await sleep(2500);
    out.keymapBack = guest('dumpkeys -C /dev/tty1 | grep "^keycode  43"').trim();
}

await tab("About");
out.about = await shows();
await desk.picture(`${name}-about.png`);
if (!alice) {
    const was = guest("hostname").trim();
    await put("hostname", "my machine");
    await sleep(800);
    out.badName = (await shows()).cards.find((c) => c.startsWith("Name"));
    await put("hostname", "settings-check");
    await sleep(400);
    await press('form[fx-submit="save-name"] button.primary');
    await sleep(2500);
    out.name = { said: (await shows()).said, guest: guest("hostname").trim() };
    // Back as it was: on a dev image nothing names the machine, so it was the
    // kernel's "(none)", which no form would take. The value goes, and the
    // kernel is told the old name.
    guest(`reg del 'Machine\\System\\Network' Hostname; hostname '${was}'`);
    out.nameBack = { was, now: guest("hostname") };
}

await tab("Startup");
out.startup = await shows();
await desk.picture(`${name}-startup.png`);

if (!alice) {
    // Half a screen: a second window tiles this one to half.
    await tab("Time");
    await desk.launch("event");
    await sleep(3000);
    out.half = await settings.js(`(() => {
        const page = document.documentElement;
        const over = [...document.querySelectorAll(".cards *")]
            .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0)
            .map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
        return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, over: [...new Set(over)].slice(0, 6) };
    })()`);
    await desk.picture(`${name}-half.png`);
    await gone(["Event Viewer"]);
}

out.log = settings.log;
await desk.finish(out);
