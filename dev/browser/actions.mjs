// What fenesh's dock does besides showing what is pinned and running, in
// headless Chromium. What matters is that an entry's menu says what can be
// done with that entry and no more; that it starts another window of a
// running application and asks for a program's windows to be closed; that a
// pin is dragged to another place among the pins and stays there; that a
// change to what is pinned made by something else is shown as it is made;
// that a press on a program's icon goes through its windows in turn; and
// that a workspace left empty between two in use goes once it has been left.
//
// Only fenesh has a dock, so this needs fenesh to be the shell. It puts
// alice's own list of pins away first, so that the administrator's is in
// force as it starts, and leaves her with none.
import { guest, session, sleep } from "./harness.mjs";

/** Deletes every person's own list of pins. Only alice logs on here. */
const forget = () =>
    guest(
        `reg ls Users | tr -d / | while read sid; do reg del -y "Users/$sid/Software/fenesh" Pinned 2>&1; done; true`,
    );
/** What the registry holds as the pins of whoever has any. */
const kept = () =>
    guest(
        `reg ls Users | tr -d / | while read sid; do reg get "Users/$sid/Software/fenesh" Pinned 2>/dev/null; done; true`,
    )
        .split("\n")
        .filter((line) => /^[a-z0-9.-]+\.[a-z0-9.-]+$/.test(line.trim()));

const out = { forgotten: forget().trim().split("\n").at(-1) };
const desk = await session(9354);
const { a } = desk;
const dock = await desk.frame(".dock", '.fx-surface[data-role="panel"][data-edge="left"]');
if (!dock) await desk.finish({ ...out, stopped: "no dock: is fenesh the shell?" }, 1);

/** The dock's entries in order: which, how many windows, what its icon goes to, and where the page has moved it. */
const entries = () =>
    dock.js(`[...document.querySelectorAll(".dock > ul > li")].map((li) => ({
    id: li.id,
    windows: li.querySelectorAll(".windows i").length,
    goesTo: li.querySelector("button").getAttribute("fx-focus"),
    ...(li.hasAttribute("fx-drag") ? { dragged: true } : {}),
    ...(li.style.transform ? { moved: li.style.transform } : {}),
    ...(li.dataset.fxDragging ? { dragging: li.dataset.fxDragging } : {}),
}))`);
const ids = async () => (await entries()).map((entry) => entry.id);
const css = (id) => "#" + id.replaceAll(".", "\\.");

// Whatever goes wrong, what was seen up to then is said and the session ended.
process.on("uncaughtException", (error) =>
    desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1),
);
process.on("unhandledRejection", (error) =>
    desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1),
);

out.atFirst = await entries();

// ---- the menu of each kind of entry

await desk.menuOn(dock, css("pinned-dev.peios.gxwi-file-explorer"));
out.menuOfAnIdlePin = await desk.menu();
await desk.key("Escape");

await desk.launch("hello");
const hello = (await entries()).find((entry) => entry.id.startsWith("program-"))?.id;
await desk.menuOn(dock, css(hello));
out.menuOfARunningApplication = await desk.menu();
out.pinned = await desk.choose("Pin to the dock");
out.afterPinning = await ids();
out.keptAfterPinning = kept();

// ---- a pin dragged to another place

const [from, to] = [
    await desk.middle(dock, css("pinned-dev.peios.gxwi.hello") + " button"),
    await desk.middle(dock, css("pinned-dev.peios.gxwi-file-explorer") + " button"),
];
const before = await desk.desk();
out.draggedFromTo = [from, to];
const letGo = await desk.drag(from, { x: to.x, y: to.y - 6 });
out.whileDragging = await entries();
await desk.picture("actions-dragging.png");
await letGo();
out.afterDragging = await ids();
out.keptAfterDragging = kept();
// The press that ended the drag was no press on the icon: nothing started.
await sleep(2000);
out.nothingStartedByTheDrag = (await desk.desk()).windows.length === before.windows.length;
// A press that goes nowhere is still a press.
await desk.press(dock, css("pinned-dev.peios.gxwi.hello") + " button");
out.aPressStillFocuses =
    (await desk.desk()).focused ===
    Number((await entries()).find((entry) => entry.id === "pinned-dev.peios.gxwi.hello").goesTo);

// ---- a change made by something else

out.forgottenAgain = forget().trim().split("\n").at(-1);
await sleep(1500);
out.afterItWasChangedFromOutside = await ids();

// ---- another window, and closing

const again = (await ids()).find((id) => id.startsWith("program-"));
await desk.menuOn(dock, css(again));
out.choseNewWindow = await desk.choose("New window");
await sleep(3500);
out.withAnotherWindow = await entries();
await desk.menuOn(dock, css(again));
out.menuBeforeClosing = await desk.menu();
out.choseClose = await desk.choose("Close");
await sleep(1500);
out.afterClosingTheFirst = await entries();
const other = (await ids()).find((id) => id.startsWith("program-"));
await desk.menuOn(dock, css(other));
await desk.choose("Close");
await sleep(1500);
out.afterClosingTheOther = await entries();

// ---- a program with several windows: the desktop's own

const onTheDesktop = async () => {
    await a.js(`document.activeElement?.blur?.(); window.focus()`);
    await sleep(200);
};
const another = async () => {
    await onTheDesktop();
    await desk.key(" ", { code: "Space", vk: 32 });
    await sleep(800);
};
await another();
await another();
await another();
out.threeOfTheDesktopsOwn = await entries();
const went = [];
for (let i = 0; i < 4; i++) {
    await desk.press(dock, "#program-0 button");
    went.push((await desk.desk()).focused);
}
out.pressedFourTimes = went;
await desk.menuOn(dock, "#program-0");
out.menuOfWhatIsNotDeclared = await desk.menu();
await desk.picture("actions-menu.png");
out.choseCloseAll = await desk.choose("Close all 3 windows");
await sleep(1000);
out.afterClosingAll = { entries: await entries(), desk: await desk.desk() };

// ---- a workspace left empty between two in use

const chord = async (key) => {
    await desk.key(key, {
        code: `Key${key.toUpperCase()}`,
        vk: key.toUpperCase().charCodeAt(0),
        modifiers: 3,
    });
    await sleep(500);
};
const shown = async () => (await desk.desk()).inSight;
await another();
const first = (await shown())[0];
await chord("k");
await another();
const second = (await shown())[0];
await chord("k");
await another();
const third = (await shown())[0];
out.oneOnEachOfThree = {
    first,
    second,
    third,
    distinct: new Set([first, second, third]).size === 3,
};
await chord("j");
out.backOnTheSecond = await shown();
await a.js(
    `document.querySelector('.fx-surface[data-id="${second}"] .fx-button[data-part="close"]').click()`,
);
await sleep(800);
// Empty, and still where the person is.
out.emptiedAndStillThere = await shown();
await chord("k");
out.theThirdIsStillNext = await shown();
await chord("j");
await chord("j");
out.backOnTheFirst = await shown();
await chord("k");
// The empty one went as it was left: what was third is next to the first.
out.nextToTheFirstNow = await shown();
await chord("k");
out.andNothingAfterIt = await shown();
for (const id of [first, third]) {
    await a.js(
        `document.querySelector('.fx-surface[data-id="${id}"] .fx-button[data-part="close"]')?.click()`,
    );
}
await sleep(500);

out.dockLog = dock.log;
await desk.finish(out);
