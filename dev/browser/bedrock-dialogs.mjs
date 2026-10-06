// The two programs no launcher lists, on a release image, opened as the apps
// that use them open them (PEI-1400): the permissions editor from Gexora's
// Permissions… on a file in the home folder, and the file dialog from
// Package Manager's Install from File…. Environment as for bedrock-apps.mjs;
// the file is made beforehand (BEDROCK_SSH 'touch ~/note.txt').
import { session, sleep } from "./harness.mjs";

const desk = await session(9380, { user: process.env.BEDROCK_USER, password: process.env.BEDROCK_PASSWORD });
const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface')].map((s) => ({ id: s.dataset.id, role: s.dataset.role, title: s.innerText.split("\\n")[0].trim() }))`);
const dialogs = async () => (await strips()).filter((s) => s.role === "dialog").map((s) => s.title);
async function opened(word, title, has) {
    await desk.pressAt({ x: 600, y: 400 });
    await sleep(500);
    await desk.launch(word);
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).filter((s) => s.title.startsWith(title));
        const frame = ours.length ? (await desk.frames(has)).at(-1) : null;
        if (frame) { frame.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`; return frame; }
        await sleep(300);
    }
    return null;
}
const out = {};
await sleep(3000);

const gexora = await opened("gexora", "Gexora", ".listing");
out.gexora = Boolean(gexora);
if (gexora) {
    desk.surface = gexora.surface;
    await desk.menuOn(gexora, `.entries [fx-value-name="note.txt"]`);
    out.menu = await desk.menu();
    await desk.choose("Permissions…");
    await sleep(3000);
    out.permissions = await dialogs();
    await desk.picture("bedrock-permissions.png");
    const editor = await desk.frame(".editor", '.fx-surface[data-role="dialog"]');
    out.editorShows = await editor?.js(`document.querySelector(".editor")?.innerText.slice(0, 160).replaceAll("\\n", " ") ?? null`);
    if (editor) await desk.press(editor, `footer [fx-click="cancel"]`);
    await sleep(1000);
}

const packages = await opened("package", "Package Manager", "#st-nav-available");
out.packageManager = Boolean(packages);
if (packages) {
    // Install from File… is on Available.
    await desk.press(packages, "#st-nav-available");
    await sleep(1500);
    out.installFromFile = await packages.js(`!!document.querySelector('[fx-click="install-file"]')`);
    if (out.installFromFile) {
        await desk.press(packages, '[fx-click="install-file"]');
        await sleep(3000);
        out.fileDialog = await dialogs();
        await desk.picture("bedrock-file-dialog.png");
    }
}
await desk.finish(out, out.permissions?.length && out.fileDialog?.length ? 0 : 1);
