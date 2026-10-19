// Network Manager, in headless Chromium
// (`node network-manager.mjs`, `node network-manager.mjs alice`,
// `node network-manager.mjs light`).
//
// As dana: every section; a network named and given a trust level, which is
// a real registry write, kept from its keep bar; a firewall rule open, an
// exception to it begun, a connection explained, an exposure cell; at half a
// screen, nothing wider than its place. As alice, who may not change the
// network: everything shown, read-only, said once.
import { session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const light = process.argv[2] === "light";
const desk = await session(
    alice ? 9369 : 9368,
    alice ? undefined : { user: "dana", password: "dana-dev-password" },
);
const out = {};
const name = alice ? "network-manager-alice" : light ? "network-manager-light" : "network-manager";

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
await desk.launch("network");
await gone(["Get started"]);
const w = await window("Network Manager", "nav.side");
if (!w) {
    out.stopped = "no Network Manager window to attach to";
    await desk.finish(out, 1);
}

const press = (selector) =>
    w
        .js(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(w, selector));
const button = async (text, within = ".app") => {
    const found = await w.js(
        `(() => { const b = [...document.querySelectorAll(${JSON.stringify(within + " button, " + within + " tr.click")})].find((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!b) return false; b.setAttribute("data-test", "this"); return true; })()`,
    );
    if (!found) return false;
    await press('[data-test="this"]');
    await w.js(`document.querySelector('[data-test="this"]')?.removeAttribute("data-test")`);
    await sleep(900);
    return true;
};
/** A section, chosen from the side, with any drawer closed first. */
const section = async (id) => {
    if (await w.js(`!!document.querySelector(".drawer")`)) {
        await press(".drawer .x");
        await sleep(700);
    }
    await press(`nav.side button[fx-value-section="${id}"]`);
    await sleep(1300);
};
const put = (field, value) =>
    w
        .js(
            `(() => { const f = document.querySelector("[name='${field}']"); if (f.type === "radio") { const r = document.querySelector("[name='${field}'][value='" + ${JSON.stringify(value)} + "']"); r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); return; } f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); })()`,
        )
        .then(() => sleep(700));
const shows = () =>
    w.js(`({
    said: document.querySelector(".status .said")?.textContent ?? null,
    force: document.querySelector(".status .force")?.textContent ?? null,
    head: document.querySelector(".phead")?.innerText.replaceAll("\\n", " | ") ?? null,
    alerts: [...document.querySelectorAll(".page .alert")].map((a) => a.innerText.replaceAll("\\n", " ")),
    drawer: document.querySelector(".drawer")?.innerText.replaceAll("\\n", " | ").slice(0, 900) ?? null,
    modal: document.querySelector(".modal")?.innerText.replaceAll("\\n", " | ") ?? null,
    keep: document.querySelector(".keepbar")?.innerText.replaceAll("\\n", " ") ?? null,
    page: document.querySelector(".page")?.innerText.replaceAll("\\n", " | ").slice(0, 700) ?? null,
})`);
const wide = () =>
    w.js(`(() => {
    const page = document.documentElement;
    const over = [...document.querySelectorAll(".page *")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0 && !e.closest(".scroll, .path"))
        .map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
    return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, over: [...new Set(over)].slice(0, 6) };
})()`);
await sleep(3000);

if (light) {
    const scheme = { features: [{ name: "prefers-color-scheme", value: "light" }] };
    await desk.a.send("Emulation.setEmulatedMedia", scheme);
    await w.send("Emulation.setEmulatedMedia", scheme);
    await sleep(800);
    await desk.picture(`${name}.png`);
    await section("profiles");
    await desk.picture(`${name}-profiles.png`);
    await section("exposure");
    await desk.picture(`${name}-exposure.png`);
    await desk.finish(out);
}

out.overview = await shows();
await desk.picture(`${name}.png`);
// The interface's lease: how much of it has gone, and where it renews.
await w.js(`document.querySelector(".leasebar, .leasesteps")?.scrollIntoView({ block: "center" })`);
await sleep(600);
out.lease = await w.js(
    `document.querySelector(".leasebar")?.parentElement.innerText.replaceAll("\\n", " | ").slice(-200) ?? "no bar"`,
);
await desk.picture(`${name}-lease.png`);
await w.js(`document.querySelector("main.main").scrollTop = 0`);

for (const id of [
    "networks",
    "profiles",
    "assign",
    "dns",
    "exposure",
    "rules",
    "activity",
    "ports",
    "audit",
    "advanced",
]) {
    await section(id);
    out[id] = await shows();
    await desk.picture(`${name}-${id}.png`);
}

// A network, named and trusted: a real write, kept.
await section("networks");
await press("tr.click");
await sleep(900);
out.networkDrawer = await shows();
await desk.picture(`${name}-network.png`);
if (!alice) {
    // Whatever it is called now, it is called something else after.
    const now = await w.js(`document.querySelector("[name='n-name']").value`);
    await put("n-name", now === "QEMU user network" ? "QEMU network" : "QEMU user network");
    await put("n-trust", "private");
    out.networkEdited = await shows();
    await desk.picture(`${name}-network-edited.png`);
    await button("Save", ".drawer");
    await sleep(2500);
    out.networkSaved = await shows();
    await desk.picture(`${name}-network-saved.png`);
    if (out.networkSaved.keep) {
        await button("Keep", ".keepbar");
        await sleep(1000);
        out.kept = await shows();
    }
} else {
    await button("Cancel", ".drawer");
}

// A profile setting changed, applied, and undone from the keep bar.
if (!alice) {
    await section("profiles");
    await press('button[fx-click="pv-set"][fx-value-k="Address.Temporary"][fx-value-v="1"]');
    await sleep(900);
    out.profilePending = await shows();
    await desk.picture(`${name}-profile-pending.png`);
    await button("Apply", ".pending");
    await sleep(2500);
    out.profileApplied = await shows();
    out.profileInRegistry = (await import("./harness.mjs")).guest(
        'reg get "Machine\\System\\Network\\Profiles\\default"',
    );
    await desk.picture(`${name}-profile-applied.png`);
    if (out.profileApplied.keep) {
        await button("Undo", ".keepbar");
        await sleep(2500);
    }
    out.profileAfterUndo = (await import("./harness.mjs")).guest(
        'reg get "Machine\\System\\Network\\Profiles\\default"',
    );
}

// A firewall rule, an exception begun, and a connection explained.
await section("rules");
await button("ssh", ".rtable");
out.rule = await shows();
await desk.picture(`${name}-rule.png`);
if (!alice) {
    await button("Add exception", ".drawer");
    await sleep(600);
    await put("r-name", "lan-only");
    await put("cv0", "10.0.0.0/8");
    out.exception = await shows();
    await desk.picture(`${name}-exception.png`);
    // Saved, it is a real rule; undone from the keep bar, it is gone again.
    await button("Save", ".drawer");
    await sleep(2500);
    out.exceptionSaved = await shows();
    out.exceptionInRegistry = (await import("./harness.mjs")).guest(
        'reg ls "Machine\\System\\Network\\Rules\\Flow\\ssh"',
    );
    await desk.picture(`${name}-exception-saved.png`);
    await button("Undo", ".keepbar");
    await sleep(2500);
    out.exceptionUndone = await shows();
    out.exceptionAfterUndo = (await import("./harness.mjs")).guest(
        'reg ls "Machine\\System\\Network\\Rules\\Flow\\ssh"',
    );
}
(await button("Cancel", ".drawer")) || (await button("×", ".drawer"));
await button("Test a connection");
out.trace = await shows();
await desk.picture(`${name}-trace.png`);
await button("Your session", ".drawer");
out.traceYou = await shows();
await desk.picture(`${name}-trace-you.png`);
await button("Close", ".drawer");

await section("exposure");
await press(".dotbtn.allow");
await sleep(900);
out.cell = await shows();
await desk.picture(`${name}-cell.png`);
await button("Close", ".drawer");

await section("dns");
await put("lk-q", "peios.org");
await press('form[fx-submit="lookup"] button');
await sleep(2500);
out.lookup = await shows();
await desk.picture(`${name}-lookup.png`);

if (!alice) {
    const reg = (await import("./harness.mjs")).guest;
    // A change made elsewhere is seen: the registry watch rereads.
    reg("reg set -p Machine/System/Network/Dns/Hosts nm-watch 10.9.9.9");
    await sleep(3000);
    await section("dns");
    out.watched = await w.js(`document.querySelector(".page").innerText.includes("nm-watch")`);
    await press('button[fx-click="host-del"][fx-value-n="nm-watch"]');
    await sleep(2500);
    out.hostRemoved = reg("reg get Machine/System/Network/Dns/Hosts");

    // The audit level, raised and put back.
    await section("audit");
    await press('button[fx-click="audit-level"][fx-value-n="3"]');
    await sleep(2500);
    out.auditRaised = reg("reg get Machine/System/Network/Rules CurrentReportingLevel");
    await press('button[fx-click="audit-level"][fx-value-n="1"]');
    await sleep(2500);

    // A profile made, a profile rule that ties with the shipped one refused
    // before it can be saved, and the profile deleted.
    await section("profiles");
    await put("np-name", "smoke");
    await button("New profile", ".treeacts");
    await sleep(2500);
    out.profileMade = reg("reg ls Machine/System/Network/Profiles");
    await section("assign");
    await button("New rule");
    await put("r-name", "tie");
    await put("r-prio", "10");
    await put("r-prof", "smoke");
    out.tie = await shows();
    out.tieSaveDisabled = await w.js(
        `document.querySelector('.drawer button[fx-click="rule-save"]').disabled`,
    );
    await desk.picture(`${name}-tie.png`);
    await section("profiles");
    await press('button[fx-click="profile-select"][fx-value-p="smoke"]');
    await sleep(900);
    await button("Delete smoke", ".treeacts");
    await button("Delete", ".modal");
    await sleep(2500);
    out.profileDeleted = reg("reg ls Machine/System/Network/Profiles");

    // A lease renewed.
    await section("overview");
    await button("Renew lease");
    await sleep(5000);
    out.renewed = await shows();

    // A reservation's permissions, in the permissions editor.
    await section("ports");
    await button("Permissions…");
    await sleep(3500);
    out.editor = (await strips()).map((s) => s.title);
    await desk.picture(`${name}-permissions.png`);
    await gone(["Permissions", "Security", "Ports"]);
    await sleep(1000);
}

// Half a screen: a second window tiles this one to half.
await section("overview");
await desk.launch("event");
await sleep(3000);
out.half = await wide();
await desk.picture(`${name}-half.png`);
await gone(["Event Viewer"]);
await sleep(1000);

out.log = w.log;
await desk.finish(out);
