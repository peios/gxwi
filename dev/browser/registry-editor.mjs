// Registry Editor, in headless Chromium, as dana, an administrator
// (`node registry-editor.mjs`).
//
// It opens on Machine. A key typed into the path box is shown, with the tree
// open down to it, and its values: text, numbers, a list, bytes. A value
// picked is shown in full. A value set from a terminal appears without
// Refresh. A path with no key at it says so.
//
// As alice (`node registry-editor.mjs alice`), after dana's run: she may not
// list Closed, but the key under it that she may read is reached by its path,
// and shown under Closed in the tree, which says why Closed can't be listed.
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const KEY = "Machine\\Software\\RegEditCheck";
const r = (path) => path.replaceAll("\\", "\\\\");
if (!alice) {
    const said = guest([
        `reg del -y -r '${KEY}' >/dev/null 2>&1`,
        `reg new -p '${KEY}\\Closed\\Open'`,
        `reg set '${KEY}' Text sz:hello`,
        `reg set '${KEY}' Count dword:4096`,
        `reg set '${KEY}' Big qword:9000000000`,
        `reg set '${KEY}' List multi:alpha,beta`,
        `reg set '${KEY}' Blob hex:000102030405060708090a0b0c0d0e0f1011`,
        `reg sd '${KEY}\\Closed' --set 'O:BAG:BAD:P(A;;GA;;;BA)(A;;GA;;;SY)'`,
        `reg sd '${KEY}\\Closed\\Open' --set 'O:BAG:BAD:P(A;;GR;;;WD)(A;;GA;;;BA)(A;;GA;;;SY)'`,
        `reg set '${KEY}\\Closed\\Open' Visible sz:yes`,
        "echo ready",
    ].join(" && "));
    if (!said.includes("ready")) throw new Error(`could not make ${KEY}: ${said}`);
}
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "registry-editor-alice" : "registry-editor";

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
await gone(["Get started", "Registry Editor"]);
await desk.launch("registry");
await gone(["Get started"]);
const editor = await window("Registry Editor", "nav.tree");
if (!editor) {
    out.stopped = "no Registry Editor window to attach to";
    await desk.finish(out, 1);
}

/** What the window shows. */
const shows = () => editor.js(`({
    path: document.querySelector("input[name=path]")?.value ?? null,
    tree: [...document.querySelectorAll(".tree li")].map((li) => {
        const depth = (() => { let d = 0, at = li.parentElement; while (at && !at.matches("nav")) { if (at.tagName === "UL") d++; at = at.parentElement; } return d - 1; })();
        const row = li.querySelector(":scope > .row .name");
        const text = row ? row.textContent + (row.getAttribute("aria-selected") === "true" ? " (shown)" : "") + (row.classList.contains("reached") ? " (reached by path)" : "") : "why: " + li.textContent;
        return "  ".repeat(depth) + text;
    }).filter((line) => !/^ {6,}/.test(line)),
    values: [...document.querySelectorAll(".entries button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | ") + (b.getAttribute("aria-selected") === "true" ? " (picked)" : "")),
    listing: document.querySelector(".values .trouble, .values .more")?.textContent ?? null,
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
/** Types `path` into the path box and goes there. */
async function go(path) {
    await desk.press(editor, "input[name=path]");
    await editor.js(`document.querySelector("input[name=path]").select()`);
    await desk.type(path);
    await desk.key("Enter", { vk: 13 }, "\r");
    await sleep(800);
}

if (alice) {
    // Closed may not be listed; the key under it is reached by its path.
    await go(`${KEY}\\Closed\\Open`);
    out.reached = await until((s) => s.values.length > 0);
    await desk.picture(`${name}-reached.png`);
    await go(`${KEY}\\Closed`);
    out.closed = await shows();
    await desk.picture(`${name}-closed.png`);
    await desk.finish(out);
}

// It opens on Machine, with Machine open.
out.opened = await until((s) => s.tree.length > 3);
await desk.picture(`${name}-opened.png`);

// A key typed, with the tree open down to it, and its values. Names are
// compared without regard to case, and shown as the registry spells them.
await go(KEY.toLowerCase());
out.typed = await until((s) => s.values.length >= 5);
out.spelt = out.typed.path === KEY;
await desk.picture(`${name}-typed.png`);

// Values picked, shown in full.
for (const value of ["Blob", "List", "Count"]) {
    await desk.press(editor, `.entries button[fx-value-name="${value}"]`);
    await sleep(500);
    out[`picked${value}`] = (await shows()).details;
}
await desk.press(editor, `.entries button[fx-value-name="Blob"]`);
await sleep(500);
await desk.picture(`${name}-blob.png`);

// Set from a terminal, it appears without Refresh.
guest(`reg set '${KEY}' Added sz:live`);
out.live = await until((s) => s.values.some((v) => v.startsWith("Added")), 8000);
await desk.picture(`${name}-live.png`);

// The window's strip names the key shown.
out.strip = (await strips()).map((strip) => strip.title).filter((title) => title.startsWith("Registry Editor"));

// Keys opened in the tree, by their arrows.
await desk.press(editor, `.tree .twist[fx-value-path="${r(KEY)}"]`);
await sleep(600);
await desk.press(editor, `.tree .twist[fx-value-path="${r(KEY)}\\\\Closed"]`);
await sleep(600);
out.twisted = await editor.js(`[...document.querySelectorAll(".tree .name")].map((b) => b.getAttribute("fx-value-path")).filter((path) => path.includes("RegEditCheck"))`);

// The keys under Users are each someone's, and say whose.
await desk.press(editor, `.tree .twist[fx-value-path="Users"]`);
await sleep(800);
out.users = await editor.js(`[...document.querySelectorAll(".tree .name")].filter((b) => (b.getAttribute("fx-value-path") ?? "").startsWith("Users\\\\")).map((b) => b.textContent)`);
await desk.picture(`${name}-users.png`);

// A path with no key at it.
await go("Machine\\NoSuchKey");
out.missing = (await shows()).said;
await desk.picture(`${name}-missing.png`);
await desk.finish(out);
