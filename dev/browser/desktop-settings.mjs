// Desktop Settings, in headless Chromium (`node desktop-settings.mjs`, then
// `node desktop-settings.mjs alice`).
//
// For me: a 12-hour clock shows in the top bar at once; a wallpaper chosen
// in the file dialog replaces the desktop's at once; Get started opens
// again. Each is put back. For this machine, as dana: the sign-in page's
// name is saved; changing the compositor is asked about first, with what
// it means, and left alone when told not to. As alice: her own settings can
// be changed, and the machine's are shown with why they can't.
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();
const alice = process.argv[2] === "alice";
const who = alice ? "alice" : "dana";
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "desktop-settings-alice" : "desktop-settings";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
async function gone(titles) {
    for (const strip of await strips()) {
        if (!titles.some((title) => strip.title.startsWith(title))) continue;
        const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
await gone(["Get started", "Desktop Settings"]);
await desk.launch("desktop");
await sleep(1500);
const w = (await desk.frames(".cards")).at(-1);
if (!w) {
    out.stopped = "no Desktop Settings window";
    await desk.finish(out, 1);
}
w.surface = `.fx-surface[data-id="${(await strips()).filter((s) => s.title.startsWith("Desktop Settings")).at(-1).id}"]`;
const shows = () => w.js(`({
    tab: document.querySelector('.tab[aria-pressed="true"]')?.textContent,
    said: document.querySelector(".said")?.textContent ?? null,
    cards: [...document.querySelectorAll(".card")].map((c) => c.innerText.replaceAll("\\n", " | ").slice(0, 300)),
    editable: [...document.querySelectorAll("input, select, textarea")].filter((f) => !f.disabled).map((f) => f.name),
    buttons: [...document.querySelectorAll(".actions button")].filter((b) => !b.disabled).map((b) => b.textContent),
    why: [...document.querySelectorAll(".why")].map((p) => p.textContent),
})`);
const put = (field, value) => w.js(`(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); })()`);
const press = async (selector) => {
    await w.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`);
    return desk.press(w, selector);
};
const topbar = async () => (await desk.frames(".topbar")).at(-1).js(`document.querySelector(".topbar .clock").textContent`);
const wallpaper = async () => (await desk.frames(".wallpaper")).at(-1).js(`document.querySelector(".wallpaper img")?.getAttribute("src")`);

out.me = await shows();
await desk.picture(`${name}-me.png`);

// The clock, 12-hour, and back.
out.clockBefore = await topbar();
await put("hours", "12");
await sleep(500);
await press('form[fx-submit="save-hours"] button.primary');
await sleep(1500);
out.clock12 = { said: (await shows()).said, bar: await topbar() };
await put("hours", "");
await sleep(500);
await press('form[fx-submit="save-hours"] button.primary');
await sleep(1500);
out.clockBack = await topbar();

// A wallpaper of their own, chosen in the file dialog.
guest(`cp /usr/share/icons/base/dev.peios.fenesh.settings.svg /home/${who}/my-wallpaper.svg 2>/dev/null || cp /usr/share/icons/base/*.svg /home/${who}/my-wallpaper.svg; chown ${who} /home/${who}/my-wallpaper.svg 2>/dev/null; sd allow /home/${who}/my-wallpaper.svg ${who}:r >/dev/null`);
out.wallpaperBefore = await wallpaper();
await press('button[fx-click="choose-wallpaper"]');
await sleep(2500);
const dialog = await desk.frame(".chooser", '.fx-surface[data-role="dialog"]');
if (dialog) {
    const entry = await dialog.js(`(() => { const e = [...document.querySelectorAll("[fx-value-name], button, li")].find((x) => x.textContent.includes("my-wallpaper.svg")); if (!e) return null; e.scrollIntoView({ block: "center" }); return true; })()`);
    out.dialogSawFile = entry;
    const target = `[fx-value-name="my-wallpaper.svg"]`;
    await desk.doublePress(dialog, target);
    await sleep(2500);
}
out.wallpaperChosen = { said: (await shows()).said, src: await wallpaper(), own: guest(`reg get 'Users\\\\'$(lps show ${who} 2>/dev/null | grep -o 'S-1-5-21[-0-9]*' | head -1)'\\\\Software\\\\fenesh' Wallpaper 2>&1`) };
await desk.picture(`${name}-wallpaper.png`);
await press('button[fx-click="own-wallpaper-off"]');
await sleep(2000);
out.wallpaperBack = { said: (await shows()).said, src: await wallpaper() };

// Get started, again.
await press('button[fx-click="welcome-again"]');
await sleep(3000);
out.welcome = { said: (await shows()).said, windows: (await strips()).map((s) => s.title) };
await gone(["Get started"]);

// For this machine.
await press('.tab[fx-value-by="Machine"]');
await sleep(1200);
out.machine = await shows();
await desk.picture(`${name}-machine.png`);
if (!alice) {
    const was = guest(`reg get 'Machine\\Software\\GXWI\\Logon' Name 2>/dev/null`);
    await put("logon-name", "Settings check");
    await sleep(500);
    await press('form[fx-submit="save-logon"] button.primary');
    await sleep(1500);
    out.logon = { said: (await shows()).said, registry: guest(`reg get 'Machine\\Software\\GXWI\\Logon' Name`) };
    await put("logon-name", was);
    await sleep(500);
    await press('form[fx-submit="save-logon"] button.primary');
    await sleep(1500);

    await put("compositor", "/usr/bin/something-else");
    await sleep(500);
    await press('form[fx-submit="save-advanced"] button.primary');
    await sleep(1500);
    out.asked = await w.js(`document.querySelector(".asking")?.innerText ?? null`);
    await desk.picture(`${name}-asking.png`);
    await press('button[fx-click="cancel"]');
    await sleep(1000);
    out.afterCancel = { asking: await w.js(`!!document.querySelector(".asking")`), registry: guest(`reg get 'Machine\\Software\\GXWI' Compositor`) };
    await put("compositor", guest(`reg get 'Machine\\Software\\GXWI' Compositor`));
}

out.log = w.log;
await desk.finish(out);
