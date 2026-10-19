// The menu of an entry in File Explorer, in headless Chromium. What matters is that
// the menu offers what opens the entry and nothing else; that renaming puts
// the keyboard where the name was with the name selected, and refuses a
// name something already has; that a path is copied on this device, by the
// desktop's page, since the app's cannot; and that deleting asks first,
// with the keyboard on the way out, and then deletes what was asked about.
//
// It works in a directory of its own in alice's home, made afresh by the
// VM's administrator: what is made there is alice's to change by what it
// inherits from her home.
import { guest, session, sleep } from "./harness.mjs";

const AT = "/home/alice/gexora-check";
const out = {
    made: guest(
        `rm -rf /tmp/gexora-check ${AT}; mkdir -p ${AT}/things && echo notes > ${AT}/notes.txt && echo other > ${AT}/other.txt && echo inner > ${AT}/things/inner.txt; ls -la ${AT}`,
    )
        .trim()
        .split("\n"),
};
const desk = await session(9355);
const { a, whole } = desk;
process.on("uncaughtException", (error) =>
    desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1),
);
process.on("unhandledRejection", (error) =>
    desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1),
);

// Reading back what was copied is this check's doing and needs leave. A
// browser with nobody at it refuses the newer way of copying unless given
// leave for that too, which it is not: what is tried here is the older way
// the desktop's page falls back on. A person's browser allows the newer as
// they press something, which this cannot try.
out.leaveToRead =
    (
        await whole?.send("Browser.grantPermissions", {
            permissions: ["clipboardReadWrite"],
            origin: "https://127.0.0.1:7780",
        })
    )?.error?.message ?? "given";

await desk.launch(`gxwi-file-explorer ${AT}`);
const gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no File Explorer: is it in the catalogue?" }, 1);

const names = () =>
    gexora.js(
        `[...document.querySelectorAll(".entries > li > *")].map((row) => row.getAttribute("fx-value-name"))`,
    );
const says = () =>
    gexora.js(`({
    trouble: document.querySelector(".trouble")?.textContent ?? null,
    asking: document.querySelector(".asking p")?.textContent ?? null,
    keyboardOn: document.activeElement?.matches("input") ? "a field holding " + JSON.stringify(document.activeElement.value) + ", of which is selected " + JSON.stringify(document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)) : document.activeElement?.textContent?.trim().slice(0, 40) ?? null,
    picked: document.querySelector('.entries [aria-selected="true"]')?.getAttribute("fx-value-name") ?? null,
})`);
const row = (name) => `.entries [fx-value-name="${name}"]`;
const onDisk = () =>
    guest(`ls ${AT}`)
        .trim()
        .split("\n")
        .filter((line) => !line.startsWith("rc="));

out.atFirst = {
    path: await gexora.js(`document.querySelector("[name=path]").value`),
    names: await names(),
};

// ---- what the menu offers

await desk.menuOn(gexora, row("notes.txt"));
out.menuOfAFile = await desk.menu();
await desk.picture("files-menu.png");
await desk.key("Escape");
await desk.menuOn(gexora, row("things"));
out.menuOfADirectory = await desk.menu();
const windows = (await desk.desk()).windows.length;
out.choseOpenWithGexora = await desk.choose("Open with Gexora");
await sleep(3500);
out.anotherWindow = (await desk.desk()).windows.length - windows;
// Back to the first window, which the keyboard follows.
await desk.press(gexora, ".status");

// Requires the matching application artifacts staged from GXWI Essentials.
// on the share, and nothing if it has not, which is said.
await desk.menuOn(gexora, row("notes.txt"));
const before = (await desk.desk()).windows.length;
await desk.choose("Open");
await sleep(3000);
out.openingAFile = { ...(await says()), windowsMore: (await desk.desk()).windows.length - before };
await desk.press(gexora, ".status");

// ---- copying a path

await desk.menuOn(gexora, row("notes.txt"));
out.choseCopyPath = await desk.choose("Copy path");
out.asThePersonPressed = await a.js(
    `({ pressing: navigator.userActivation.isActive, keyboardHere: document.hasFocus() })`,
);
out.copied = await a.js(
    `navigator.clipboard.readText().catch((e) => "could not be read back: " + e.message)`,
);
out.afterCopying = await says();

// ---- renaming

await desk.menuOn(gexora, row("notes.txt"));
out.choseRename = await desk.choose("Rename");
out.renaming = await says();
await desk.picture("files-renaming.png");
await desk.type("other.txt");
await desk.key("Enter", {}, "\r");
out.aNameSomethingHas = { ...(await says()), names: await names(), onDisk: onDisk() };

// From the keyboard this time, and out of it again.
await desk.press(gexora, row("notes.txt"));
await desk.key("F2");
out.renamingByF2 = await says();
await desk.key("Escape");
out.afterEscape = { ...(await says()), names: await names() };
await desk.key("F2");
await desk.type("words.txt");
await desk.key("Enter", {}, "\r");
out.renamed = { ...(await says()), names: await names(), onDisk: onDisk() };

// ---- deleting

await desk.menuOn(gexora, row("words.txt"));
out.choseDelete = await desk.choose("Delete");
out.askedFirst = await says();
await desk.picture("files-asking.png");
// Enter is a press on wherever the keyboard is, which is the way out.
await desk.key("Enter", {}, "\r");
out.afterEnter = { ...(await says()), names: await names() };
await desk.menuOn(gexora, row("words.txt"));
await desk.choose("Delete");
out.pressedDelete = await desk.press(gexora, ".asking .danger");
out.deleted = { ...(await says()), names: await names(), onDisk: onDisk() };

await desk.menuOn(gexora, row("things"));
await desk.choose("Delete");
out.askedOfADirectory = (await says()).asking;
await desk.press(gexora, ".asking .danger");
out.deletedWithWhatWasInIt = { names: await names(), onDisk: onDisk() };

out.gexoraLog = gexora.log;
await desk.finish(out);
