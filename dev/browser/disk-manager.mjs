// Disk Manager, in headless Chromium
// (`node disk-manager.mjs`, `node disk-manager.mjs alice`,
// `node disk-manager.mjs light`).
//
// The VM needs the disks ../gxwi-disk-manager/dev/disks.sh makes, attached
// as it says, with /dev/vdb2 mounted at /mnt/data and /dev/sda1 at
// /mnt/stick:
//
//     mkdir -p /mnt/data /mnt/stick
//     mount -o policy=synth-ephemeral /dev/vdb2 /mnt/data
//     mount -o policy=synth-ephemeral,ro /dev/sda1 /mnt/stick
//
// As dana: the medium, which Peios runs from; the fixed disk with its bar;
// a partition added in its free space, which the stand-in for the disk
// service refuses, saying so; a mounted partition, which can't be
// formatted; one never formatted, formatted; one not mounted, mounted;
// the mounts, a mount's policy changed; a filesystem added at startup; the
// USB stick; at half a screen, nothing wider than its place.
// As alice, who may not change disks: everything shown, read-only, said
// once.
import { session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const light = process.argv[2] === "light";
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "disk-manager-alice" : light ? "disk-manager-light" : "disk-manager";

const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
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
        const close = await desk.a.js(
            `(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
await gone([""]);
await desk.launch("disk");
await gone(["Get started"]);
const w = await window("Disk Manager", ".st-nav");
if (!w) {
    out.stopped = "no Disk Manager window to attach to";
    await desk.finish(out, 1);
}

const press = (selector) =>
    w
        .js(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(w, selector));
/** Presses the first button (or link row) whose text starts with `text`. */
const button = async (text, within = ".st-page") => {
    const found = await w.js(
        `(() => { const b = [...document.querySelectorAll(${JSON.stringify(within + " button")})].find((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!b) return false; b.setAttribute("data-test", "this"); return true; })()`,
    );
    if (!found) return false;
    await press('[data-test="this"]');
    await w.js(`document.querySelector('[data-test="this"]')?.removeAttribute("data-test")`);
    await sleep(700);
    return true;
};
const section = (id) => press(`[id="st-nav-${id}"]`).then(() => sleep(1200));
const put = (field, value) =>
    w
        .js(
            `(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); })()`,
        )
        .then(() => sleep(600));
const shows = () =>
    w.js(`({
    said: document.querySelector(".st-status .said")?.textContent ?? null,
    hero: [...document.querySelectorAll(".st-hero, .st-head")].map((h) => h.innerText.replaceAll("\\n", " | ")),
    banner: [...document.querySelectorAll(".st-banner")].map((b) => b.textContent),
    bar: [...document.querySelectorAll(".dm-seg")].map((s) => s.innerText.replaceAll("\\n", " ") + " [" + Math.round(s.getBoundingClientRect().width) + "px]"),
    groups: [...document.querySelectorAll(".st-group")].map((g) => g.innerText.replaceAll("\\n", " | ").slice(0, 500)),
    form: document.querySelector(".st-more")?.innerText.replaceAll("\\n", " | ") ?? null,
    buttons: [...document.querySelectorAll(".st-page button:not(.st-row)")].filter((b) => !b.disabled).map((b) => b.innerText.trim()),
    disabled: [...document.querySelectorAll(".st-page button")].filter((b) => b.disabled).map((b) => b.innerText.trim()),
    nav: [...document.querySelectorAll(".st-nav button")].map((b) => b.innerText.replaceAll("\\n", " · ")),
})`);
const wide = () =>
    w.js(`(() => {
    const page = document.documentElement;
    const over = [...document.querySelectorAll(".st-page *")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0)
        .map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
    return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, over: [...new Set(over)].slice(0, 6) };
})()`);
await sleep(2500);

if (light) {
    const scheme = { features: [{ name: "prefers-color-scheme", value: "light" }] };
    await desk.a.send("Emulation.setEmulatedMedia", scheme);
    await w.send("Emulation.setEmulatedMedia", scheme);
    await section("disk:vdb");
    await sleep(800);
    await desk.picture(`${name}.png`);
    await button("Partition 2");
    await desk.picture(`${name}-volume.png`);
    await desk.finish(out);
}

out.medium = await shows();
await desk.picture(`${name}-medium.png`);

await section("disk:vdb");
out.disk = await shows();
await desk.picture(`${name}.png`);

if (!alice) {
    // A partition in the free space: the form, then the stand-in's answer.
    await press(".dm-seg.free");
    await sleep(800);
    out.addForm = await shows();
    await desk.picture(`${name}-add.png`);
    await put("add-size", "1.5");
    await put("add-name", "Backups");
    await put("add-label", "backups");
    await press('form[fx-submit="add-partition"] button.primary');
    await sleep(1200);
    out.added = await shows();
    await desk.picture(`${name}-added.png`);
}

// A mounted partition: what it is, how full, where it is mounted.
await button("Partition 2");
out.mounted = await shows();
await desk.picture(`${name}-volume.png`);
(await button("vdb", ".st-page .st-back")) || (await press(".st-back"));
await sleep(800);

if (!alice) {
    // One never formatted: formatting it.
    await button("Partition 3");
    await button("Format…");
    out.formatForm = await shows();
    await desk.picture(`${name}-format.png`);
    // The new filesystem's top folder, in the permissions editor.
    await button("Permissions…");
    await sleep(3000);
    out.editor = (await strips()).map((s) => s.title);
    await desk.picture(`${name}-permissions.png`);
    await gone(["Permissions", "Security", "The new filesystem"]);
    await sleep(1000);
    out.afterEditor = (await strips()).map((s) => s.title);
    await button("Cancel");
    await press(".st-back");
    await sleep(800);
    // One not mounted: mounting it.
    await button("Partition 1");
    await button("Mount…");
    await put("mount-policy", "deny-missing");
    out.mountForm = await shows();
    await desk.picture(`${name}-mount.png`);
    await button("Cancel");
    await press(".st-back");
    await sleep(800);
}

// Half a screen: a second window tiles this one to half.
await desk.launch("event");
await sleep(3000);
out.half = await wide();
await desk.picture(`${name}-half.png`);
await gone(["Event Viewer"]);
await sleep(1000);

// Everything mounted, and one mount's own page.
await section("mounts");
out.mounts = await shows();
await desk.picture(`${name}-mounts.png`);
await button("/mnt/data");
out.mount = await shows();
await desk.picture(`${name}-mount-page.png`);
if (!alice) {
    await put(
        `${await w.js(`document.querySelector("select[name^='policy:']")?.name`)}`,
        "synth-persist",
    );
    await sleep(800);
    out.policy = await shows();
    out.policyField = await w.js(`document.querySelector("select[name^='policy:']")?.value`);
    await desk.picture(`${name}-policy.png`);
}

// What is mounted at startup.
await section("startup");
if (!alice) {
    await button("Add…");
    await put(
        "startup-fs",
        await w.js(
            `[...document.querySelectorAll("select[name=startup-fs] option")].find((o) => o.textContent.startsWith("data"))?.value ?? ""`,
        ),
    );
}
out.startup = await shows();
await desk.picture(`${name}-startup.png`);

// The USB stick.
await section("disk:sda");
out.stick = await shows();
await desk.picture(`${name}-stick.png`);

out.log = w.log;
await desk.finish(out);
