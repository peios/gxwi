// Desktop Settings, in headless Chromium (`node desktop-settings.mjs`, then
// `node desktop-settings.mjs alice`).
//
// For you: a wallpaper chosen in the file dialog replaces the desktop's and
// the preview at once, and is put back; a 12-hour clock, chosen from the
// list, shows in the top bar at once; a shortcut that another action has is
// refused when pressed; one pressed for the launcher reaches the launcher at
// once, and its chip taken away and its value reset put it back; the dock's
// keys are set by holding them with a number; a type of file given an
// application, and put back; Get started opened again. For this machine, as
// dana: the sign-in page's name applied and put back; changing the
// compositor is reviewed, said in full, and left alone. As alice, her own
// sections can be changed and the machine's are shown, with why, once.
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) =>
    asGuest(command)
        .replace(/\n?rc=\d+\s*$/, "")
        .trim();
const alice = process.argv[2] === "alice";
const who = alice ? "alice" : "dana";
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "desktop-settings-alice" : "desktop-settings";

const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
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
await gone(["Get started", "Desktop Settings"]);
await desk.launch("desktop");
await sleep(1500);
const w = (await desk.frames(".st-nav")).at(-1);
if (!w) {
    out.stopped = "no Desktop Settings window";
    await desk.finish(out, 1);
}
w.surface = `.fx-surface[data-id="${(await strips()).filter((s) => s.title.startsWith("Desktop Settings")).at(-1).id}"]`;
const shows = () =>
    w.js(`({
    section: document.querySelector('.st-nav [aria-current="page"] b')?.textContent ?? null,
    said: document.querySelector(".st-status .said")?.textContent ?? null,
    groups: [...document.querySelectorAll(".st-group, .st-banner")].map((g) => g.innerText.replaceAll("\\n", " | ").slice(0, 300)),
    editable: [...document.querySelectorAll("input, select, textarea")].filter((f) => !f.disabled).map((f) => f.name),
    buttons: [...document.querySelectorAll(".st-page button")].filter((b) => !b.disabled).map((b) => b.textContent),
})`);
const put = (field, value) =>
    w.js(
        `(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); })()`,
    );
const press = async (selector) => {
    await w.js(
        `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
    );
    return desk.press(w, selector);
};
const section = async (id) => {
    await press(`#st-nav-${id}`);
    await sleep(1200);
};
const topbar = async () =>
    (await desk.frames(".topbar"))
        .at(-1)
        .js(`document.querySelector(".topbar .clock").textContent`);
const wallpaper = async () =>
    (await desk.frames(".wallpaper"))
        .filter(Boolean)
        .at(0)
        ?.js(`document.querySelector(".wallpaper img")?.getAttribute("src")`);
/** Every global key the shell's surfaces claim that isn't the dock's digits. */
const launcherKeys = async () => {
    const all = [];
    for (const frame of await desk.frames("[fx-global-key]")) {
        all.push(
            ...(await frame.js(
                `[...document.querySelectorAll("[fx-global-key]")].map((e) => e.getAttribute("fx-global-key"))`,
            )),
        );
    }
    return all.filter((keys) => !/^(\S+\+)?\S*\d$/.test(keys) || keys.includes("Space"));
};
/** Presses the recorder of action `id`, then the keys. */
const record = async (id, key, code, modifiers) => {
    await press(`button[fx-record="record-chord"][fx-value-id="${id}"]`);
    await sleep(500);
    const waiting = await w.js(
        `document.querySelector('button[fx-record][fx-value-id="${id}"]').dataset.fxRecording`,
    );
    // A modifier pressed on its own is waited past, as a person's fingers
    // land one at a time.
    await desk.key("Control", { code: "ControlLeft", modifiers: CTRL, vk: 17 });
    const stillWaiting = await w.js(
        `document.querySelector('button[fx-record][fx-value-id="${id}"]').dataset.fxRecording`,
    );
    await desk.key(key, { code, modifiers });
    await sleep(1500);
    return { waiting, stillWaiting, said: (await shows()).said };
};
// Chrome's modifier bits.
const ALT = 1,
    CTRL = 2;

out.wallpaperPage = await shows();
await desk.picture(`${name}-wallpaper.png`);

/** The gallery's tiles: each title, and whether it is the one chosen. */
const tiles = () =>
    w.js(
        `[...document.querySelectorAll(".gallery .tile")].map((t) => t.innerText + (t.getAttribute("aria-pressed") === "true" ? " ✓" : ""))`,
    );
out.tiles = await tiles();

// A shipped wallpaper, picked from the gallery.
const desktopBefore = await wallpaper();
await press(`.gallery .tile[fx-value-path="/usr/share/wallpapers/peios/winter-ridge.webp"]`);
await sleep(2500);
out.shipped = {
    said: (await shows()).said,
    tiles: await tiles(),
    desktop: [desktopBefore, await wallpaper()],
    registry: guest(
        `reg get 'Users\\\\'$(lps show ${who} | grep -o 'S-1-5-21[-0-9]*' | head -1)'\\\\Software\\\\fenesh' Wallpaper 2>&1`,
    ),
};
await desk.picture(`${name}-wallpaper-light.png`);

// A wallpaper of their own, chosen in the file dialog.
guest(
    `cp /usr/share/icons/base/dev.peios.fenesh.settings.svg /home/${who}/my-wallpaper.svg 2>/dev/null || cp /usr/share/icons/base/*.svg /home/${who}/my-wallpaper.svg; chown ${who} /home/${who}/my-wallpaper.svg 2>/dev/null; sd allow /home/${who}/my-wallpaper.svg ${who}:r >/dev/null`,
);
await press('button[fx-click="choose-wallpaper"]');
await sleep(2500);
const dialog = await desk.frame(".chooser", '.fx-surface[data-role="dialog"]');
if (dialog) {
    await dialog.js(
        `(() => { const e = [...document.querySelectorAll("[fx-value-name]")].find((x) => x.textContent.includes("my-wallpaper.svg")); e?.scrollIntoView({ block: "center" }); })()`,
    );
    await desk.doublePress(dialog, `[fx-value-name="my-wallpaper.svg"]`);
    await sleep(2500);
}
out.wallpaperChosen = {
    said: (await shows()).said,
    tiles: await tiles(),
    desktop: await wallpaper(),
};
await desk.picture(`${name}-wallpaper-chosen.png`);
await press('.gallery .tile[fx-value-path=""]');
await sleep(2000);
out.wallpaperBack = { said: (await shows()).said, tiles: await tiles() };

// The clock, 12-hour, and back.
await section("clock");
await put("hours", "12");
await sleep(2000);
out.clock12 = { said: (await shows()).said, bar: await topbar() };
await put("hours", "");
await sleep(2000);
out.clockBack = await topbar();

// Shortcuts: pressed, refused, added, taken away, reset.
await section("keys");
await desk.picture(`${name}-keys.png`);
out.launcherBefore = await launcherKeys();
out.clash = await record("NextTile", "j", "KeyJ", ALT);
out.added = await record("Launcher", " ", "Space", CTRL | ALT);
out.added.keys = await launcherKeys();
await desk.picture(`${name}-keys-added.png`);
await press('button.x[fx-value-id="Launcher"][fx-value-chord="Ctrl+Alt+Space"]');
await sleep(1500);
out.removed = {
    said: (await shows()).said,
    keys: await launcherKeys(),
    reset: await w.js(
        `!!document.querySelector('button[fx-click="reset-chord"][fx-value-id="Launcher"]')`,
    ),
};
await press('button[fx-click="reset-chord"][fx-value-id="Launcher"]');
await sleep(1500);
out.reset = {
    said: (await shows()).said,
    keys: await launcherKeys(),
    own: guest(
        `reg get 'Users\\\\'$(lps show ${who} | grep -o 'S-1-5-21[-0-9]*' | head -1)'\\\\Software\\\\Fenestra\\\\Shortcuts' Launcher 2>&1`,
    ),
};
out.dock = await record("DockItem", "3", "Digit3", CTRL);
out.dock.chips = await w.js(
    `[...document.querySelectorAll(".st-chord")].map((c) => c.innerText.replaceAll("\\n", "")).join(" / ")`,
);
await press('button[fx-click="reset-chord"][fx-value-id="DockItem"]');
await sleep(1500);

// Which application opens a type: the first type there is a choice for.
await section("files");
await desk.picture(`${name}-files.png`);
const choice = await w.js(`(() => {
    const select = [...document.querySelectorAll('select[name^="app:"]')].find((s) => s.options.length > 1);
    return select ? { name: select.name, value: select.options[1].value, label: select.closest(".st-row").querySelector("b").textContent } : null;
})()`);
if (choice) {
    await put(choice.name, choice.value);
    await sleep(1500);
    out.app = { choice, said: (await shows()).said };
    await put(choice.name, "");
    await sleep(1500);
}

// Get started, again.
await section("dock");
await press('button[fx-click="welcome-again"]');
await sleep(3000);
out.welcome = {
    said: (await shows()).said,
    open: (await strips()).some((s) => s.title.startsWith("Get started")),
};
await gone(["Get started"]);

// This machine.
await section("sign-in");
out.signIn = await shows();
await desk.picture(`${name}-sign-in.png`);
if (!alice) {
    const was = guest(`reg get 'Machine\\Software\\GXWI\\Logon' Name 2>/dev/null`);
    await put("logon-name", "Settings check");
    await sleep(800);
    await press('form[fx-submit="save-logon"] button:not([type="button"])');
    await sleep(1500);
    out.logon = {
        said: (await shows()).said,
        registry: guest(`reg get 'Machine\\Software\\GXWI\\Logon' Name`),
    };
    await put("logon-name", was);
    await sleep(800);
    await press('form[fx-submit="save-logon"] button:not([type="button"])');
    await sleep(1500);
}

await section("everyone");
out.everyone = await shows();
await desk.picture(`${name}-everyone.png`);

await section("advanced");
out.advanced = await shows();
if (!alice) {
    await put("compositor", "/usr/bin/something-else");
    await sleep(800);
    await press('form[fx-submit="save-advanced"] button:not([type="button"])');
    await sleep(1500);
    out.asked = await w.js(`document.querySelector(".st-more.asking")?.innerText ?? null`);
    await desk.picture(`${name}-asking.png`);
    await press('button[fx-click="cancel"]');
    await sleep(1000);
    await press('button[fx-click="undo-advanced"]');
    await sleep(1000);
    out.afterCancel = {
        asking: await w.js(`!!document.querySelector(".st-more.asking")`),
        field: await w.js(`document.querySelector("[name='compositor']").value`),
        registry: guest(`reg get 'Machine\\Software\\GXWI' Compositor`),
    };
}

await section("everyones-keys");
out.everyonesKeys = {
    editable: (await shows()).buttons.length,
    groups: (await shows()).groups.slice(0, 1),
};
await desk.picture(`${name}-everyones-keys.png`);

out.log = w.log;
await desk.finish(out);
