// System Settings, in headless Chromium
// (`node system-settings.mjs`, then `node system-settings.mjs alice`).
//
// As dana, an administrator: the time and how it is kept; a time zone,
// chosen from the list and applied at once, which timed puts in
// /etc/localtime; turning automatic off, setting the clock by hand, and on
// again; a choice that can't be saved, put back with why; the servers'
// list opened and cancelled; the console's layout, loaded at once; the
// machine's name, refused while it isn't one and applied when it is, which
// netd applies; a timeout edited, which brings Apply and Undo, and undone;
// Always Start in Safe Mode, on into the next boot's command line and off.
// Everything changed is put back. As alice, who isn't an administrator,
// every section reads, nothing can be changed, and each group says why. At
// half a screen, nothing is wider than its place and the side is icons.
import { guest as asGuest, session, sleep } from "./harness.mjs";

/** A guest command's output, without the exit status the channel adds. */
const guest = (command) =>
    asGuest(command)
        .replace(/\n?rc=\d+\s*$/, "")
        .trim();

const alice = process.argv[2] === "alice";
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "system-settings-alice" : "system-settings";

// The live image has no next boot's command line and no rebuilder, so the
// command-line group would only say it can't be changed. For this check the
// guest gets both for a while, before the window reads them: the line as
// booted, and an inert stand-in for dynamic-boot's mkuki-watch, taken away
// again at the end.
const madeLine =
    !alice && guest("test -e /lcl/etc/boot/cmdline && echo had || echo none") === "none";
if (madeLine) {
    guest(
        "mkdir -p /lcl/etc/boot && cat /proc/cmdline > /lcl/etc/boot/cmdline && svctl definition create mkuki-watch --set ImagePath=/usr/bin/true --set Type=Oneshot",
    );
}

const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
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
        const close = await desk.a.js(
            `(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
await gone(["Get started", "System Settings"]);
await desk.launch("system");
await gone(["Get started"]);
const settings = await window("System Settings", ".st-nav");
if (!settings) {
    out.stopped = "no System Settings window to attach to";
    await desk.finish(out, 1);
}
const press = (selector) =>
    settings
        .js(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(settings, selector));
/** Puts a value in a field as typing or choosing would. */
const put = (field, value) =>
    settings.js(`(() => {
    const f = document.querySelector("[name='${field}']");
    f.value = ${JSON.stringify(value)};
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
const value = (field) =>
    settings.js(
        `(() => { const f = document.querySelector("[name='${field}']"); return f ? (f.type === "checkbox" ? f.checked : f.value) : null; })()`,
    );
/** What the section shows: its groups, what can be changed, and what was said. */
const shows = () =>
    settings.js(`({
    section: document.querySelector('.st-nav [aria-current="page"] b')?.textContent ?? null,
    nav: [...document.querySelectorAll(".st-nav button")].map((b) => b.innerText.replaceAll("\\n", " — ")),
    said: document.querySelector(".st-status .said")?.textContent ?? null,
    groups: [...document.querySelectorAll(".st-group")].map((g) => g.innerText.replaceAll("\\n", " | ").slice(0, 400)),
    editable: [...document.querySelectorAll("input, select, textarea")].filter((f) => !f.disabled).map((f) => f.name),
    buttons: [...document.querySelectorAll(".st-page button")].filter((b) => !b.disabled).map((b) => b.textContent),
    locked: [...document.querySelectorAll(".st-foot")].map((p) => p.textContent),
})`);
const section = async (id) => {
    await press(`#st-nav-${id}`);
    await sleep(1200);
};

out.time = await shows();
await desk.picture(`${name}-time.png`);

if (!alice) {
    // A time zone: chosen, applied at once, and in /etc/localtime.
    await put("zone", "Europe/London");
    await sleep(3000);
    out.zone = {
        said: (await shows()).said,
        hero: await settings.js(`document.querySelector(".st-hero").innerText`),
        guest: guest("date; clock status | head -2"),
    };
    await desk.picture(`${name}-zone.png`);

    // By hand: the switch off, the clock set to what it already is, on again.
    await press('input[name="automatic"]');
    await sleep(2500);
    out.byHand = {
        said: (await shows()).said,
        form: await settings.js(`!!document.querySelector('form[fx-submit="set-time"]')`),
    };
    await desk.picture(`${name}-by-hand.png`);
    const local = guest("date +%Y-%m-%dT%H:%M:%S");
    await put("date", local.slice(0, 10));
    await put("clock", local.slice(11));
    await press('form[fx-submit="set-time"] button');
    await sleep(2000);
    out.setClock = { said: (await shows()).said, guest: guest("clock status | head -3") };
    await press('input[name="automatic"]');
    await sleep(2500);
    out.automaticAgain = { said: (await shows()).said, on: await value("automatic") };

    // A choice that can't be saved is put back, and why is said.
    await put("min-poll", "12");
    await sleep(2000);
    out.refused = { said: (await shows()).said, minPoll: await value("min-poll") };

    // The servers' list opens under its row, and closes untouched.
    await press('button[fx-click="edit-servers"]');
    await sleep(1200);
    out.serversOpen = await settings.js(`!!document.querySelector('textarea[name="servers"]')`);
    await desk.picture(`${name}-servers.png`);
    await press('button[fx-click="cancel-servers"]');
    await sleep(1200);
    out.serversClosed = await settings.js(`!document.querySelector('textarea[name="servers"]')`);

    // UTC again.
    await put("zone", "");
    await sleep(2500);
    out.zoneBack = { said: (await shows()).said, guest: guest("date") };
}

await section("language");
out.language = await shows();
await desk.picture(`${name}-language.png`);
if (!alice) {
    await put("keymap", "uk");
    await sleep(3000);
    out.keymap = {
        said: (await shows()).said,
        guest: guest('dumpkeys -C /dev/tty1 | grep "^keycode  43"'),
    };
    await put("keymap", "");
    await sleep(3000);
    out.keymapBack = guest('dumpkeys -C /dev/tty1 | grep "^keycode  43"');
}

await section("startup");
out.startup = await shows();
await desk.picture(`${name}-startup.png`);
if (!alice) {
    // Safe mode: on, applied at the next boot, said to hold until turned
    // off; then off, and the line as it was.
    const line = guest("cat /lcl/etc/boot/cmdline");
    await press('input[name="safemode"]');
    await sleep(800);
    out.safeEdited = (await shows()).buttons;
    await desk.picture(`${name}-safe-mode.png`);
    await press('form[fx-submit="save-cmdline"] button.primary');
    await sleep(1500);
    out.safeOn = {
        said: (await shows()).said,
        line: guest("cat /lcl/etc/boot/cmdline"),
        on: await value("safemode"),
    };
    await desk.picture(`${name}-safe-mode-saved.png`);
    await press('input[name="safemode"]');
    await sleep(800);
    await press('form[fx-submit="save-cmdline"] button.primary');
    await sleep(1500);
    out.safeOff = {
        said: (await shows()).said,
        line: guest("cat /lcl/etc/boot/cmdline"),
        as: line,
        on: await value("safemode"),
    };

    const was = await value("SettleTimeout");
    await put("SettleTimeout", "7");
    await sleep(800);
    out.timeoutEdited = (await shows()).buttons;
    await press('button[fx-click="undo-timeouts"]');
    await sleep(1000);
    out.timeoutUndone = {
        value: await value("SettleTimeout"),
        was,
        buttons: (await shows()).buttons,
    };
}

await section("about");
out.about = await shows();
await desk.picture(`${name}-about.png`);
if (!alice) {
    const was = guest("hostname");
    await put("hostname", "my machine");
    await sleep(800);
    out.badName = {
        locked: (await shows()).locked,
        apply: await settings.js(
            `document.querySelector('form[fx-submit="save-name"] button')?.disabled ?? null`,
        ),
    };
    // A name it hasn't got, so that there is something to apply.
    await put("hostname", was === "settings-check" ? "settings-check-2" : "settings-check");
    await sleep(800);
    await press('form[fx-submit="save-name"] button');
    await sleep(2500);
    out.name = {
        said: (await shows()).said,
        guest: guest("hostname"),
        nav: (await shows()).nav.at(-1),
    };
    // Back as it was: on a dev image nothing names the machine, so it was the
    // kernel's "(none)", which no field would take. The value goes, and the
    // kernel is told the old name.
    guest(`reg del 'Machine\\System\\Network' Hostname; hostname '${was}'`);
    out.nameBack = { was, now: guest("hostname") };
}

// Half a screen: a second window tiles this one to half.
await section("time");
await desk.launch("event");
await sleep(3000);
out.half = await settings.js(`(() => {
    const page = document.documentElement;
    const over = [...document.querySelectorAll(".st-page *")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0)
        .map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
    return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, over: [...new Set(over)].slice(0, 6), side: document.querySelector(".st-nav").clientWidth };
})()`);
await desk.picture(`${name}-half.png`);
await gone(["Event Viewer"]);
if (madeLine) {
    guest("rm -f /lcl/etc/boot/cmdline; svctl definition delete mkuki-watch");
}

out.log = settings.log;
await desk.finish(out);
