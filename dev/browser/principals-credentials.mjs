// Principals Manager's credentials and claims, in headless Chromium, as dana,
// an administrator (`node principals-credentials.mjs`).
//
// A user made with no password is given an SSH key, which isn't used until
// Sign-in allows one; the same key again is refused. Sign-in is changed to a
// password or a key. Claims are added, one refused for a value its type
// can't hold and then corrected, one given a group by name for a SID, one
// changed and one removed; the key is removed. A claim and a key added with
// lps on the guest appear in the window without a refresh. Each change is
// checked on the guest with lps as well as in the window.
//
// As alice (`node principals-credentials.mjs alice`), who isn't an
// administrator: a user's claims are shown, and neither what they sign in
// with, nor their keys, nor any way to change a claim.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const USER = "pmkeys";
// Made for this check with `ssh-keygen -t ed25519 -C pm-laptop`; its
// private half was never kept.
const KEY =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEK7Bpk2tHLFoBxVQIrWCFPsqcTcRFAiPBir7uaFTsCu pm-laptop";
if (alice) {
    guest(`lps claim set dana Department string Security`);
} else {
    guest(`lps remove ${USER} >/dev/null 2>&1; lps add ${USER} --no-password --no-prompt`);
}
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "principals-credentials-alice" : "principals-credentials";

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
    rows: [...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | ")),
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
const said = async (what) => (await until((s) => (s.said ?? "").includes(what))).said;
const sidOf = (who) =>
    manager.js(
        `[...document.querySelectorAll(".entries button")].find((b) => b.querySelector(".name").textContent === ${JSON.stringify(who)})?.getAttribute("fx-value-sid") ?? null`,
    );
const pick = async (who) => {
    await until((s) => s.rows.some((row) => row.startsWith(`${who} |`)));
    await press(`.entries button[fx-value-sid="${await sidOf(who)}"]`);
    await until((s) => (s.details ?? "").includes("SID"));
};
/** A part of the details, from one heading to the next. */
const part = (details, heading) =>
    details.match(
        new RegExp(
            `${heading} / (.*?)(?: / (?:SSH keys|Claims|Groups|May sign in|Signs in with)(?: / |$)|$)`,
        ),
    )?.[1] ?? null;
const lpsShow = (field) =>
    guest(`lps show ${USER} 2>&1`)
        .split("\n")
        .filter((line) => line.startsWith(field) || (field === "claims" && /^ {15}\S/.test(line)))
        .join(" / ")
        .replace(/ +/g, " ");
const lpsKeys = () =>
    guest(`lps key list ${USER} 2>&1`)
        .trim()
        .split("\n")
        .map((line) => line.replace(/^[0-9a-f]{32} +/, "<id> ").replace(/ +/g, " "))
        .join(" / ");

if (alice) {
    await pick("dana");
    const now = await shows();
    out.claims = part(now.details, "Claims");
    out.signsInWith = now.details.includes("Signs in with");
    out.changes = now.buttons.filter((event) => event !== "show");
    await manager.js(
        `[...document.querySelectorAll(".details h3")].find((h) => h.textContent === "Claims")?.scrollIntoView({ block: "start" })`,
    );
    await sleep(500);
    await desk.picture(`${name}.png`);
    guest(`lps claim remove dana Department`);
    await desk.finish(out);
}

await pick(USER);
out.before = part((await shows()).details, "Signs in with");

// A key, not yet allowed, and the same key again.
await press(`.details button[fx-click="add-key"]`);
await until((s) => (s.details ?? "").includes("Public key"));
await fill("key", KEY);
await desk.picture(`${name}-key.png`);
await press(`.details button[type="submit"]`);
out.keyAdded = await said("key is added");
out.keyShown = part(
    (await until((s) => (s.details ?? "").includes("pm-laptop"))).details,
    "SSH keys",
);
out.keyOnGuest = lpsKeys();
await press(`.details button[fx-click="add-key"]`);
await until((s) => (s.details ?? "").includes("Public key"));
await fill("key", KEY);
await fill("key-label", "again");
await press(`.details button[type="submit"]`);
out.keyTwice = await said("already");
await press(`.details button[fx-click="cancel"]`);

// What they sign in with: a password or a key.
await press(`.details button[fx-click="sign-in"]`);
await until((s) => (s.details ?? "").includes("Signs in with"));
await press(`.details input[name="credential"][value="key"]`);
out.keyOnlyNote =
    (
        await until(
            (s) =>
                (s.details ?? "").includes("SSH key yet") ||
                (s.details ?? "").includes("Nothing is accepted"),
            2000,
        )
    ).details.match(/They have no SSH key yet[^/]*/)?.[0] ?? "(no warning: they have a key)";
await press(`.details input[name="credential"][value="either"]`);
await desk.picture(`${name}-sign-in.png`);
await press(`.details button[type="submit"]`);
out.policy = await said("is changed");
out.policyShown = part(
    (await until((s) => (s.details ?? "").includes("A password or an SSH key"))).details,
    "Signs in with",
);
out.policyOnGuest = lpsShow("credential");

// Claims: one added, one refused and corrected, a group by name, one
// changed and one removed.
const addClaim = async (claim, type, values) => {
    await press(`.details button[fx-click="add-claim"]`);
    await until((s) => (s.details ?? "").startsWith("New claim"));
    await fill("claim-name", claim);
    await fill("claim-type", type);
    await fill("claim-values", values);
    await press(`.details button[type="submit"]`);
};
await addClaim("Department", "string", "Engineering\nResearch");
out.claimAdded = await said("is added");
await addClaim("Level", "int64", "high");
out.claimRefused = await said("is not a whole number");
await desk.picture(`${name}-claim-refused.png`);
await fill("claim-values", "3");
await press(`.details button[type="submit"]`);
out.claimCorrected = await said("claim Level is added");
await addClaim("Team", "sid", "Administrators");
out.claimByName = await said("claim Team is added");
await press(`.details button[fx-click="edit-claim"][fx-value-claim="Department"]`);
await until((s) => (s.details ?? "").includes("A claim of"));
out.editFilled = await manager.js(`document.querySelector("[name='claim-values']").value`);
await fill("claim-values", "Engineering");
await press(`.details button[type="submit"]`);
out.claimChanged = await said("is changed");
out.claimsShown = part(
    (await until((s) => (s.details ?? "").includes("S-1-5-32-544"))).details,
    "Claims",
);
out.claimsOnGuest = lpsShow("claims");
// The pane scrolled to what this checks, below the buttons.
await manager.js(
    `[...document.querySelectorAll(".details h3")].find((h) => h.textContent === "Signs in with")?.scrollIntoView({ block: "start" })`,
);
await desk.picture(`${name}-user.png`);
await press(`.details button[fx-click="remove-claim"][fx-value-claim="Level"]`);
out.claimRemoved = await said("is removed");

// The key, removed.
const id = await manager.js(
    `document.querySelector('.details button[fx-click="remove-key"]')?.getAttribute("fx-value-key") ?? null`,
);
await press(`.details button[fx-click="remove-key"][fx-value-key="${id}"]`);
out.keyRemoved = await said("is removed");
out.keyGoneOnGuest = lpsKeys();

// Changed with lps on the guest, and seen without a refresh.
guest(
    `lps claim set ${USER} Shift string night >/dev/null; echo '${KEY}' > /tmp/pm.pub; lps key add ${USER} /tmp/pm.pub terminal >/dev/null`,
);
const heard = await until(
    (s) => (s.details ?? "").includes("night") && (s.details ?? "").includes("terminal"),
);
out.fromTerminalClaims = part(heard.details, "Claims");
out.fromTerminalKeys = part(heard.details, "SSH keys");

guest(`lps remove ${USER}`);
await desk.finish(out);
