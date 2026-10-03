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
const GUARD = "0100048014000000240000000000000034000000010200000000000520000000200200000102000000000005200000002002000002003400020000000000140000000010010100000000000512000000000018000000008001020000000000052000000020020000";
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
        // O:BAG:BAD:(A;;GA;;;SY)(A;;GR;;;BA), made with peios' sddl::parse.
        `reg set '${KEY}' Guard hex:${GUARD}`,
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

/** Sets a field of the form in the pane to `value`, as typing or picking does. */
async function fill(field, value) {
    await editor.js(`(() => { const f = document.querySelector("[name=${field}]"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(500);
}
/** The pane's buttons, with whether each may be pressed. */
const buttons = () => editor.js(`[...document.querySelectorAll(".details button")].map((b) => b.textContent + (b.disabled ? " (disabled: " + b.title + ")" : ""))`);
/** The permissions editor's dialog, once it is on the desktop. */
async function dialog() {
    for (let i = 0; i < 30; i++) {
        const found = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
        if (found) return found;
        await sleep(300);
    }
    return null;
}
const closed = async () => {
    for (let i = 0; i < 30; i++) {
        if (await desk.a.js(`!document.querySelector('.fx-surface[data-role="dialog"]')`)) return true;
        await sleep(300);
    }
    return false;
};
/** What the dialog shows. */
const says = (sd) => sd.js(`({
    title: document.querySelector("header")?.innerText,
    fixed: document.querySelector(".fixed")?.textContent ?? null,
    listed: [...document.querySelectorAll(".who")].map((b) => b.querySelector(".name").textContent),
    boxes: [...document.querySelectorAll(".rights tbody tr")].map((tr) => tr.querySelector("th").textContent + ": " + [...tr.querySelectorAll("[role=checkbox]")].map((c) => (c.getAttribute("aria-checked") === "true" ? "✓" : "·") + (c.disabled || c.getAttribute("aria-disabled") ? "(fixed)" : "")).join(" ")),
    footer: [...document.querySelectorAll("footer button")].map((b) => b.textContent + (b.disabled ? " (off)" : "")),
})`);
/** Gives Everyone Read in the open dialog, and presses OK. */
async function everyoneReads(sd) {
    await desk.press(sd, ".under button:first-child");
    await sleep(400);
    await desk.type("Everyone");
    await desk.press(sd, "form.naming button[type=submit]");
    await desk.press(sd, "button[fx-value-right='1'][fx-value-way='allow']");
    const ticked = await says(sd);
    await desk.press(sd, "footer .primary");
    return { ticked, closed: await closed() };
}

if (alice) {
    // Closed may not be listed; the key under it is reached by its path.
    await go(`${KEY}\\Closed\\Open`);
    out.reached = await until((s) => s.values.length > 0);
    await desk.picture(`${name}-reached.png`);
    await go(`${KEY}\\Closed`);
    out.closed = await shows();
    await desk.picture(`${name}-closed.png`);
    // She may read RegEditCheck but not change it: what would change it is
    // there, but may not be pressed, and says why.
    await go(KEY);
    await until((s) => s.values.length > 0);
    out.readOnly = { buttons: await buttons(), details: (await shows()).details };
    await desk.press(editor, `.entries button[fx-value-name="Text"]`);
    await sleep(500);
    out.readOnlyValue = await buttons();
    await desk.picture(`${name}-read-only.png`);
    // Who a value's descriptor lets in, which she may look at but not change.
    await desk.press(editor, `.entries button[fx-value-name="Guard"]`);
    await sleep(500);
    await desk.press(editor, `.details button[fx-click="permissions"]`);
    const sd = await dialog();
    out.guardReadOnly = sd ? await says(sd) : "no dialog";
    await desk.picture(`${name}-guard.png`);
    if (sd) {
        await desk.press(sd, "footer button:last-child");
        await closed();
    }
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

// Editing, on RegEditCheck again.
await go(KEY);
await until((s) => s.values.length >= 5);

// A new value: a number, typed.
await desk.press(editor, `.details button[fx-click="new-value"]`);
await sleep(500);
await fill("value-name", "Fresh");
await fill("value-type", "4");
out.newForm = (await shows()).details;
await fill("value-data", "42");
await desk.picture(`${name}-new-value.png`);
await desk.press(editor, `.details button[type="submit"]`);
out.newValue = await until((s) => s.values.some((v) => v.startsWith("Fresh")));

// A number edited in hexadecimal.
await desk.press(editor, `.entries button[fx-value-name="Count"]`);
await sleep(400);
await desk.press(editor, `.details button[fx-click="edit"]`);
await sleep(500);
await fill("value-base", "hex");
out.inHex = await editor.js(`document.querySelector("[name=value-data]").value`);
await fill("value-data", "0x2000");
await desk.picture(`${name}-edit-hex.png`);
await desk.press(editor, `.details button[type="submit"]`);
out.edited = await until((s) => s.values.some((v) => v.startsWith("Count | Number | 8192")));

// Changed by someone else while it was being edited: the save is refused.
await desk.press(editor, `.entries button[fx-value-name="Text"]`);
await sleep(400);
await desk.press(editor, `.details button[fx-click="edit"]`);
await sleep(500);
guest(`reg set '${KEY}' Text sz:theirs`);
await fill("value-data", "mine");
await desk.press(editor, `.details button[type="submit"]`);
await sleep(800);
out.clash = (await shows()).said;
out.clashKept = (await shows()).values.find((v) => v.startsWith("Text"));
await desk.picture(`${name}-clash.png`);
// Saved again, knowing, it replaces theirs.
await desk.press(editor, `.details button[type="submit"]`);
out.clashSaved = (await until((s) => s.values.some((v) => v.startsWith("Text | Text | mine")))).values.find((v) => v.startsWith("Text"));

// A value's right-click menu, and a value deleted after asking.
await desk.press(editor, `.entries button[fx-value-name="Added"]`);
await sleep(400);
out.valueMenu = (await desk.menuOn(editor, `.entries button[fx-value-name="Added"]`)) && (await desk.menu());
await desk.choose("Delete…");
await sleep(500);
out.askedValue = (await shows()).details;
await desk.press(editor, `.details button[fx-click="delete-value-yes"]`);
out.deletedValue = await until((s) => !s.values.some((v) => v.startsWith("Added")));

// A form left with Esc.
await desk.press(editor, `.details button[fx-click="new-key"]`);
await sleep(500);
await desk.key("Escape", { vk: 27 });
await sleep(500);
out.escaped = !(await shows()).details.startsWith("New key");

// A new key, which is then shown.
await desk.press(editor, `.details button[fx-click="new-key"]`);
await sleep(500);
await fill("key-name", "Made");
await desk.press(editor, `.details button[type="submit"]`);
out.newKey = await until((s) => s.path === `${KEY}\\Made`);

// A key with keys under it, deleted after asking, all at once.
// Keys side by side as well as one under another: loregd stalls an open
// made after a transaction has written (PEI-1241), which this would hit.
guest(`reg new -p '${KEY}\\Tree\\A\\B' && reg new '${KEY}\\Tree\\C' && reg set '${KEY}\\Tree\\A' Here sz:yes`);
await go(`${KEY}\\Tree`);
await until((s) => s.path === `${KEY}\\Tree`);
out.keyMenu = (await desk.menuOn(editor, `.tree .name[aria-selected="true"]`)) && (await desk.menu());
await desk.choose("Delete…");
await sleep(500);
out.askedKey = (await shows()).details;
await desk.picture(`${name}-delete-key.png`);
await desk.press(editor, `.details button[fx-click="delete-key-yes"]`);
out.deletedKey = await until((s) => s.path === KEY);
out.treeGone = guest(`reg ls '${KEY}'`);

// A value holding a descriptor: shown as SDDL, opened in the permissions
// editor, and written back with what was changed.
await go(KEY);
out.guardListed = (await until((s) => s.values.some((v) => v.startsWith("Guard")))).values.find((v) => v.startsWith("Guard"));
await desk.press(editor, `.entries button[fx-value-name="Guard"]`);
await sleep(500);
out.guardDetails = (await shows()).details;
await desk.press(editor, `.details button[fx-click="permissions"]`);
let sd = await dialog();
out.guardDialog = sd ? await says(sd) : "no dialog";
await desk.picture(`${name}-guard.png`);
if (sd) out.guardApplied = await everyoneReads(sd);
out.guardAfter = (await until((s) => s.values.some((v) => v.startsWith("Guard") && v.includes(";;;WD)")))).values.find((v) => v.startsWith("Guard"));

// The key's own permissions, from its menu: Everyone may read Made.
await go(`${KEY}\\Made`);
await until((s) => s.path === `${KEY}\\Made`);
out.keyMenuNow = (await desk.menuOn(editor, `.tree .name[aria-selected="true"]`)) && (await desk.menu());
await desk.choose("Permissions…");
sd = await dialog();
out.keyDialog = sd ? await says(sd) : "no dialog";
await desk.picture(`${name}-key-permissions.png`);
if (sd) out.keyApplied = await everyoneReads(sd);
out.keySd = guest(`reg sd '${KEY}\\Made'`);

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
