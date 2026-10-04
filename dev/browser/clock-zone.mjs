// The desktop's clock and Gexora's times follow the machine's time zone
// (`node clock-zone.mjs`).
//
// The zone is set as System Settings sets it, in Machine\System\Time
// TimeZone; timed puts it in /etc/localtime; the top bar shows it from the
// next minute, and Gexora at its next render. Put back to UTC afterwards.
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();
const desk = await session(9366, { user: "dana", password: "dana-dev-password" });
const out = {};

const topbar = async () => {
    const frame = (await desk.frames(".topbar")).at(-1);
    return frame.js(`(() => { const t = document.querySelector(".topbar .clock"); return { shown: t.textContent, machine: t.getAttribute("datetime") }; })()`);
};
/** Waits until a few seconds into the next minute, when the bar has moved on. */
const nextMinute = async () => {
    const into = new Date().getSeconds();
    await sleep((63 - into) * 1000);
};

out.utc = { bar: await topbar(), guest: guest("date +%H:%M%z") };
guest(`reg set 'Machine\\System\\Time' TimeZone sz:Asia/Kolkata`);
await nextMinute();
out.kolkata = { bar: await topbar(), guest: guest("date +%H:%M%z") };
await desk.picture("clock-zone.png");

// Gexora: a file made now is Today, at the time here.
guest("touch /home/dana/clock-zone-check.txt");
await desk.launch("gexora /home/dana");
await sleep(2500);
const files = (await desk.frames(".entries")).at(-1);
out.gexora = await files?.js(`[...document.querySelectorAll(".entries li")].map((b) => b.innerText.replaceAll("\\n", " | ")).filter((t) => t.includes("clock-zone-check"))`);
await desk.picture("clock-zone-gexora.png");

guest(`reg del 'Machine\\System\\Time' TimeZone; rm -f /home/dana/clock-zone-check.txt`);
await nextMinute();
out.back = { bar: await topbar(), guest: guest("date +%H:%M%z") };
await desk.finish(out);
