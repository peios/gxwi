// peitor, in headless Chromium. What matters is that a file opened from
// Gexora is opened in the editor, in a window called what the file is; that
// what is typed is in the file once it is saved and not before; that what
// is typed and not saved is still there after the page has gone and come
// back; that what something else does to the file is taken in, or asked
// about when there is something here to lose; that closing asks first when
// there is; that a new file is saved where the person says; and that what
// is not text is not shown.
//
// It needs ../../../peitor/dev/push.sh and ../../../gexora/dev/push.sh to
// have put both on the share. It works in a directory of its own in
// alice's home, made afresh by the VM's administrator.
import { guest, session, sleep } from "./harness.mjs";

const AT = "/home/alice/peitor-check";
const out = {
    made: guest(
        `rm -rf ${AT}; mkdir -p ${AT} && printf 'first\\nsecond\\n' > ${AT}/notes.txt && printf 'one\\r\\ntwo\\r\\n' > ${AT}/dos.txt` +
            ` && printf 'all: build\\n' > ${AT}/Makefile && printf '\\211PNG\\000\\000' > ${AT}/image.bin` +
            ` && i=0; while [ $i -lt 5000 ]; do echo "line $i of a file that is long enough to be worth measuring"; i=$((i+1)); done > ${AT}/long.txt; ls -l ${AT}`,
    ).trim().split("\n"),
};
const desk = await session(9357);
const { a } = desk;
process.on("uncaughtException", (error) => desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1));
process.on("unhandledRejection", (error) => desk.finish({ ...out, stopped: String(error?.stack ?? error) }, 1));

const onDisk = (name) => guest(`cat ${AT}/${name}; echo; od -c ${AT}/${name} | tail -3`).split("\nrc=")[0];
/** The windows there are, by what their strips call them. */
const windows = () => a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: Number(s.dataset.id), called: s.querySelector(".fx-title")?.textContent ?? null }))`);
/** The frame of the window called `called` that has `has` in it. */
async function windowCalled(called, has) {
    const found = (await windows()).findLast((window) => window.called === called);
    if (!found) return null;
    const surface = `.fx-surface[data-id="${found.id}"]`;
    for (const frame of await desk.frames(has)) {
        frame.surface = surface;
        // The one that is where that surface's frame is.
        const here = await frame.js(`document.title`);
        if (here === called) return Object.assign(frame, { id: found.id });
    }
    return null;
}
const says = (editor) => editor.js(`({
    text: document.querySelector("textarea")?.value ?? null,
    state: document.querySelector(".state")?.textContent ?? null,
    counted: document.querySelector(".status span:last-child")?.textContent ?? null,
    path: document.querySelector(".path")?.textContent ?? null,
    trouble: document.querySelector(".trouble")?.textContent ?? null,
    asking: document.querySelector(".asking p, .asking label")?.textContent ?? null,
    refused: document.querySelector(".refused")?.textContent ?? null,
    keyboardOn: document.activeElement?.matches("textarea") ? "the text" : document.activeElement?.matches("input") ? "a field holding " + JSON.stringify(document.activeElement.value) : document.activeElement?.textContent?.trim().slice(0, 40) ?? null,
})`);
const brief = (said) => ({ ...said, text: said.text === null ? null : said.text.length > 80 ? `${said.text.length} characters ending ${JSON.stringify(said.text.slice(-30))}` : said.text });
const control = (letter, more = 0) => desk.key(letter, { code: `Key${letter.toUpperCase()}`, vk: letter.toUpperCase().charCodeAt(0), modifiers: 2 | more });
const toTheEnd = () => desk.key("End", { vk: 35, modifiers: 2 });

// A session outlasts the page that was looking at it, so a check that was
// stopped part way leaves its windows behind. They are closed first.
out.leftBehind = (await windows()).map((window) => window.called);
await a.js(`document.querySelectorAll('.fx-surface[data-role="window"] .fx-button[data-part="close"]').forEach((button) => button.click())`);
await sleep(1500);

// ---- opened from Gexora

await desk.launch(`gexora ${AT}`);
let gexora = await desk.frame(".listing", '.fx-surface[data-role="window"]');
if (!gexora) await desk.finish({ ...out, stopped: "no Gexora: is it in the catalogue?" }, 1);
const row = (name) => `.entries [fx-value-name="${name}"]`;
await desk.menuOn(gexora, row("notes.txt"));
out.menuOfATextFile = await desk.menu();
out.choseOpen = await desk.choose("Open");
await sleep(3500);
out.windows = await windows();
let editor = await windowCalled("notes.txt", "textarea");
if (!editor) await desk.finish({ ...out, stopped: "no editor on notes.txt" }, 1);
out.opened = await says(editor);

// ---- typed, and then saved

await desk.press(editor, "textarea");
await toTheEnd();
await desk.type("third\n");
out.typed = { ...(await says(editor)), onDisk: onDisk("notes.txt") };
await desk.picture("editor.png");
await control("s");
await sleep(500);
out.saved = { ...(await says(editor)), onDisk: onDisk("notes.txt") };

// ---- typed and not saved, the page gone and come back

await desk.type("not saved yet");
await a.send("Page.reload");
await sleep(5000);
editor = await windowCalled("notes.txt", "textarea");
gexora = await windowCalled("Gexora", ".listing");
out.afterComingBack =editor ? { ...(await says(editor)), onDisk: onDisk("notes.txt") } : "no editor after coming back";
if (!editor) await desk.finish(out, 1);

// ---- changed by something else, with something here to lose

guest(`printf 'theirs, written underneath\\n' > ${AT}/notes.txt`);
await sleep(3500);
out.changedUnderneath = await says(editor);
await desk.picture("editor-asking.png");
out.pressedKeep = await desk.press(editor, '.asking [fx-click="keep"]');
await desk.press(editor, "textarea");
await control("s");
await sleep(500);
out.keptAndSaved = { ...(await says(editor)), onDisk: onDisk("notes.txt") };

// ---- changed by something else, with nothing here to lose

guest(`printf 'theirs again, and nothing to ask\\n' > ${AT}/notes.txt`);
await sleep(3500);
out.takenIn = await says(editor);

// ---- closing, with something to lose and without

await desk.press(editor, "textarea");
await toTheEnd();
await desk.type("to be discarded");
const close = (id) => a.js(`document.querySelector('.fx-surface[data-id="${id}"] .fx-button[data-part="close"]').click()`);
await close(editor.id);
await sleep(800);
out.askedBeforeClosing = { ...(await says(editor)), stillThere: (await windows()).some((window) => window.id === editor.id) };
await desk.key("Escape");
out.afterEscape = await says(editor);
await close(editor.id);
await sleep(800);
out.pressedDiscard = await desk.press(editor, '.asking [fx-click="close-discarded"]');
await sleep(800);
out.afterDiscarding = { stillThere: (await windows()).some((window) => window.id === editor.id), onDisk: onDisk("notes.txt") };

// ---- line endings kept, and a file whose name says nothing

await desk.press(gexora, row("dos.txt"));
await desk.key("Enter", {}, "\r");
await sleep(3500);
editor = await windowCalled("dos.txt", "textarea");
if (editor) {
    out.dos = await says(editor);
    await desk.press(editor, "textarea");
    await toTheEnd();
    await desk.type("three\n");
    await control("s");
    await sleep(500);
    out.dosSaved = { state: (await says(editor)).state, onDisk: onDisk("dos.txt") };
    await close(editor.id);
    await sleep(800);
    out.closedWithNothingToLose = !(await windows()).some((window) => window.id === editor.id);
} else out.dos = "no editor on dos.txt";

await desk.press(gexora, row("Makefile"));
await desk.key("Enter", {}, "\r");
await sleep(3500);
editor = await windowCalled("Makefile", "textarea");
out.aNameThatSaysNothing = editor ? brief(await says(editor)) : { noEditor: await gexora.js(`document.querySelector(".trouble")?.textContent ?? null`) };
if (editor) await close(editor.id);
await desk.press(gexora, row("image.bin"));
await desk.key("Enter", {}, "\r");
await sleep(1500);
out.whatIsNotText = { gexoraSays: await gexora.js(`document.querySelector(".trouble")?.textContent ?? null`), windows: (await windows()).map((window) => window.called) };

// ---- a long file

await desk.press(gexora, row("long.txt"));
await desk.key("Enter", {}, "\r");
await sleep(4000);
editor = await windowCalled("long.txt", "textarea");
if (editor) {
    out.long = brief(await says(editor));
    await desk.press(editor, "textarea");
    await toTheEnd();
    const began = Date.now();
    await desk.type("the last line\n");
    let heard = 0;
    for (; heard < 50 && (await says(editor)).state !== "Not saved"; heard++) await sleep(100);
    out.longTyped = { saidNotSavedWithin: `${Date.now() - began} ms`, state: (await says(editor)).state };
    const saving = Date.now();
    await control("s");
    for (heard = 0; heard < 50 && (await says(editor)).state !== "Saved"; heard++) await sleep(100);
    out.longSaved = { within: `${Date.now() - saving} ms`, ...brief(await says(editor)), onDisk: guest(`wc -c ${AT}/long.txt; tail -n 2 ${AT}/long.txt`).split("\nrc=")[0] };
    await close(editor.id);
    await sleep(800);
} else out.long = "no editor on long.txt";

// ---- a new file, saved where the person says

// By its id, which a launcher finds it by as well as by its title. The
// launcher takes what follows the first word as what the program is given.
await desk.launch("peitor");
editor = await windowCalled("Untitled", "textarea");
if (editor) {
    out.aNewFile = await says(editor);
    await desk.press(editor, "textarea");
    await desk.type("made here\n");
    await control("s");
    await sleep(800);
    out.askedWhere = await says(editor);
    await desk.picture("editor-saving.png");
    await desk.type(`${AT}/notes.txt`);
    await desk.key("Enter", {}, "\r");
    await sleep(800);
    out.overSomething = { ...(await says(editor)), onDisk: onDisk("notes.txt") };
    await control("a");
    await desk.type(`${AT}/made.txt`);
    await desk.key("Enter", {}, "\r");
    await sleep(1000);
    out.savedAs = { ...(await says(editor)), called: (await windows()).find((window) => window.id === editor.id)?.called, onDisk: onDisk("made.txt") };
    out.editorLog = editor.log;
} else out.aNewFile = { noEditor: await windows() };

out.gexoraLog = gexora.log;
await desk.finish(out);
