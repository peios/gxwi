// Principals Manager's groups, in headless Chromium, as dana, an
// administrator (`node principals-groups.mjs`).
//
// A group is made from the window (Ctrl+N in the Groups list), described,
// renamed, and given a member; a group with a member is not offered for
// deleting; the member is taken out again. Administrators, a BUILTIN group,
// takes a member and loses it. From the user's side, they are added to the
// group, made to have it as their primary group, and taken out of it. The
// group is deleted once nobody needs it. Each change is checked on the guest
// with lps as well as in the window.
//
// As alice (`node principals-groups.mjs alice`), who isn't an administrator:
// the groups and their descriptions are shown, and nothing offers a change.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const GROUP = "pmgroup";
const RENAMED = "pmgroup2";
const MEMBER = "pmmember";
if (!alice) {
    guest(`lps remove ${MEMBER} >/dev/null 2>&1; lps group delete ${GROUP} >/dev/null 2>&1; lps group delete ${RENAMED} >/dev/null 2>&1; lps add ${MEMBER} --no-password --no-prompt`);
}
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "principals-groups-alice" : "principals-groups";

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
    bar: [...document.querySelectorAll(".bar button")].map((b) => b.textContent),
    rows: [...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | ") + (b.getAttribute("aria-selected") === "true" ? " (picked)" : "")),
    details: document.querySelector(".details")?.innerText.replaceAll("\\n", " / ") ?? null,
    actions: [...document.querySelectorAll(".details .actions button, .details button.small")].map((b) => b.textContent),
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
const sidOf = (who) => manager.js(`[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === ${JSON.stringify(who)})?.getAttribute("fx-value-sid") ?? null`);
const pick = async (who) => {
    await until((s) => s.rows.some((row) => row.startsWith(`${who} |`)));
    await press(`.entries button[fx-value-sid="${await sidOf(who)}"]`);
    await until((s) => (s.details ?? "").includes("SID"));
};
const lpsGroups = () => guest(`lps group list 2>&1`).split("\n").filter((line) => line.startsWith(GROUP)).join(" / ");
const lpsMember = () => guest(`lps show ${MEMBER} 2>&1`).split("\n").filter((line) => /^(primary group|groups|  )/.test(line)).join(" / ").replace(/ +/g, " ");

await until((s) => s.rows.some((row) => row.startsWith("dana")));
await press(`.tab[fx-click="groups"]`);
await until((s) => s.rows.some((row) => row.startsWith("Administrators")));
await pick("Administrators");
out.administrators = (await shows()).details.split(" / ").slice(0, 3).join(" / ");
out.administratorsActions = (await shows()).actions;
await desk.picture(`${name}-administrators.png`);

if (alice) {
    out.bar = (await shows()).bar;
    out.rows = (await shows()).rows;
    await desk.picture(`${name}-groups.png`);
    await desk.finish(out);
}

// A new group, asked for with Ctrl+N in the Groups list.
await press(`.entries button`);
await desk.key("n", { code: "KeyN", vk: 78, modifiers: 2 });
await until((s) => (s.details ?? "").startsWith("New group"));
await fill("name", GROUP);
await fill("description", "Checks the groups");
await desk.picture(`${name}-new.png`);
await press(`.details button[type="submit"]`);
out.made = await said("is made");
out.madeShown = (await until((s) => (s.details ?? "").includes("Checks the groups"))).details.split(" / ").slice(0, 2).join(" / ");
out.madeOnGuest = lpsGroups();

// Its description, and its name.
await press(`.details button[fx-click="edit-group"]`);
await until((s) => (s.details ?? "").includes("Description"));
await fill("description", "Checks the group commands");
await press(`.details button[type="submit"]`);
out.described = await said("description is set");
await press(`.details button[fx-click="rename-group"]`);
await until((s) => (s.details ?? "").includes("New name"));
await fill("new-name", RENAMED);
await press(`.details button[type="submit"]`);
out.renamed = await said("is now called");
out.renamedOnGuest = guest(`lps group list 2>&1`).split("\n").filter((line) => line.startsWith(RENAMED)).join(" / ");

// A member, who stops it being deleted, and is taken out again.
await press(`.details button[fx-click="add-member"]`);
await until((s) => (s.details ?? "").includes("Add a member"));
await fill("member", MEMBER);
await press(`.details button[type="submit"]`);
out.added = await said(`${MEMBER} is in`);
out.addedShown = (await until((s) => (s.details ?? "").includes(`Members / ${MEMBER}`))).details.match(/Members \/ [^/]*/)?.[0] ?? null;
out.addedOnGuest = lpsMember();
await press(`.details button[fx-click="delete-group"]`);
out.notDeletable = (await until((s) => (s.details ?? "").includes("before deleting it"))).details.match(/[^/]*before deleting it/)?.[0] ?? null;
out.notDeletableOffers = (await shows()).actions.filter((label) => label === "Delete").length;
await desk.picture(`${name}-not-deletable.png`);
await press(`.details .asking button[fx-click="cancel"]`);
await press(`.details button[fx-click="remove-member"][fx-value-member="${MEMBER}"]`);
out.removed = await said(`${MEMBER} is out of`);
out.removedOnGuest = lpsMember();

// Administrators takes a member, and loses it.
await pick("Administrators");
await press(`.details button[fx-click="add-member"]`);
await until((s) => (s.details ?? "").includes("Add a member"));
await fill("member", MEMBER);
await press(`.details button[type="submit"]`);
out.administratorAdded = await said(`${MEMBER} is in`);
out.administratorOnGuest = guest(`getent group Administrators`).trim();
await press(`.details button[fx-click="remove-member"][fx-value-member="${MEMBER}"]`);
out.administratorRemoved = await said(`${MEMBER} is out of`);

// From the user's side: joined, made primary, and taken out.
await press(`.tab[fx-click="users"]`);
await pick(MEMBER);
await press(`.details button[fx-click="join"]`);
await until((s) => (s.details ?? "").includes("Add them to"));
const renamedSid = await manager.js(`[...document.querySelectorAll("[name=group] option")].find((o) => o.textContent === ${JSON.stringify(RENAMED)})?.value ?? null`);
await fill("group", renamedSid);
await desk.picture(`${name}-join.png`);
await press(`.details button[type="submit"]`);
out.joined = await said("is added");
await press(`.details button[fx-click="edit"]`);
await until((s) => (s.details ?? "").includes("Primary group"));
await fill("primary", renamedSid);
await press(`.details button[type="submit"]`);
out.primary = await said("is changed");
out.primaryOnGuest = lpsMember();
await desk.picture(`${name}-user.png`);
await press(`.details button[fx-click="leave"][fx-value-group="${renamedSid}"]`);
out.left = await said(`is out of ${RENAMED}`);

// Still their primary group, so they are in it though no list says so:
// Remove says why it can't, and the group isn't offered for deleting. Once
// they are gone, it goes.
await press(`.tab[fx-click="groups"]`);
await pick(RENAMED);
out.primaryMember = (await until((s) => (s.details ?? "").includes(`Members / ${MEMBER}`))).details.match(/Members \/ [^/]*/)?.[0] ?? null;
await press(`.details button[fx-click="remove-member"][fx-value-member="${MEMBER}"]`);
out.primaryRefused = (await until((s) => (s.said ?? "").includes("primary group"))).said;
await press(`.details button[fx-click="delete-group"]`);
out.primaryNotDeletable = (await until((s) => (s.details ?? "").includes("before deleting it"))).details.match(/[^/]*before deleting it[^/]*/)?.[0] ?? null;
await press(`.details .asking button[fx-click="cancel"]`);
guest(`lps remove ${MEMBER}`);
await until((s) => (s.details ?? "").includes("Nobody is in it"));
await press(`.details button[fx-click="delete-group"]`);
await until((s) => (s.details ?? "").includes("can't be undone"));
await press(`.details button[fx-click="delete-group-yes"]`);
out.deleted = await said("is deleted");
out.goneOnGuest = guest(`lps group list 2>&1`).split("\n").filter((line) => line.startsWith(RENAMED)).length === 0;
await desk.finish(out);
