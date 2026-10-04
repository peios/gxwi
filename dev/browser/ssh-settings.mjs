// SSH Settings, in headless Chromium (`node ssh-settings.mjs`, then
// `node ssh-settings.mjs alice`).
//
// As dana, an administrator: the server, its port and host key are shown;
// moving the port from the window moves the reservation and firewall rule
// and sshd answers on the new port; then it is moved back. As alice, who
// isn't an administrator, everything reads, nothing can be changed, the host
// key is the administrators' to see, and the window says why.
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();
const alice = process.argv[2] === "alice";
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password: "dana-dev-password" });
const out = {};
const name = alice ? "ssh-settings-alice" : "ssh-settings";

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
for (const strip of await strips()) {
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch("ssh");
await sleep(1500);
const frames = await desk.frames(".cards");
if (frames.length === 0) {
    out.stopped = "no SSH Settings window";
    await desk.finish(out, 1);
}
const w = frames.at(-1);
w.surface = `.fx-surface[data-id="${(await strips()).at(-1).id}"]`;
const shows = () => w.js(`({
    said: document.querySelector(".said")?.textContent ?? null,
    cards: [...document.querySelectorAll(".card")].map((c) => c.innerText.replaceAll("\\n", " | ")),
    editable: [...document.querySelectorAll("input")].filter((f) => !f.disabled).map((f) => f.name),
    buttons: [...document.querySelectorAll(".actions button")].map((b) => b.textContent + (b.disabled ? " (off)" : "")),
    why: [...document.querySelectorAll(".why")].map((p) => p.textContent),
})`);
const put = (field, value) => w.js(`(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);

out.shown = await shows();
await desk.picture(`${name}.png`);

if (!alice) {
    await put("port", "2200");
    await sleep(600);
    await desk.press(w, 'form[fx-submit="port"] button.primary');
    await sleep(4000);
    out.moved = {
        said: (await shows()).said,
        rule: guest(`reg get 'Machine\\System\\Network\\Rules\\Flow\\ssh' DstPort.Equal`),
        ssh: guest(`env SSH_ASKPASS=/tmp/pw SSH_ASKPASS_REQUIRE=force DISPLAY=x ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -p 2200 alice@127.0.0.1 'echo answered on 2200' 2>&1 | tail -1`),
    };
    await desk.picture(`${name}-moved.png`);
    await put("port", "22");
    await sleep(600);
    await desk.press(w, 'form[fx-submit="port"] button.primary');
    await sleep(4000);
    out.back = { said: (await shows()).said, status: guest("ssh-settings | head -2") };
}

out.log = w.log;
await desk.finish(out);
