// Principals Manager's account changes, in headless Chromium, as dana, an
// administrator (`node principals-accounts.mjs`).
//
// A user is made from the window (asked for with Ctrl+N), then edited,
// renamed, narrowed to signing in over the network, given a password (two
// that differ are refused first), disabled and enabled, and deleted after
// being asked. Each change is checked on the guest with lps as well as in
// the window. A name already held is refused in lpsd's words. Then a user
// made to need no password is given one, and signs in with it from then on.
import { guest, session, sleep } from "./harness.mjs";

const FIRST = "pmuser";
const SECOND = "pmuser2";
guest(`lps remove ${FIRST} >/dev/null 2>&1; lps remove ${SECOND} >/dev/null 2>&1; echo ok`);
const desk = await session(9366, { user: "dana", password: "dana-dev-password" });
const out = {};
const name = "principals-accounts";

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
    rows: [...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | ") + (b.getAttribute("aria-selected") === "true" ? " (picked)" : "")),
    details: document.querySelector(".details")?.innerText.replaceAll("\\n", " / ") ?? null,
    said: document.querySelector(".details .note[role]")?.textContent ?? null,
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
async function fill(field, value) {
    await manager.js(`(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await sleep(150);
}
const said = async (what) => (await until((s) => (s.said ?? "").includes(what))).said;
const lps = (who) => guest(`lps show ${who} 2>&1`).split("\n").filter((line) => /^(name|display name|home|shell|state|logon types|credential) /.test(line)).join(" / ");

await until((s) => s.rows.some((row) => row.startsWith("dana")));

// A new user, asked for with Ctrl+N while the window has the keyboard.
await press(`.entries button`);
await desk.key("n", { code: "KeyN", vk: 78, modifiers: 2 });
out.ctrlN = (await until((s) => (s.details ?? "").startsWith("New user"), 5000)).details?.startsWith("New user") ?? false;
if (!out.ctrlN) await press(`.bar button[fx-click="new"]`);
await until((s) => (s.details ?? "").startsWith("New user"));
await fill("name", FIRST);
await fill("full", "Pat Morgan");
await fill("password", "pm-first-password");
await fill("again", "pm-first-password");
await desk.picture(`${name}-new.png`);
await press(`.details button[type="submit"]`);
out.made = await said("is made");
out.madePicked = (await until((s) => (s.details ?? "").includes("Pat Morgan"))).rows.filter((row) => row.includes("(picked)"));
out.madeOnGuest = lps(FIRST);
await desk.picture(`${name}-made.png`);

// Its profile.
await press(`.details button[fx-click="edit"]`);
await until((s) => (s.details ?? "").includes("Shell"));
await fill("shell", "/bin/bash");
await press(`.details button[type="submit"]`);
out.edited = await said("is changed");
out.editedOnGuest = lps(FIRST);

// A name already held is lpsd's to refuse.
await press(`.details button[fx-click="rename"]`);
await until((s) => (s.details ?? "").includes("New name"));
await fill("new-name", "dana");
await press(`.details button[type="submit"]`);
out.renameRefused = (await until((s) => (s.said ?? "").includes("exists"))).said;
await desk.picture(`${name}-refused.png`);
await fill("new-name", SECOND);
await press(`.details button[type="submit"]`);
out.renamed = await said("is now called");
out.renamedOnGuest = lps(SECOND);

// Only over the network.
await press(`.details button[fx-click="sign-in"]`);
await until((s) => (s.details ?? "").includes("May sign in"));
await press(`.details input[name="which"][value="chosen"]`);
await sleep(300);
for (let index = 0; index < 7; index++) {
    const ticked = await manager.js(`document.querySelector("[name='type-${index}']").checked`);
    const label = await manager.js(`document.querySelector("[name='type-${index}']").parentElement.textContent.trim()`);
    if (ticked !== (label === "Over the network")) await press(`.details input[name="type-${index}"]`);
}
await desk.picture(`${name}-sign-in.png`);
await press(`.details button[type="submit"]`);
out.signIn = await said("may sign in is changed");
out.signInShown = (await shows()).details.match(/May sign in \/ [^/]*/)?.[0] ?? null;
out.signInOnGuest = lps(SECOND);

// A password: two that differ are refused before lpsd is asked.
await press(`.details button[fx-click="password"]`);
await until((s) => (s.details ?? "").includes("Again"));
await fill("password", "pm-second-password");
await fill("again", "pm-other-password");
await press(`.details button[type="submit"]`);
out.passwordsDiffer = (await until((s) => (s.said ?? "").includes("differ"))).said;
out.passwordsCleared = await manager.js(`document.querySelector("[name=password]").value === "" && document.querySelector("[name=again]").value === ""`);
await fill("password", "pm-second-password");
await fill("again", "pm-second-password");
await press(`.details button[type="submit"]`);
out.password = await said("password is set");

// Disabled, then enabled.
await press(`.details button[fx-click="disable"]`);
out.disabled = await said("disabled");
out.disabledRow = (await shows()).rows.filter((row) => row.startsWith(SECOND));
await press(`.details button[fx-click="enable"]`);
out.enabled = await said("is enabled");

// Deleted, after being asked.
await press(`.details button[fx-click="delete"]`);
out.asked = (await until((s) => (s.details ?? "").includes("can't be undone"))).details.match(/Delete [^?]*\?[^/]*/)?.[0] ?? null;
await desk.picture(`${name}-delete.png`);
await press(`.details button[fx-click="delete-yes"]`);
out.deleted = await said("is deleted");
out.goneFromList = !(await until((s) => !s.rows.some((row) => row.startsWith(SECOND)))).rows.some((row) => row.startsWith(SECOND));
out.goneOnGuest = guest(`lps show ${SECOND} 2>&1`).trim();
await desk.picture(`${name}-deleted.png`);

// A user made to need no password, given one, then signs in with it.
await press(`.bar button[fx-click="new"]`);
await until((s) => (s.details ?? "").startsWith("New user"));
await fill("name", FIRST);
await press(`.details input[name="no-password"]`);
await until((s) => !(s.details ?? "").includes("Again"));
await press(`.details button[type="submit"]`);
out.kiosk = await said("is made");
out.kioskOnGuest = lps(FIRST);
await press(`.details button[fx-click="password"]`);
out.kioskNote = (await until((s) => (s.details ?? "").includes("Again"))).details.match(/They sign in without a password[^/]*/)?.[0] ?? null;
await fill("password", "pm-kiosk-password");
await fill("again", "pm-kiosk-password");
await press(`.details button[type="submit"]`);
out.kioskPassword = await said("password is set");
out.kioskPasswordOnGuest = lps(FIRST);
guest(`lps remove ${FIRST}`);
await desk.finish(out);
