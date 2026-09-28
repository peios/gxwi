// Making, cutting, copying and pasting in Gexora, in headless Chromium. What
// matters is that the menu of the listing, wherever no entry is, is the
// directory's; that a folder and a file are made by the name typed where
// they will be listed; that a copy pasted where its name is taken says it is
// a copy; that what is cut in one window is pasted in another and is gone
// from where it was; that Ctrl+V in the address bar pastes into the address
// bar; and that the directory is opened with the terminal, which is then
// there.
//
// It needs ../../../gexora/dev/push.sh and ../../../peiterm/dev/push.sh to
// have put both on the share. It works in a directory of its own in
// alice's home, made afresh by the VM's administrator.
import { guest, session, sleep } from "./harness.mjs";

const AT = "/home/alice/gexora-ops";
const out = {
    made: guest(`rm -rf ${AT}; mkdir -p ${AT}/Sub/Deeper && echo notes > ${AT}/notes.txt && echo inner > ${AT}/Sub/Deeper/inner.txt; ls -la ${AT}`).trim().split("\n"),
};
const desk = await session(9358);
const { a, whole } = desk;
process.on("uncaughtException", (error) => desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1));
process.on("unhandledRejection", (error) => desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1));
out.leaveToRead = (await whole?.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: "http://127.0.0.1:7780" }))?.error?.message ?? "given";

// A check that was stopped part way leaves its windows behind.
await a.js(`document.querySelectorAll('.fx-surface[data-role="window"] .fx-button[data-part="close"]').forEach((button) => button.click())`);
await sleep(1500);

const windows = () => a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: Number(s.dataset.id), called: s.querySelector(".fx-title")?.textContent ?? null }))`);
/** The frames with a listing in them, each knowing where it is looking.
    Which window one is in is not known: nothing here presses in them by
    where they are. */
async function explorers() {
    const found = [];
    for (const frame of await desk.frames(".listing")) {
        const path = await frame.js(`document.querySelector("[name=path]").value`);
        found.push(Object.assign(frame, { path }));
    }
    return found;
}
const names = (gexora) => gexora.js(`[...document.querySelectorAll(".entries > li > *")].map((row) => row.getAttribute("fx-value-name") ?? (row.matches("form") ? "(being named)" : null))`);
const says = (gexora) => gexora.js(`({
    trouble: document.querySelector(".trouble")?.textContent ?? null,
    status: document.querySelector(".status span")?.textContent ?? null,
    cut: [...document.querySelectorAll(".entries .cut")].map((row) => row.getAttribute("fx-value-name")),
    keyboardOn: document.activeElement?.matches("input") ? "a field holding " + JSON.stringify(document.activeElement.value) + ", of which is selected " + JSON.stringify(document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)) : document.activeElement?.textContent?.trim().slice(0, 40) ?? null,
})`);
const row = (name) => `.entries [fx-value-name="${name}"]`;
const onDisk = (where = "") => guest(`cd ${AT}/${where} && find . | sort`).split("\nrc=")[0].trim().split("\n");
const control = (letter) => desk.key(letter, { code: `Key${letter.toUpperCase()}`, vk: letter.toUpperCase().charCodeAt(0), modifiers: 2 });

await desk.launch(`gexora ${AT}`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora: is it in the catalogue?" }, 1);
out.atFirst = await names(gexora);

// ---- the directory's menu

out.askedForIt = await desk.menuOn(gexora, ".entries");
out.menuOfTheDirectory = await desk.menu();
await desk.picture("fileops-menu.png");

// ---- a folder and a file made

out.choseNewFolder = await desk.choose("New folder");
out.naming = { ...(await says(gexora)), names: await names(gexora) };
await desk.picture("fileops-naming.png");
await desk.type("Made here");
await desk.key("Enter", {}, "\r");
out.madeAFolder = { ...(await says(gexora)), names: await names(gexora) };
await desk.menuOn(gexora, ".entries");
await desk.choose("New file");
await desk.type("notes.txt");
await desk.key("Enter", {}, "\r");
out.aNameSomethingHas = { ...(await says(gexora)), names: await names(gexora) };
await desk.menuOn(gexora, ".entries");
await desk.choose("New file");
await desk.key("Escape");
out.afterEscape = await names(gexora);
await desk.menuOn(gexora, ".entries");
await desk.choose("New file");
await desk.type("list.txt");
await desk.key("Enter", {}, "\r");
out.madeAFile = { ...(await says(gexora)), names: await names(gexora), onDisk: onDisk() };

// ---- copied, and pasted where it came from

await desk.menuOn(gexora, row("notes.txt"));
out.choseCopy = await desk.choose("Copy");
await desk.menuOn(gexora, ".entries");
out.chosePaste = await desk.choose("Paste");
await sleep(800);
out.aCopyBesideIt = { ...(await says(gexora)), names: await names(gexora) };
// By the keyboard, a directory with everything in it.
await desk.press(gexora, row("Sub"));
await control("c");
await control("v");
await sleep(1200);
out.aDirectoryCopied = { ...(await says(gexora)), names: await names(gexora), onDisk: onDisk("'Sub (copy)'") };

// ---- Ctrl+V in the address bar is the address bar's

await a.js(`navigator.clipboard.writeText("/home/alice").catch((e) => e.message)`);
await desk.press(gexora, "[name=path]");
await control("a");
await a.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2, commands: ["paste"] });
await a.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 });
await sleep(500);
out.pastedInTheAddressBar = { holds: await gexora.js(`document.querySelector("[name=path]").value`), names: await names(gexora), onDisk: onDisk().length };
await control("a");
await desk.type(AT);
await desk.key("Enter", {}, "\r");

// ---- cut in one window, pasted in another

await desk.menuOn(gexora, row("Sub"));
out.choseOpenWithGexora = await desk.choose("Open with Gexora");
await sleep(3500);
const both = await explorers();
const other = both.find((frame) => frame.path === `${AT}/Sub`);
out.twoWindows = both.map((frame) => frame.path);
if (other) {
    await desk.menuOn(gexora, row("list.txt"));
    out.choseCut = await desk.choose("Cut");
    out.shownAsCut = (await says(gexora)).cut;
    await desk.menuOn(other, ".entries");
    out.pastedInTheOther = await desk.choose("Paste");
    await sleep(1000);
    out.inTheOther = { ...(await says(other)), names: await names(other) };
    await desk.press(gexora, ".status");
    await desk.key("F5", { vk: 116 });
    out.goneFromTheFirst = { ...(await says(gexora)), names: await names(gexora) };
    await desk.menuOn(other, ".entries");
    await desk.choose("Paste");
    out.pastedOnce = (await says(other)).trouble;
    // Into itself, a directory does not go.
    await desk.menuOn(gexora, row("Sub"));
    await desk.choose("Copy");
    await desk.menuOn(other, ".entries");
    await desk.choose("Paste");
    out.intoItself = (await says(other)).trouble;
    // The newer of the two windows is the other.
    const newer = Math.max(...(await windows()).filter((window) => window.called === "Gexora").map((window) => window.id));
    await a.js(`document.querySelector('.fx-surface[data-id="${newer}"] .fx-button[data-part="close"]').click()`);
    await sleep(800);
} else out.stoppedShort = "the second window was not found";

// ---- the directory opened with the terminal

await desk.menuOn(gexora, ".entries");
out.choseOpenWithTerminal = await desk.choose("Open with Terminal");
await sleep(3500);
out.windows = (await windows()).map((window) => window.called);
const terminal = await desk.frame(".xterm", '.fx-surface[data-role="window"]:has(iframe[src*="/term/"])');
if (terminal) {
    await desk.press(terminal, ".xterm");
    for (const letter of "pwd") {
        await a.send("Input.dispatchKeyEvent", { type: "keyDown", key: letter, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), text: letter });
        await a.send("Input.dispatchKeyEvent", { type: "keyUp", key: letter, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0) });
    }
    await desk.key("Enter", {}, "\r");
    await sleep(800);
    out.theTerminalIsThere = await terminal.js(`[...document.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent.trimEnd()).filter(Boolean)`);
    await desk.picture("fileops-terminal.png");
} else out.theTerminalIsThere = "no terminal";

out.onDiskAtLast = onDisk();
out.gexoraLog = gexora.log;
await a.js(`document.querySelectorAll('.fx-surface[data-role="window"] .fx-button[data-part="close"]').forEach((button) => button.click())`);
await sleep(1000);
await desk.finish(out);
