// Services Manager, in headless Chromium: every service, what each is doing,
// and the commands for them, offered only to whoever may use them.
//
// As dana, an administrator: the list and the details, a restart of sshd
// followed to its end, a stop and a start, finding by name, and a row's
// menu. As alice, an ordinary user (`node services.mjs alice`): what she is
// shown when no service is hers to see or control.
//
// As dana with authority that varies by service (`node services.mjs mixed`):
// sshd's descriptor lets Administrators query it and nothing more, and
// pnpd's does not let them query it at all. The script sets both and puts
// them back. It also resets the Failed timed, reloads trustd, and counts the
// refusals peinit records while the window is open.
//
// The dev VM puts Services Manager in /usr/bin and declares it, so the
// launcher finds it as "services".
import { guest, session, sleep } from "./harness.mjs";

const alice = process.argv[2] === "alice";
const mixed = process.argv[2] === "mixed";
/** Who may do what with a service: SYSTEM everything, and Administrators what `admins` says. */
const descriptors = {
    sshd: "0100048014000000200000000000000030000000010100000000000512000000010200000000000520000000200200000200340002000000000014000f000000010100000000000512000000000018000100000001020000000000052000000020020000",
    pnpd: "01000480140000002000000000000000300000000101000000000005120000000102000000000005200000002002000002001c0001000000000014000f000000010100000000000512000000",
};
const denials = () => Number(guest(`evctl -f jsonl 'EVENTS access.denied' 2>/dev/null | wc -l`).split("\n")[0]);
if (mixed) {
    for (const [service, sd] of Object.entries(descriptors)) guest(`reg set 'Machine\\System\\Services\\${service}' ServiceSecurity hex:${sd}`);
}
const desk = await session(alice ? 9361 : mixed ? 9362 : 9360, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "services-alice" : mixed ? "services-mixed" : "services";

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

/** The index of the row called `title`, scrolled into sight for a real press. */
const row = (title) => manager.js(`(() => {
    const rows = [...document.querySelectorAll(".entries button")];
    const at = rows.findIndex((b) => b.querySelector(".name").textContent === ${JSON.stringify(title)});
    rows[at]?.scrollIntoView({ block: "center" });
    return at;
})()`);
const button = (label) => `.bar .commands button:nth-child(${["Start", "Stop", "Restart", "Reload", "Reset"].indexOf(label) + 1})`;

if (mixed) {
    // sshd may be looked at and nothing more; pnpd is not dana's to see.
    await desk.press(manager, `#service-${await row("SSH server")}`);
    out.narrowed = await until((s) => s.details?.includes("Process"));
    await desk.picture(`${name}-narrowed.png`);
    await desk.press(manager, `#service-${await row("PNP viewer")}`);
    out.hidden = await until((s) => s.rows.some((r) => r.startsWith("PNP viewer") && r.endsWith("PICKED")));
    await desk.picture(`${name}-hidden.png`);
    // Left on the hidden one for 20 s, the window adds no refusals of its own
    // beyond what each look's `list` costs.
    const before = denials();
    await sleep(20000);
    out.refusalsIn20s = denials() - before;
    // timed is Failed: Reset clears it.
    await desk.press(manager, `#service-${await row("Time client")}`);
    await until((s) => s.rows.some((r) => r.startsWith("Time client") && r.endsWith("PICKED")));
    out.beforeReset = (await shows()).bar;
    await desk.press(manager, button("Reset"));
    out.reset = await until((s) => s.said !== null);
    // trustd reloads.
    await desk.press(manager, `#service-${await row("Trust store")}`);
    await until((s) => s.details?.includes("Process"));
    await desk.press(manager, button("Reload"));
    out.reloaded = await until((s) => s.said?.includes("Trust store"));
    await desk.picture(`${name}-reloaded.png`);
    for (const service of Object.keys(descriptors)) guest(`reg del 'Machine\\System\\Services\\${service}' ServiceSecurity`);
    out.putBack = guest("svctl list | grep -c . ; svctl status pnpd | head -1");
    await desk.finish(out);
}

// sshd, picked by a real press: its details, and what may be done.
await desk.press(manager, `#service-${await row("SSH server")}`);
out.picked = await until((s) => s.details?.includes("Process"));
await desk.picture(`${name}-picked.png`);

// Restart, by its button: under way, then done, and running again.
const pressedAt = Date.now();
await desk.press(manager, button("Restart"));
out.restarting = await shows();
out.restarted = await until((s) => s.said !== null, 60000);
out.restartSaidAfterMs = Date.now() - pressedAt;
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
