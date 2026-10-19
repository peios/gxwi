// Package Manager, in headless Chromium
// (`node package-manager.mjs`, then `node package-manager.mjs alice`).
//
// The VM needs the peios-dev repository from the PEI-1319 notes, beside the
// medium's, whose information is months old.
//
// As dana, an administrator: what's installed, searched, one package opened
// with its files and checked; the update check, refused for the stale
// repository and run anyway; bc installed, after the stale refusal is
// carried on past, and removed again; every update made; the last change
// offered for undo, its downgrade asked about on its own and refused;
// repositories with the add form and a removal asked and cancelled; roles
// and roots. As alice, who isn't an administrator, everything reads,
// nothing can be changed, and each page says why once. At half a screen,
// nothing is wider than its place.
import { guest as asGuest, session, sleep } from "./harness.mjs";

/** A guest command's output, without the exit status the channel adds. */
const guest = (command) =>
    asGuest(command)
        .replace(/\n?rc=\d+\s*$/, "")
        .trim();

const alice = process.argv[2] === "alice";
const light = process.argv[2] === "light";
const desk = await session(
    alice ? 9367 : 9366,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "package-manager-alice" : light ? "package-manager-light" : "package-manager";

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
await desk.launch("package");
await gone(["Get started"]);
const w = await window("Package Manager", ".st-nav");
if (!w) {
    out.stopped = "no Package Manager window to attach to";
    await desk.finish(out, 1);
}
const press = (selector) =>
    w
        .js(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(w, selector));
const button = async (text) => {
    const found = await w.js(
        `(() => { const b = [...document.querySelectorAll(".st-page button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (!b) return false; b.setAttribute("data-test", "this"); return true; })()`,
    );
    if (!found) return false;
    await press('[data-test="this"]');
    await w.js(`document.querySelector('[data-test="this"]')?.removeAttribute("data-test")`);
    return true;
};
const put = (field, value) =>
    w.js(`(() => {
    const f = document.querySelector("[name='${field}']");
    f.value = ${JSON.stringify(value)};
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
const shows = () =>
    w.js(`({
    section: document.querySelector('.st-nav [aria-current="page"] b')?.textContent ?? null,
    nav: [...document.querySelectorAll(".st-nav button")].map((b) => b.innerText.replaceAll("\\n", " — ")),
    head: document.querySelector(".st-head h1")?.textContent ?? null,
    said: document.querySelector(".st-status .said")?.textContent ?? null,
    hero: document.querySelector(".st-hero")?.innerText.replaceAll("\\n", " | ") ?? null,
    banner: [...document.querySelectorAll(".st-banner")].map((b) => b.textContent),
    rows: document.querySelectorAll(".st-row.link").length,
    groups: [...document.querySelectorAll(".st-group")].map((g) => g.innerText.replaceAll("\\n", " | ").slice(0, 300)),
    asking: document.querySelector(".st-more.asking")?.innerText.replaceAll("\\n", " | ") ?? null,
    progress: document.querySelector(".st-progress")?.innerText ?? null,
    buttons: [...document.querySelectorAll(".st-page button")].filter((b) => !b.disabled).map((b) => b.textContent.trim()).filter((t) => t && !t.includes("\\n")).slice(0, 14),
    focused: document.activeElement?.textContent?.trim() ?? null,
})`);
const section = async (id) => {
    await press(`#st-nav-${id}`);
    await sleep(900);
};
/** Waits until what is shown passes `ok`, and gives it. */
async function until(ok, seconds = 30) {
    let now;
    for (let i = 0; i < seconds * 2; i++) {
        now = await shows();
        if (ok(now)) return now;
        await sleep(500);
    }
    now.timedOut = true;
    return now;
}
/** Waits for a change to stop at a question or an end. */
const settled = () =>
    until(
        (s) => !s.progress || s.buttons.some((b) => ["Close", "Allow This", "Cancel"].includes(b)),
        90,
    );

out.installed = await until((s) => s.rows > 0 || s.groups.some((g) => g.includes("couldn't")));
await desk.picture(`${name}.png`);

if (light) {
    const scheme = { features: [{ name: "prefers-color-scheme", value: "light" }] };
    await desk.a.send("Emulation.setEmulatedMedia", scheme);
    await w.send("Emulation.setEmulatedMedia", scheme);
    await sleep(800);
    await desk.picture(`${name}.png`);
    await section("updates");
    await until((s) => !(s.hero ?? "").startsWith("Checking"), 60);
    await desk.picture(`${name}-updates.png`);
    await desk.finish(out);
}

// A freshly booted image's medium repository is set up but not yet
// trusted: nothing can be checked or installed until it is, which the
// Updates page says, and Repositories offers.
await section("updates");
out.updatesFirst = await until((s) => !(s.hero ?? "").startsWith("Checking"), 60);
await desk.picture(`${name}-updates-first.png`);
if (!alice) {
    // A second name for the development repository, set up as an image
    // sets one up: its .repo file with its key, and no trust ceremony.
    const { readFileSync } = await import("node:fs");
    const anchor = JSON.parse(
        readFileSync(new URL("../../target/vmshare/devrepo/repo.json", import.meta.url)),
    ).repo.signing.keys[0].fingerprint;
    guest(
        `printf 'base_url = "file:///share/devrepo"\\npriority = 60\\nsignature_policy = "required"\\ntrust_anchors = ["${anchor}"]\\n' > /lcl/conf/peipkg/mirror.repo`,
    );
    await section("history");
    await section("repositories");
    out.untrusted = await shows();
    await desk.picture(`${name}-untrusted.png`);
    if (await button("Trust…")) {
        await sleep(800);
        out.trustAsked = await shows();
        await desk.picture(`${name}-trust-asking.png`);
        await button("Trust");
        out.trusted = await until((s) => s.buttons.includes("Close"), 90);
        await desk.picture(`${name}-trusted.png`);
        await button("Close");
        await sleep(2500);
    }
}
await section("installed");
await until((s) => s.rows > 0);

await put("search-installed", "zstd");
await sleep(900);
out.searched = (await shows()).rows;
await desk.picture(`${name}-search.png`);
await put("search-installed", "");
await sleep(900);

// One package: its details, its files, and a check of them. which, if
// dev/repo.sh installed it from the development repository.
const one = (await w.js(`!!document.querySelector('.st-row.link[fx-value-name="org.gnu.which"]')`))
    ? "org.gnu.which"
    : "org.gnu.sed";
await press(`.st-row.link[fx-value-name="${one}"]`);
await sleep(1200);
out.opened = await shows();
await desk.picture(`${name}-package.png`);
await button("Show Files");
await sleep(1200);
await button("Check Files");
await sleep(1500);
out.checked = await shows();
await desk.picture(`${name}-files.png`);
await press('button[fx-click="back"]');
await sleep(900);

// Updates: the medium's months-old information stops the check; checking
// anyway is the person's say-so.
await section("updates");
out.updates = await until((s) => !(s.hero ?? "").startsWith("Checking"), 60);
await desk.picture(`${name}-updates.png`);
if (await button("Check Anyway")) {
    out.updatesAnyway = await until((s) => !(s.hero ?? "").startsWith("Checking"), 60);
    await desk.picture(`${name}-updates-found.png`);
}

if (!alice) {
    // Install: stopped for the stale repository, carried on past, then the
    // plan, approved.
    await section("available");
    out.available = await shows();
    await desk.picture(`${name}-available.png`);
    await press('.st-row.link[fx-value-name="org.gnu.bc"]');
    await sleep(1000);
    await desk.picture(`${name}-offer.png`);
    await button("Install");
    out.installStale = await settled();
    await desk.picture(`${name}-install-stale.png`);
    if (await button("Continue Anyway")) out.installPlan = await settled();
    await desk.picture(`${name}-install-plan.png`);
    await button("Install");
    // Caught on the way, if it is slow enough to catch.
    for (let i = 0; i < 40; i++) {
        const s = await shows();
        if (s.progress && !s.progress.startsWith("Working")) {
            out.installProgress = s.progress;
            await desk.picture(`${name}-install-progress.png`);
            break;
        }
        if (s.buttons.includes("Close")) break;
        await sleep(50);
    }
    out.installDone = await until((s) => s.buttons.includes("Close"), 120);
    await desk.picture(`${name}-install-done.png`);
    await button("Close");
    await sleep(2500);

    // Remove it again: the plan, with Cancel the keyboard's.
    await section("installed");
    await until((s) => s.rows > 0);
    await press('.st-row.link[fx-value-name="org.gnu.bc"]');
    await sleep(1000);
    await button("Remove…");
    out.removePlan = await settled();
    await desk.picture(`${name}-remove-plan.png`);
    await button("Remove");
    out.removeDone = await until((s) => s.buttons.includes("Close"), 120);
    await desk.picture(`${name}-remove-done.png`);
    await button("Close");
    await sleep(2500);

    // Every update.
    await section("updates");
    await until((s) => !(s.hero ?? "").startsWith("Checking"), 60);
    if (await button("Update All")) {
        let now = await settled();
        if (now.buttons.includes("Continue Anyway")) {
            await button("Continue Anyway");
            now = await settled();
        }
        out.updatePlan = now;
        await desk.picture(`${name}-update-plan.png`);
        await button("Update");
        out.updateDone = await until((s) => s.buttons.includes("Close"), 120);
        await desk.picture(`${name}-update-done.png`);
        await button("Close");
        await sleep(2500);
    }

    // History, and undo of the last change: moving back is asked about on
    // its own, before the plan's own question.
    await section("history");
    out.history = await shows();
    await desk.picture(`${name}-history.png`);
    if (await button("Undo…")) {
        let now = await settled();
        if (now.buttons.includes("Continue Anyway")) {
            await button("Continue Anyway");
            now = await settled();
        }
        out.undoAsked = now;
        await desk.picture(`${name}-undo-authorise.png`);
        await button("Cancel");
        out.undoRefused = await until((s) => s.buttons.includes("Close"), 30);
        await desk.picture(`${name}-undo-refused.png`);
        await button("Close");
        await sleep(1500);
    }
}

await section("history");
if (alice) {
    out.history = await shows();
    await desk.picture(`${name}-history.png`);
}

await section("repositories");
out.repositories = await shows();
await desk.picture(`${name}-repositories.png`);
if (!alice) {
    await button("Add Repository…");
    await sleep(900);
    await put("repo-name", "example");
    await put("repo-url", "ftp://nope");
    await press('form[fx-submit="add-repo"] button.primary');
    await sleep(900);
    out.addRefused = await shows();
    await desk.picture(`${name}-repository-add.png`);
    await button("Cancel");
    await sleep(600);
    await press('button[fx-click="ask-remove-repo"][fx-value-repo="mirror"]');
    await sleep(900);
    out.removeAsked = await shows();
    await desk.picture(`${name}-repository-remove.png`);
    await press('button[fx-click="remove-repo"][fx-value-repo="mirror"]');
    out.repositoryRemoved = await until((s) => s.buttons.includes("Close"), 60);
    await button("Close");
    await sleep(2000);
    out.repositoriesEnd = await shows();
}

await section("roles");
out.roles = await shows();
await desk.picture(`${name}-roles.png`);
await section("roots");
out.roots = await shows();
await desk.picture(`${name}-roots.png`);

// Half a screen: a second window tiles this one to half.
const wide = () =>
    w.js(`(() => {
    const page = document.documentElement;
    const over = [...document.querySelectorAll(".st-page *")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0)
        .map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
    return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, over: [...new Set(over)].slice(0, 6), side: document.querySelector(".st-nav").clientWidth };
})()`);
await section("installed");
await press(`.st-row.link[fx-value-name="${one}"]`);
await sleep(900);
await desk.launch("event");
await sleep(3000);
out.half = await wide();
await desk.picture(`${name}-half.png`);
await press('button[fx-click="back"]');
await sleep(900);
await desk.picture(`${name}-half-list.png`);

// A change at half a screen: patch installed, or removed if it is, and the
// window closed as soon as the plan is approved. It stays, saying it will
// go when the change is made, and then goes.
if (!alice) {
    const had = guest("peipkg info org.gnu.patch > /dev/null 2>&1 && echo had") === "had";
    await section(had ? "installed" : "available");
    await until((s) => s.rows > 0);
    await press('.st-row.link[fx-value-name="org.gnu.patch"]');
    await sleep(900);
    await button(had ? "Remove…" : "Install");
    let now = await settled();
    if (now.buttons.includes("Continue Anyway")) {
        await button("Continue Anyway");
        now = await settled();
    }
    out.halfPlan = await wide();
    await desk.picture(`${name}-half-plan.png`);
    await button(had ? "Remove" : "Install");
    const close = await desk.a.js(
        `(() => { const r = document.querySelector('${w.surface} [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
    );
    await desk.pressAt(close);
    out.closing = await shows().catch(() => ({ gone: true }));
    await desk.picture(`${name}-closing.png`);
    let left = false;
    for (let i = 0; i < 60 && !left; i++) {
        await sleep(500);
        left = !(await strips()).some((strip) => strip.title.startsWith("Package Manager"));
    }
    out.closedWhenDone = {
        left,
        patch: guest("peipkg info org.gnu.patch > /dev/null 2>&1 && echo installed || echo absent"),
        last: guest("peipkg history -n 1"),
    };
}
await gone(["Event Viewer"]);

out.store = guest("peipkg list | wc -l; peipkg history | head -3");
out.log = w.log;
await desk.finish(out);
