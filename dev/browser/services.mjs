// Services Manager, in headless Chromium: every service, what each is doing,
// and the commands for them, offered only to whoever may use them.
//
// As dana, an administrator: the list and the details, a restart of sshd
// followed to its end, a stop and a start, finding by name, and a row's
// menu. As alice, an ordinary user (`node services.mjs alice`): what she is
// shown when no service is hers to see or control.
//
// The dev VM puts Services Manager in /usr/bin and declares it, so the
// launcher finds it as "services".
import { session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const desk = await session(alice ? 9361 : 9360, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "services-alice" : "services";

await desk.launch("services");
const manager = await desk.frame("input[name=find]", '.fx-surface[data-role="window"]');
if (!manager) {
    out.stopped = "no Services Manager window to attach to";
    await desk.finish(out, 1);
}
/** What the window shows. */
const shows = () => manager.js(`({
    rows: [...document.querySelectorAll(".entries button")].map((b) => b.querySelector(".name").textContent + " | " + b.querySelector(".state").textContent + (b.getAttribute("aria-selected") === "true" ? " | PICKED" : "")),
    bar: [...document.querySelectorAll(".bar .commands button")].map((b) => b.textContent + (b.disabled ? " (" + b.title + ")" : "")),
    said: document.querySelector(".said")?.textContent ?? null,
    trouble: document.querySelector(".trouble")?.textContent ?? null,
    more: document.querySelector(".more")?.textContent ?? null,
    footer: document.querySelector(".status")?.textContent ?? null,
    details: document.querySelector(".details") ? [...document.querySelectorAll(".details h2, .details .id, .details dt, .details dd, .details .note, .details .may, .details.empty p")].map((e) => e.textContent).join(" | ") : null,
})`);
/** Waits until `ready` says so of what the window shows, for up to `ms`. */
async function until(ready, ms = 15000) {
    for (let waited = 0; waited < ms; waited += 300) {
        const now = await shows();
        if (ready(now)) return now;
        await sleep(300);
    }
    return shows();
}

out.first = await until((s) => s.rows.length > 0 || s.trouble !== null || s.more === "There are no services you may see.");
await desk.picture(`${name}-list.png`);

// alice: what she may read is listed, and nothing is hers to do.
if (alice) {
    if (out.first.rows.length > 0) {
        await desk.press(manager, "#service-0");
        out.picked = await until((s) => s.rows[0]?.includes("PICKED"));
        await desk.picture(`${name}-picked.png`);
    }
    await desk.finish(out);
}

// sshd, picked by a real press: its details, and what may be done.
const row = (title) => manager.js(`[...document.querySelectorAll(".entries button")].findIndex((b) => b.querySelector(".name").textContent === ${JSON.stringify(title)})`);
await desk.press(manager, `#service-${await row("SSH server")}`);
out.picked = await until((s) => s.details?.includes("Process"));
await desk.picture(`${name}-picked.png`);

// Restart, by its button: under way, then done, and running again.
const button = (label) => `.bar .commands button:nth-child(${["Start", "Stop", "Restart", "Reload", "Reset"].indexOf(label) + 1})`;
await desk.press(manager, button("Restart"));
out.restarting = await shows();
out.restarted = await until((s) => s.said !== null);
await desk.picture(`${name}-restarted.png`);

// Stop, and it says it is stopped and offers Start; then Start.
await desk.press(manager, button("Stop"));
out.stopped = await until((s) => s.said !== null && s.rows.some((r) => r.startsWith("SSH server | Stopped")));
await desk.picture(`${name}-stopped.png`);
await desk.press(manager, button("Start"));
out.started = await until((s) => s.said?.includes("started") && s.rows.some((r) => r.startsWith("SSH server | Running")));

// Found by part of its name.
await manager.js(`document.querySelector("input[name=find]").focus()`);
await desk.type("ssh");
out.found = await until((s) => s.rows.length === 1);
await desk.picture(`${name}-found.png`);
await manager.js(`document.querySelector("input[name=find]").select()`);
await desk.key("Backspace", { vk: 8 });

// A row's menu: the commands, as offered for it.
await sleep(800);
out.menuSaid = await desk.menuOn(manager, `#service-${await row("Time client")}`);
out.menu = await desk.menu();
await desk.picture(`${name}-menu.png`);
await desk.key("Escape");

out.log = manager.log;
await desk.finish(out);
