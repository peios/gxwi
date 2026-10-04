// SSH Settings, in headless Chromium (`node ssh-settings.mjs`, then
// `node ssh-settings.mjs alice`).
//
// As dana, an administrator: the server, its port and host key are shown.
// Moving the port asks first, since it disconnects people; confirmed, it
// moves the reservation and firewall rule and sshd answers on the new port;
// then it is moved back. Turning passwords off and turning the server off
// ask too, and cancelled, change nothing. As alice, who isn't an
// administrator, everything reads, nothing can be changed, the host key is
// the administrators' to see, and the page says why, once.
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
const frames = await desk.frames(".st-page");
if (frames.length === 0) {
    out.stopped = "no SSH Settings window";
    await desk.finish(out, 1);
}
const w = frames.at(-1);
w.surface = `.fx-surface[data-id="${(await strips()).filter((s) => s.title.startsWith("SSH Settings")).at(-1).id}"]`;
const shows = () => w.js(`({
    said: document.querySelector(".st-status .said")?.textContent ?? null,
    hero: document.querySelector(".st-hero")?.innerText.replaceAll("\\n", " | ") ?? null,
    groups: [...document.querySelectorAll(".st-group")].map((g) => g.innerText.replaceAll("\\n", " | ")),
    editable: [...document.querySelectorAll("input")].filter((f) => !f.disabled).map((f) => f.name),
    buttons: [...document.querySelectorAll(".st-page button")].filter((b) => !b.disabled).map((b) => b.textContent),
    banner: document.querySelector(".st-banner")?.textContent ?? null,
    asking: document.querySelector(".st-more.asking")?.innerText.replaceAll("\\n", " | ") ?? null,
})`);
const put = (field, value) => w.js(`(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const checked = (field) => w.js(`document.querySelector("[name='${field}']").checked`);
const press = async (selector) => {
    await w.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`);
    return desk.press(w, selector);
};

out.shown = await shows();
await desk.picture(`${name}.png`);

if (!alice) {
    // The port: typed, applied, asked about, confirmed.
    await put("port", "2200");
    await sleep(600);
    await press('form[fx-submit="port"] button');
    await sleep(1200);
    out.portAsked = (await shows()).asking;
    await desk.picture(`${name}-asking.png`);
    await press('button[fx-click="confirm"]');
    await sleep(4000);
    out.moved = {
        said: (await shows()).said,
        hero: (await shows()).hero,
        rule: guest(`reg get 'Machine\\System\\Network\\Rules\\Flow\\ssh' DstPort.Equal`),
        ssh: guest(`env SSH_ASKPASS=/tmp/pw SSH_ASKPASS_REQUIRE=force DISPLAY=x ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -p 2200 alice@127.0.0.1 'echo answered on 2200' 2>&1 | tail -1`),
    };
    await desk.picture(`${name}-moved.png`);
    await put("port", "22");
    await sleep(600);
    await press('form[fx-submit="port"] button');
    await sleep(1200);
    await press('button[fx-click="confirm"]');
    await sleep(4000);
    out.back = { said: (await shows()).said, status: guest("ssh-settings | head -2") };

    // Passwords off asks, and cancelled, they are still accepted.
    await press('input[name="passwords"]');
    await sleep(1200);
    out.passwordsAsked = { asking: (await shows()).asking, still: await checked("passwords") };
    await press('button[fx-click="cancel"]');
    await sleep(1200);
    out.passwordsKept = { asking: (await shows()).asking, on: await checked("passwords"), registry: guest(`reg get 'Machine\\Software\\OpenSSH' PasswordAuthentication`) };

    // Off asks too.
    await press('input[name="enabled"]');
    await sleep(1200);
    out.offAsked = { asking: (await shows()).asking, still: await checked("enabled") };
    await press('button[fx-click="cancel"]');
    await sleep(1200);
    out.offKept = { on: await checked("enabled"), status: guest("svctl status sshd | head -1") };
}

out.log = w.log;
await desk.finish(out);
