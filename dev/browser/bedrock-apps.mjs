// Every GXWI app on a release image opens from the launcher by its title,
// as a person opens it, and shows a window (PEI-1400). The machine is not
// the dev VM: its desktop is forwarded to 127.0.0.1:7780 and the person is
// named in the environment.
//
//     BEDROCK_USER=jack BEDROCK_PASSWORD=… node dev/browser/bedrock-apps.mjs
//
// The permissions editor and the file dialog are listed nowhere: they are
// opened by File Explorer (Permissions… on a file in the home folder) and by
// Package Manager (Install from File…), as the apps that use them do.
import { session, sleep } from "./harness.mjs";

const who = { user: process.env.BEDROCK_USER, password: process.env.BEDROCK_PASSWORD };
const desk = await session(9377, who);
const APPS = [
    "File Explorer",
    "Task Manager",
    "Services Manager",
    "Event Viewer",
    "Registry Editor",
    "Principals Manager",
    "Security Policy",
    "Package Manager",
    "Feature Manager",
    "Upgrade Peios",
    "Disk Manager",
    "Network Manager",
    "System Settings",
    "My Settings",
    "Desktop Settings",
    "SSH Settings",
    "Get started",
];

const strips = () =>
    desk.a.js(`[...document.querySelectorAll('.fx-surface')].map((s) => ({
    id: s.dataset.id, role: s.dataset.role, title: s.innerText.split("\\n")[0].trim() }))`);

async function closeAll() {
    for (const s of (await strips()).filter((s) => s.role === "window" || s.role === "dialog")) {
        const at = await desk.a.js(
            `(() => { const r = document.querySelector('.fx-surface[data-id="${s.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
        if (at) await desk.pressAt(at);
        await sleep(700);
    }
}

/** Waits for a surface that wasn't there before, and says what it is. */
async function appeared(before, seconds = 20) {
    for (let i = 0; i < seconds * 2; i++) {
        const now = (await strips()).filter(
            (s) => !before.has(s.id) && (s.role === "window" || s.role === "dialog"),
        );
        if (now.length) return now;
        await sleep(500);
    }
    return [];
}

const out = { user: who.user, apps: {} };
await sleep(3000);
await closeAll();
for (const title of APPS) {
    const before = new Set((await strips()).map((s) => s.id));
    // The keyboard to the desktop first, as a person's press on it gives it:
    // with no window open, nothing else has.
    await desk.pressAt({ x: 600, y: 400 });
    await sleep(500);
    // BEDROCK_TYPE=first types the title's first word only, as on a fenesh
    // older than 0.0.4, whose launcher took the rest for arguments.
    await desk.launch(
        process.env.BEDROCK_TYPE === "first"
            ? title.toLowerCase().split(" ")[0]
            : title.toLowerCase(),
    );
    const opened = await appeared(before);
    await sleep(2500);
    const shot = `bedrock-${title.toLowerCase().replaceAll(" ", "-")}.png`;
    await desk.picture(shot);
    out.apps[title] = { opened: opened.map((s) => `${s.role}: ${s.title}`), shot };
    await closeAll();
}
out.log = desk.a.log.filter((l) => /error|panic|refused/i.test(l)).slice(0, 20);
await desk.finish(out, Object.values(out.apps).every((a) => a.opened.length) ? 0 : 1);
