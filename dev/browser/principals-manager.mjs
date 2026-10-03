// Principals Manager, in headless Chromium, as dana, an administrator
// (`node principals-manager.mjs`).
//
// It opens on the users, each said to be local or built-in, enabled or not.
// A user picked is shown in full; a group of theirs leads to the group, and
// the group to its members. Finding narrows the list. A group made from a
// terminal appears without Refresh, and goes again when it is deleted.
//
// As alice (`node principals-manager.mjs alice`), who isn't an
// administrator: everything is still listed and shown, and the window says
// she may look but not change anything, and why.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const GROUP = "pmcheck";
if (!alice) guest(`lps group delete ${GROUP} >/dev/null 2>&1; echo ok`);
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "principals-manager-alice" : "principals-manager";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
/** The frame of the window whose title starts `title`, once it is there. */
async function window(title, has) {
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).filter((strip) => strip.title.startsWith(title));
        if (ours.length > 0) {
            const frame = (await desk.frames(has))[0];
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
await gone(["Get started", "Principals Manager"]);
await desk.launch("principals");
await gone(["Get started"]);
const manager = await window("Principals Manager", ".list");
if (!manager) {
    out.stopped = "no Principals Manager window to attach to";
    await desk.finish(out, 1);
}

/** What the window shows. */
const shows = () => manager.js(`({
    tabs: [...document.querySelectorAll(".tab")].map((b) => b.textContent + (b.getAttribute("aria-pressed") === "true" ? " (shown)" : "")),
    rows: [...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | ") + (b.getAttribute("aria-selected") === "true" ? " (picked)" : "")),
    listing: document.querySelector(".list .trouble, .list .more")?.textContent ?? null,
    details: document.querySelector(".details")?.innerText.replaceAll("\\n", " / ") ?? null,
    said: document.querySelector(".said")?.textContent ?? null,
    footer: document.querySelector(".status")?.innerText.replaceAll("\\n", " / ") ?? null,
})`);
async function until(ready, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 300) {
        const now = await shows();
        if (ready(now)) return now;
        await sleep(300);
    }
    return shows();
}
const press = (selector) => manager.js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`).then(() => desk.press(manager, selector));
const sidOf = (who) => manager.js(`[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === ${JSON.stringify(who)})?.getAttribute("fx-value-sid") ?? null`);

out.users = await until((s) => s.rows.some((row) => row.startsWith("dana")));
await desk.picture(`${name}-users.png`);

// dana in full, and her group leading to it.
const dana = await sidOf("dana");
if (dana) {
    await press(`.entries button[fx-value-sid="${dana}"]`);
    out.dana = (await until((s) => (s.details ?? "").includes("SID"))).details;
    await desk.picture(`${name}-dana.png`);
    const admins = `.details .link[fx-value-sid="S-1-5-32-544"]`;
    if (await manager.js(`!!document.querySelector('${admins}')`)) {
        await press(admins);
        const group = await until((s) => (s.details ?? "").includes("Members"));
        out.administrators = { tabs: group.tabs, details: group.details };
        await desk.picture(`${name}-administrators.png`);
    }
}

// The groups, and finding in them.
await press(`.tab[fx-click="groups"]`);
out.groups = (await until((s) => s.tabs.includes("Groups (shown)"))).rows;
await manager.js(`(() => { const f = document.querySelector("[name=filter]"); f.value = "admin"; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await sleep(600);
out.found = (await shows()).rows;
await manager.js(`(() => { const f = document.querySelector("[name=filter]"); f.value = ""; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await sleep(400);

if (!alice) {
    // A group made on a terminal appears, and goes, without Refresh.
    out.made = guest(`lps group create ${GROUP}`);
    out.appeared = (await until((s) => s.rows.some((row) => row.startsWith(GROUP)), 15000)).rows.filter((row) => row.startsWith(GROUP));
    await desk.picture(`${name}-appeared.png`);
    guest(`lps group delete ${GROUP}`);
    out.went = !(await until((s) => !s.rows.some((row) => row.startsWith(GROUP)), 15000)).rows.some((row) => row.startsWith(GROUP));
}
out.said = (await shows()).said;
out.footer = (await shows()).footer;
await desk.picture(`${name}-groups.png`);
await desk.finish(out);
