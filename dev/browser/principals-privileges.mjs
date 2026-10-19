// Principals Manager's Privileges, in headless Chromium, as dana, an
// administrator (`node principals-privileges.mjs`).
//
// A user is given a record of their own (two privileges, Low integrity),
// checked with reg on the guest and in what the window says they get, where
// their own Low beats Administrators' High and Everyone's privileges join
// theirs. The record is changed from the user's page (an owner and a default
// DACL), refused a DACL that doesn't parse, and deleted. Taking passing
// through folders from Everyone is asked about first, and left alone. A
// record authd would ignore, made with reg on the guest, is shown as ignored.
// Everyone's and Administrators' records are never changed: the other checks
// sign in on them.
//
// As alice (`node principals-privileges.mjs alice`), who may read the policy
// but not change it: the records and what dana gets are shown, and nothing
// offers a change.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const USER = "pmpriv";
const POLICY = "Machine\\Generic\\Authn\\Policy";
let sid = null;
if (!alice) {
    guest(
        `lps remove ${USER} >/dev/null 2>&1; lps add ${USER} --no-password --no-prompt >/dev/null`,
    );
    sid = guest(`lps show ${USER}`).match(/^sid +(\S+)/m)?.[1] ?? null;
}
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "principals-privileges-alice" : "principals-privileges";

const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
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
        const close = await desk.a.js(
            `(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
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
const shows = () =>
    manager.js(`({
    bar: [...document.querySelectorAll(".bar button")].map((b) => b.textContent),
    notes: [...document.querySelectorAll(".list > .said")].map((p) => p.textContent),
    rows: [...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).filter(Boolean).join(" | ")),
    details: document.querySelector(".details")?.innerText.replaceAll("\\n", " / ") ?? null,
    buttons: [...document.querySelectorAll(".details button")].map((b) => b.getAttribute("fx-click")).filter(Boolean),
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
const press = (selector) =>
    manager
        .js(
            `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(manager, selector));
async function fill(field, value) {
    await manager.js(
        `(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    await sleep(150);
}
/** Ticks or clears the box for a privilege, by its name. */
async function tick(privilege, on = true) {
    const field = await manager.js(
        `[...document.querySelectorAll("label.privilege")].find((l) => l.querySelector("code").textContent === ${JSON.stringify(privilege)})?.querySelector("input").name ?? null`,
    );
    const now = await manager.js(`document.querySelector("[name='${field}']").checked`);
    if (now !== on) await press(`.details input[name="${field}"]`);
}
const said = async (what) => (await until((s) => (s.said ?? "").includes(what))).said;
const pickRow = async (label) => {
    await until((s) => s.rows.some((row) => row.startsWith(`${label} |`) || row === label));
    const at = await manager.js(
        `[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === ${JSON.stringify(label)})?.getAttribute("fx-value-record") ?? [...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === ${JSON.stringify(label)})?.getAttribute("fx-value-sid")`,
    );
    const attribute = (await manager.js(
        `!!document.querySelector('.entries button[fx-value-record]')`,
    ))
        ? "fx-value-record"
        : "fx-value-sid";
    await press(`.entries button[${attribute}="${at}"]`);
    await sleep(400);
};
/** A part of the details, from a heading to the next. */
const part = (details, heading) =>
    details.match(
        new RegExp(
            `${heading} / (.*?)(?: / (?:Claims|Groups|May sign in|Members|Signs in with|SSH keys)(?: / |$)|$)`,
        ),
    )?.[1] ?? null;
const regGet = (path) =>
    guest(`reg get '${path}' 2>&1`)
        .trim()
        .split("\n")
        .filter((line) => !line.startsWith("rc="))
        .join(" / ");

await until((s) => s.rows.some((row) => row.startsWith("dana")));
await press(`.tab[fx-click="privileges"]`);
await until((s) => s.rows.some((row) => row.startsWith("Administrators")));
out.bar = (await shows()).bar;
out.rows = (await shows()).rows;
await pickRow("Administrators");
const administrators = await until((s) => (s.details ?? "").includes("SeBackupPrivilege"));
out.administrators = administrators.details.slice(0, 220);
out.administratorsChanges = administrators.buttons.filter((event) =>
    ["edit-record", "delete-record"].includes(event),
);
await desk.picture(`${name}-administrators.png`);

if (alice) {
    out.notes = (await shows()).notes;
    await press(`.tab[fx-click="users"]`);
    await until((s) => s.rows.some((row) => row.startsWith("dana")));
    await pickRow("dana");
    const dana = await until((s) => (s.details ?? "").includes("Signed in"));
    await manager.js(
        `[...document.querySelectorAll(".details h3")].find((h) => h.textContent === "Privileges")?.scrollIntoView({ block: "start" })`,
    );
    await sleep(500);
    out.danaGets = part(dana.details, "Privileges")?.slice(0, 260) ?? null;
    out.danaChanges = dana.buttons.filter((event) => event === "own-record");
    await desk.picture(`${name}-dana.png`);
    await desk.finish(out);
}

// A record for the user, made in Privileges.
await press(`.bar button[fx-click="new-record"]`);
await until((s) => (s.details ?? "").startsWith("New record"));
await fill("principal", USER);
await tick("SeBackupPrivilege");
await tick("SeShutdownPrivilege");
await fill("integrity", "Low");
await desk.picture(`${name}-new.png`);
await press(`.details button[type="submit"]`);
out.made = await said("is saved");
out.madeOnGuest = regGet(`${POLICY}\\${sid}`);

// What they get: their own Low beats nothing else here, Everyone's join theirs.
await press(`.tab[fx-click="users"]`);
await pickRow(USER);
const theirs = await until((s) => (s.details ?? "").includes("Signed in"));
out.gets = part(theirs.details, "Privileges")?.slice(0, 400) ?? null;
await manager.js(
    `[...document.querySelectorAll(".details h3")].find((h) => h.textContent === "Privileges")?.scrollIntoView({ block: "start" })`,
);
await sleep(500);
await desk.picture(`${name}-user.png`);
await fill("as", "network");
out.integrityOverNetwork =
    (await manager.js(`document.querySelector("[name=as]").value`)) === "network"
        ? ((await shows()).details.match(/Integrity \/ ([^/]+)/)?.[1]?.trim() ?? null)
        : "not chosen";

// Changed from the user's page: an owner and a default DACL; one that
// doesn't parse is refused.
await press(`.details button[fx-click="own-record"]`);
await until((s) => (s.details ?? "").includes("Owner of what they make"));
await fill("owner", "Administrators");
await fill("dacl", "D:(nonsense)");
await press(`.details button[type="submit"]`);
out.badDacl = await said("SDDL");
await fill("dacl", "D:(A;;GA;;;OW)(A;;GA;;;SY)");
await press(`.details button[type="submit"]`);
out.changed = await said("is saved");
out.changedOnGuest = regGet(`${POLICY}\\${sid}`);

// Everyone without passing through folders is asked about, and left.
await pickRow("Everyone");
await until((s) => (s.details ?? "").includes("SeChangeNotifyPrivilege"));
await press(`.details button[fx-click="edit-record"]`);
await until(
    (s) =>
        (s.details ?? "").includes("Change the record") ||
        (s.details ?? "").includes("Record Everyone"),
);
await tick("SeChangeNotifyPrivilege", false);
await press(`.details button[type="submit"]`);
out.asked =
    (await until((s) => (s.details ?? "").includes("Save anyway"))).details.match(
        /Without SeChangeNotifyPrivilege[^/]*/,
    )?.[0] ?? null;
await desk.picture(`${name}-asked.png`);
await press(`.details button[fx-click="unask"]`);
await press(`.details button[fx-click="cancel"]`);
out.everyoneOnGuest = regGet(`${POLICY}\\Everyone`);

// A record authd ignores, made on the guest, is said to be ignored.
guest(`reg new -p '${POLICY}\\developerz' >/dev/null`);
out.ignored =
    (await until((s) => s.notes.some((note) => note.includes("developerz")))).notes.find((note) =>
        note.includes("developerz"),
    ) ?? null;
await desk.picture(`${name}-ignored.png`);
guest(`reg del -r -y '${POLICY}\\developerz' >/dev/null`);

// The record, deleted.
await pickRow(USER);
await until((s) => (s.details ?? "").includes("SeBackupPrivilege"));
await press(`.details button[fx-click="delete-record"]`);
await until((s) => (s.details ?? "").includes("Delete the record for"));
await press(`.details button[fx-click="delete-record-yes"]`);
out.deleted = await said("is deleted");
out.goneOnGuest = regGet(`${POLICY}\\${sid}`);

guest(`lps remove ${USER}`);
await desk.finish(out);
