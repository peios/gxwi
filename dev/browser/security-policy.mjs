// Security Policy, in headless Chromium
// (`node security-policy.mjs`, then `node security-policy.mjs alice`).
//
// As dana, an administrator: every trusted certificate, searched; one
// opened, distrusted after being asked, which trustd drops at once, and
// trusted again from Distrusted; a certificate the machine doesn't have
// distrusted by fingerprint and taken back; a CA chosen in the file dialog,
// added, opened and removed; a leaf certificate, refused with why; the
// certificate files, whose turning off asks and, cancelled, changes
// nothing. As alice, who isn't an administrator, everything reads, nothing
// can be changed, and each page says why once. At half a screen, nothing is
// wider than its place.
import { guest as asGuest, session, sleep } from "./harness.mjs";

/** A guest command's output, without the exit status the channel adds. */
const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();

const alice = process.argv[2] === "alice";
const who = alice ? "alice" : "dana";
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "security-policy-alice" : "security-policy";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
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
        const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
// Every window closed first: other settings windows have the same parts.
await gone([""]);
await desk.launch("security");
await gone(["Get started"]);
const w = await window("Security Policy", ".st-nav");
if (!w) {
    out.stopped = "no Security Policy window to attach to";
    await desk.finish(out, 1);
}
const press = (selector) => w.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`).then(() => desk.press(w, selector));
const put = (field, value) => w.js(`(() => {
    const f = document.querySelector("[name='${field}']");
    f.value = ${JSON.stringify(value)};
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
const shows = () => w.js(`({
    section: document.querySelector('.st-nav [aria-current="page"] b')?.textContent ?? null,
    nav: [...document.querySelectorAll(".st-nav button")].map((b) => b.innerText.replaceAll("\\n", " — ")),
    said: document.querySelector(".st-status .said")?.textContent ?? null,
    hero: document.querySelector(".st-hero")?.innerText.replaceAll("\\n", " | ") ?? null,
    banner: document.querySelector(".st-banner")?.textContent ?? null,
    rows: document.querySelectorAll(".st-row.link").length,
    groups: [...document.querySelectorAll(".st-group")].map((g) => g.innerText.replaceAll("\\n", " | ").slice(0, 300)),
    asking: document.querySelector(".st-more.asking")?.innerText.replaceAll("\\n", " | ") ?? null,
    buttons: [...document.querySelectorAll(".st-page button")].filter((b) => !b.disabled).map((b) => b.textContent.trim()).filter((t) => t && !t.includes("\\n")).slice(0, 12),
    switches: [...document.querySelectorAll(".st-switch")].map((s) => ({ name: s.name, on: s.checked, enabled: !s.disabled })),
})`);
const section = async (id) => {
    await press(`#st-nav-${id}`);
    await sleep(900);
};
const store = () => guest("trust status | sed -n 3,6p");

out.list = await shows();
await desk.picture(`${name}.png`);

await put("search", "digicert");
await sleep(900);
out.searched = { rows: (await shows()).rows };
await desk.picture(`${name}-search.png`);
await put("search", "");
await sleep(900);

// One certificate, opened.
const fingerprint = guest("trust list | head -1").split(/\s+/)[0];
await press(`.st-row.link[fx-value-cert^="${fingerprint}"]`);
await sleep(1200);
out.opened = await shows();
await desk.picture(`${name}-certificate.png`);

/** Closes every dialog on the desktop. */
async function dialogsGone() {
    const closes = await desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="dialog"] [data-part="close"]')].map((c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
    for (const at of closes) {
        await desk.pressAt(at);
        await sleep(800);
    }
}

if (!alice) {
    // Exported, through the file dialog, with the name it suggests.
    guest(`rm -f /home/${who}/digicert-tls-ecc-p384-root-g5.pem`);
    await press('button[fx-click="export"]');
    await sleep(2500);
    const saving = await desk.frame(".chooser", '.fx-surface[data-role="dialog"]');
    out.exportName = saving ? await saving.js(`document.querySelector("[name='name']")?.value ?? null`) : "no dialog";
    if (saving) {
        await desk.press(saving, "form.choose button.primary");
        await sleep(2500);
    }
    out.exported = { said: (await shows()).said, file: guest(`head -1 /home/${who}/digicert-tls-ecc-p384-root-g5.pem; wc -c < /home/${who}/digicert-tls-ecc-p384-root-g5.pem`) };

    // Distrusted, after being asked.
    await press('button[fx-click="ask-distrust"]');
    await sleep(900);
    out.distrustAsked = (await shows()).asking;
    await desk.picture(`${name}-distrust-asking.png`);
    await put("reason", "a check from the browser");
    await sleep(400);
    await press('.st-more.asking button[fx-click="distrust"]');
    await sleep(2500);
    out.distrusted = { said: (await shows()).said, page: (await shows()).hero, store: store() };

    // Trusted again, from Distrusted.
    await section("distrusted");
    out.distrustedPage = await shows();
    await desk.picture(`${name}-distrusted.png`);
    await press('button[fx-click="ask-restore"]');
    await sleep(900);
    out.restoreAsked = (await shows()).asking;
    await press('.st-more.asking button[fx-click="restore"]');
    await sleep(2500);
    out.restored = { said: (await shows()).said, store: store() };

    // One the machine doesn't have, by fingerprint, and back.
    await press('button[fx-click="ask-by-fingerprint"]');
    await sleep(900);
    await put("by-fp", "AB:".repeat(31) + "AB");
    await put("by-reason", "not here yet");
    await sleep(400);
    await press('form[fx-submit="distrust-by-fingerprint"] button.danger');
    await sleep(2500);
    out.byFingerprint = { said: (await shows()).said, groups: (await shows()).groups, listed: guest("trust list --distrusted") };
    await desk.picture(`${name}-by-fingerprint.png`);
    await press('button[fx-click="ask-restore"]');
    await sleep(900);
    await press('.st-more.asking button[fx-click="restore"]');
    await sleep(2500);
    out.byFingerprintBack = { said: (await shows()).said, listed: guest("trust list --distrusted | tail -1") };

    // A CA of their own, chosen in the file dialog, added and removed.
    guest(`cp /share/corp-root.pem /share/leaf.pem /home/${who}/ && sd allow /home/${who}/corp-root.pem ${who}:r >/dev/null; sd allow /home/${who}/leaf.pem ${who}:r >/dev/null`);
    await section("trusted");
    await press('button[fx-click="choose-file"]');
    await sleep(2500);
    let dialog = await desk.frame(".chooser", '.fx-surface[data-role="dialog"]');
    if (dialog) {
        await dialog.js(`(() => { const e = [...document.querySelectorAll("[fx-value-name]")].find((x) => x.textContent.includes("corp-root.pem")); e?.scrollIntoView({ block: "center" }); })()`);
        await desk.doublePress(dialog, `[fx-value-name="corp-root.pem"]`);
        await sleep(2500);
    }
    out.adding = await shows();
    await desk.picture(`${name}-adding.png`);
    await press('form[fx-submit="add"] button.primary');
    await sleep(2500);
    out.added = { said: (await shows()).said, groups: (await shows()).groups.slice(0, 1), store: store() };
    await desk.picture(`${name}-added.png`);
    // The added group comes first.
    await press(".st-row.link");
    await sleep(1200);
    out.addedOpened = (await shows()).hero;
    await press('button[fx-click="ask-remove"]');
    await sleep(900);
    out.removeAsked = (await shows()).asking;
    await press('.st-more.asking button[fx-click="remove"]');
    await sleep(2500);
    out.removed = { said: (await shows()).said, store: store() };

    // A leaf certificate: shown, and why it can't be added.
    await press('button[fx-click="choose-file"]');
    await sleep(2500);
    dialog = await desk.frame(".chooser", '.fx-surface[data-role="dialog"]');
    if (dialog) {
        await dialog.js(`(() => { const e = [...document.querySelectorAll("[fx-value-name]")].find((x) => x.textContent.includes("leaf.pem")); e?.scrollIntoView({ block: "center" }); })()`);
        await desk.doublePress(dialog, `[fx-value-name="leaf.pem"]`);
        await sleep(2500);
    }
    out.leaf = await shows();
    await desk.picture(`${name}-leaf.png`);
    await press('button[fx-click="cancel-add"]');
    await sleep(900);
}

// Settings: the files, and turning them off asks.
await section("settings");
out.settings = await shows();
await desk.picture(`${name}-settings.png`);
if (!alice) {
    await press('input[name="compat"]');
    await sleep(1200);
    out.compatAsked = { asking: (await shows()).asking, switches: (await shows()).switches };
    await desk.picture(`${name}-compat-asking.png`);
    await press('button[fx-click="cancel"]');
    await sleep(1000);
    out.compatKept = { switches: (await shows()).switches, registry: guest(`reg get 'Machine\\System\\Trust' GenerateLinuxTrustFiles`) };
}
// Who may change trust, and who may control the service, in the editor.
for (const which of ["perm-trust", "perm-service"]) {
    await press(`button[fx-click="${which}"]`);
    let editor = null;
    for (let i = 0; i < 30 && !editor; i++) {
        editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
        if (!editor) await sleep(300);
    }
    out[which] = editor
        ? await editor.js(`({
            title: document.querySelector("header")?.innerText.replaceAll("\\n", " | "),
            listed: [...document.querySelectorAll(".who")].map((b) => b.querySelector(".name")?.textContent),
            rights: [...document.querySelectorAll(".rights tbody tr th")].map((th) => th.textContent),
            locked: document.querySelector(".why, .locked, .cannot")?.textContent ?? null,
        })`)
        : "no dialog";
    await desk.picture(`${name}-${which}.png`);
    await dialogsGone();
}

await section("distrusted");
out.distrustedEnd = await shows();
if (alice) await desk.picture(`${name}-distrusted.png`);

// Half a screen: a second window tiles this one to half.
await section("trusted");
await press(`.st-row.link[fx-value-cert^="${fingerprint}"]`);
await sleep(900);
await desk.launch("event");
await sleep(3000);
out.half = await w.js(`(() => {
    const page = document.documentElement;
    const over = [...document.querySelectorAll(".st-page *")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.clientWidth > 0)
        .map((e) => e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""));
    return { width: innerWidth, sideways: page.scrollWidth > page.clientWidth, over: [...new Set(over)].slice(0, 6), side: document.querySelector(".st-nav").clientWidth };
})()`);
await desk.picture(`${name}-half.png`);
await press('button[fx-click="back"]');
await sleep(900);
await desk.picture(`${name}-half-list.png`);
await gone(["Event Viewer"]);

out.log = w.log;
await desk.finish(out);
