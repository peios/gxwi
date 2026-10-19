// Network Manager's guard, in headless Chromium (`node network-manager-cutoff.mjs`).
//
// As dana, through the desktop's own connection: the web desktop blocked
// from private networks, which is the network this connection comes from.
// The change is named as one that disconnects; applied anyway, the
// connection goes; left alone, the change is undone after thirty seconds
// and the desktop comes back by itself.
import { guest, session, sleep } from "./harness.mjs";

const desk = await session(9370, { user: "dana", password: "dana-dev-password" });
const out = {};
const strips = () =>
    desk.a.js(
        `[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`,
    );
async function window(title, has) {
    for (let i = 0; i < 40; i++) {
        const ours = (await strips()).filter((strip) => strip.title.startsWith(title));
        if (ours.length > 0) {
            const frame = (await desk.frames(has)).at(-1);
            if (frame) {
                frame.surface = `.fx-surface[data-id="${ours.at(-1).id}"]`;
                return frame;
            }
        }
        await sleep(300);
    }
    return null;
}
async function gone(titles) {
    for (const strip of await strips()) {
        if (!titles.some((title) => strip.title.startsWith(title))) continue;
        const close = await desk.a.js(
            `(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
        if (close) await desk.pressAt(close);
        await sleep(800);
    }
}
await gone([""]);
await desk.launch("network");
await gone(["Get started"]);
const w = await window("Network Manager", "nav.side");
const press = (selector) =>
    w
        .js(
            `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
        )
        .then(() => desk.press(w, selector));
const flow = () =>
    guest(
        "reg get Machine/System/Network/Rules/Flow/dev-gxwi; reg get Machine/System/Network/Rules/Flow/gxwi-experimental",
    );
/** Whether the desktop answers a new connection from the host, through the same network. */
const answers = async () => {
    try {
        await fetch("https://127.0.0.1:7780/", { signal: AbortSignal.timeout(4000) });
        return true;
    } catch {
        return false;
    }
};
const shows = () =>
    w.js(`({
    connected: document.querySelector("#fx-root")?.dataset.connected ?? null,
    said: document.querySelector(".status .said")?.textContent ?? null,
    drawer: document.querySelector(".drawer")?.innerText.replaceAll("\\n", " | ").slice(0, 500) ?? null,
    modal: document.querySelector(".modal")?.innerText.replaceAll("\\n", " | ") ?? null,
    keep: document.querySelector(".keepbar")?.innerText.replaceAll("\\n", " ") ?? null,
})`);
await sleep(3000);
await press('nav.side button[fx-value-section="exposure"]');
await sleep(1500);
await w.js(
    `[...document.querySelectorAll(".matrix tbody tr")].find((tr) => tr.innerText.startsWith("Web desktop"))?.querySelector("td.c button")?.setAttribute("data-test", "cell")`,
);
await press('[data-test="cell"]');
await sleep(1200);
out.cell = await shows();
await desk.picture("network-manager-cutoff-cell.png");
await w.js(
    `[...document.querySelectorAll(".drawer button")].find((b) => b.innerText.startsWith("Block from"))?.setAttribute("data-test", "block")`,
);
await press('[data-test="block"]');
await sleep(1200);
out.asked = await shows();
await desk.picture("network-manager-cutoff-asked.png");
await w.js(
    `[...document.querySelectorAll(".modal button")].find((b) => b.innerText.startsWith("Apply"))?.setAttribute("data-test", "go")`,
);
await press('[data-test="go"]');
await sleep(6000);
out.applied = await shows();
out.flowApplied = flow();
out.answersApplied = await answers();
await desk.picture("network-manager-cutoff-applied.png");
await sleep(36000);
out.flowAfter = flow();
await sleep(8000);
out.answersAfter = await answers();
out.after = await shows();
await desk.picture("network-manager-cutoff-after.png");
await desk.finish(out);
