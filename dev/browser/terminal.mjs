// peiterm, in headless Chromium. What matters is that a window started from
// the launcher has the person's shell in it, as them, on a terminal of the
// size the window has room for; that what is typed is run and what is
// printed is drawn, colours included; that Ctrl+C reaches what is running;
// that the desktop's keys still work with the keyboard in it; that a page
// that comes later is shown the terminal as it stands; that what is
// selected is copied and what is copied is pasted; and that the shell
// ending takes the window with it.
//
// It needs ../../../peiterm/dev/push.sh to have put peiterm on the share.
import { guest, session, sleep } from "./harness.mjs";

const out = {};
const desk = await session(9356);
const { a, whole } = desk;
process.on("uncaughtException", (error) => desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1));
process.on("unhandledRejection", (error) => desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1));
out.leaveToRead = (await whole?.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: "http://127.0.0.1:7780" }))?.error?.message ?? "given";

// The terminal's window, whatever other windows there are.
const WINDOW = '.fx-surface[data-role="window"]:has(iframe[src*="/term/"])';
const find = () => desk.frame(".xterm", WINDOW);

await desk.launch("terminal");
let term = await find();
if (!term) await desk.finish({ ...out, stopped: "no terminal: is peiterm in the catalogue?", desk: await desk.desk() }, 1);

/** The lines drawn that have anything on them. */
const drawn = (frame = term) => frame.js(`[...document.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent.replace(/\\s+$/, "")).filter(Boolean)`);
/** Types as a keyboard does, a key at a time. */
async function type(text) {
    for (const letter of text) {
        const enter = letter === "\n";
        // Only a letter or a digit has the number of its key for its own: a
        // sign's number is some other key's, an arrow's or Home's.
        const vk = enter ? 13 : /[a-z0-9 ]/i.test(letter) ? letter.toUpperCase().charCodeAt(0) : 0;
        const params = { key: enter ? "Enter" : letter, code: enter ? "Enter" : "", windowsVirtualKeyCode: vk };
        await a.send("Input.dispatchKeyEvent", { type: "keyDown", ...params, text: enter ? "\r" : letter });
        await a.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    }
    await sleep(700);
}
const control = async (letter, more = 0) => desk.key(letter, { code: `Key${letter.toUpperCase()}`, vk: letter.toUpperCase().charCodeAt(0), modifiers: 2 | more });
/** The line after the one that has `command` on it. */
const answer = async (command) => {
    const lines = await drawn();
    const at = lines.findLastIndex((line) => line.endsWith(command));
    return at < 0 ? null : lines[at + 1] ?? null;
};

// ---- as it starts

await desk.press(term, ".xterm");
out.atFirst = {
    drawn: await drawn(),
    strip: await a.js(`document.querySelector('${WINDOW} .fx-title')?.textContent`),
    deaf: await a.js(`document.querySelector('${WINDOW}')?.dataset.deaf ?? null`),
    keyboardIn: await term.js(`document.activeElement?.className ?? null`),
    said: await term.js(`document.getElementById("said").hidden ? null : document.getElementById("said").textContent`),
};

// ---- what is typed is run, as the person, on a terminal

await type("echo made-$((6*7))\n");
out.ran = await answer("echo made-$((6*7))");
await type("tty; echo $TERM in $PWD\n");
out.onATerminal = (await drawn()).slice(-3);
await type("stty size\n");
const room = await term.js(`(() => { const s = document.querySelector(".xterm-screen").getBoundingClientRect(); const r = document.querySelector(".xterm-rows > div").getBoundingClientRect(); return { rows: document.querySelectorAll(".xterm-rows > div").length, wide: Math.round(s.width), high: Math.round(s.height), rowHigh: r.height }; })()`);
out.size = { saysTheShell: await answer("stty size"), rowsDrawn: room.rows, room };
await type("touch made-by-the-terminal; ls -l made-by-the-terminal; rm made-by-the-terminal\n");
out.asThePerson = (await drawn()).slice(-2);

// ---- colours

await type("printf '\\033[31mred \\033[1;32mgreen\\033[m plain\\n'\n");
out.colours = await term.js(`[...document.querySelectorAll(".xterm-rows span")].filter((s) => /^(red|green)/.test(s.textContent.trim())).map((s) => ({ says: s.textContent.trim(), colour: getComputedStyle(s).color, weight: getComputedStyle(s).fontWeight }))`);
await desk.picture("terminal.png");

// ---- Ctrl+C reaches what is running

await type("sleep 300\n");
await control("c");
await sleep(500);
await type("echo after-$?\n");
out.afterCtrlC = await answer("echo after-$?");

// ---- the desktop's keys, with the keyboard in the terminal

const before = await desk.desk();
await desk.launch("hello");
const withAnother = await desk.desk();
await desk.press(term, ".xterm");
const onTheTerminal = (await desk.desk()).focused;
await desk.key("k", { code: "KeyK", vk: 75, modifiers: 1 });
await sleep(500);
out.desktopKeys = { windows: [before.windows.length, withAnother.windows.length], focusWas: onTheTerminal, focusIs: (await desk.desk()).focused };
await desk.press(term, ".xterm");
await type("echo nothing-typed-by-that\n");
out.afterTheChord = (await drawn()).slice(-3);

// ---- a smaller window

await a.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 500, deviceScaleFactor: 1, mobile: false });
await sleep(1500);
await desk.press(term, ".xterm");
await type("stty size\n");
out.smaller = { saysTheShell: await answer("stty size") ?? (await drawn()), rowsDrawn: await term.js(`document.querySelectorAll(".xterm-rows > div").length`) };
await a.send("Emulation.clearDeviceMetricsOverride");
await sleep(1500);
await desk.press(term, ".xterm");
await type("stty size\n");
out.biggerAgain = await answer("stty size");

// ---- copying and pasting

await type("echo copy-this-word\n");
const word = await term.js(`(() => {
    const row = [...document.querySelectorAll(".xterm-rows > div")].findLast((row) => row.textContent.startsWith("copy-this-word"));
    const r = row?.getBoundingClientRect();
    const cell = document.querySelector(".xterm-screen").getBoundingClientRect().width / ${"1"};
    return r ? { x: r.left + 30, y: r.top + r.height / 2 } : null;
})()`);
const origin = await a.js(`(() => { const r = document.querySelector('${WINDOW} iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
if (word) {
    const at = { x: origin.x + word.x, y: origin.y + word.y, button: "left" };
    for (const clickCount of [1, 2]) {
        await a.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, buttons: 1, clickCount });
        await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, buttons: 0, clickCount });
    }
    await sleep(300);
    out.selected = await term.js(`document.querySelector(".xterm-selection div") ? "something" : "nothing"`);
    await control("c", 8);
    await sleep(500);
    out.copied = await a.js(`navigator.clipboard.readText().catch((e) => "could not be read back: " + e.message)`);
}
await desk.press(term, ".xterm");
await type("echo pasted: ");
await a.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "V", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 10, commands: ["paste"] });
await a.send("Input.dispatchKeyEvent", { type: "keyUp", key: "V", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 10 });
await sleep(500);
await type("\n");
out.pasted = (await drawn()).slice(-3);

// ---- a page that comes later

await type("n=0; while [ $n -lt 60 ]; do n=$((n+1)); echo line $n; done; printf '\\033[34mblue\\033[m and the last\\n'\n");
const last = await drawn();
await a.send("Page.reload");
await sleep(5000);
term = await find();
out.afterComingBack = term
    ? {
          same: JSON.stringify(await drawn()) === JSON.stringify(last),
          drawn: (await drawn()).slice(-4),
          blue: await term.js(`[...document.querySelectorAll(".xterm-rows span")].filter((s) => s.textContent.trim() === "blue").map((s) => getComputedStyle(s).color)`),
      }
    : "no terminal after coming back";
if (term) {
    // What went off the top came too: a screenful back is the lines before.
    await desk.press(term, ".xterm");
    await desk.key("PageUp", { vk: 33, modifiers: 8 });
    out.aScreenfulBack = (await drawn()).slice(0, 2);
    await type("\n");
}

// ---- a program with the whole screen

if (term) {
    await desk.press(term, ".xterm");
    await type("printf '\\033[?1049h\\033[2J\\033[Hthe whole screen'; sleep 6; printf '\\033[?1049l'\n");
    out.wholeScreen = await drawn();
    await a.send("Page.reload");
    await sleep(3000);
    term = await find();
    out.wholeScreenOnComingBack = term ? await drawn() : null;
    await sleep(4500);
    out.onceItGaveTheScreenUp = term ? (await drawn()).slice(-3) : null;
}

// ---- the shell ending, and the window closed

if (term) {
    await desk.press(term, ".xterm");
    const windows = (await desk.desk()).windows.length;
    await type("exit\n");
    await sleep(1500);
    out.afterExit = { windowsGone: windows - (await desk.desk()).windows.length };
}
await desk.launch("terminal");
term = await find();
if (term) {
    await desk.press(term, ".xterm");
    await type("sleep 987\n");
    // The guest has no ps: what is running is what /proc has.
    const count = (what) => guest(`for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '${what}'; true`).trim().split("\n")[0];
    const running = () => count("^sleep 987");
    out.peitermsBefore = count("^/usr/bin/peiterm");
    const was = running();
    await a.js(`document.querySelector('${WINDOW} .fx-button[data-part="close"]').click()`);
    await sleep(2000);
    out.closedByThePerson = { windowsLeft: (await desk.desk()).windows.length, sleepingBefore: was, sleepingAfter: running(), peiterms: count("^/usr/bin/peiterm") };
    out.termLog = term.log;
}

await desk.finish(out);
