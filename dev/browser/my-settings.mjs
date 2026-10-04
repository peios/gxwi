// My Settings, in headless Chromium (`node my-settings.mjs`, then
// `node my-settings.mjs alice`).
//
// For whoever is signed in: their display name is saved and reaches lpsd;
// a wrong current password and two new ones that differ are refused in
// words; the password is changed and changed back, which only works if the
// change took; a key is refused with a wrong password and refused when it
// isn't one, then added, shown with its fingerprint, and taken away; their
// language and formats are saved under their own key and put back. Every
// password field is empty after each try. Needs en_GB.UTF-8 installed on the
// guest, for a language to choose.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guest as asGuest, session, sleep } from "./harness.mjs";

const guest = (command) => asGuest(command).replace(/\n?rc=\d+\s*$/, "").trim();
const alice = process.argv[2] === "alice";
const who = alice ? "alice" : "dana";
const password = `${who}-dev-password`;
const desk = await session(alice ? 9367 : 9366, alice ? undefined : { user: "dana", password });
const out = {};
const name = alice ? "my-settings-alice" : "my-settings";
// A key made for the check, thrown away with it.
const keyDir = mkdtempSync(join(tmpdir(), "my-settings-"));
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "settings check", "-f", join(keyDir, "k")]);
const key = readFileSync(join(keyDir, "k.pub"), "utf8").trim();
rmSync(keyDir, { recursive: true });

const strips = () => desk.a.js(`[...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => ({ id: s.dataset.id, title: s.innerText.split("\\n")[0].trim() }))`);
for (const strip of await strips()) {
    if (!["Get started", "My Settings"].some((title) => strip.title.startsWith(title))) continue;
    const close = await desk.a.js(`(() => { const r = document.querySelector('.fx-surface[data-id="${strip.id}"] [data-part="close"]')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    if (close) await desk.pressAt(close);
    await sleep(800);
}
await desk.launch("my");
await sleep(1500);
const w = (await desk.frames(".cards")).at(-1);
if (!w) {
    out.stopped = "no My Settings window";
    await desk.finish(out, 1);
}
w.surface = `.fx-surface[data-id="${(await strips()).filter((s) => s.title.startsWith("My Settings")).at(-1).id}"]`;
const shows = () => w.js(`({
    said: document.querySelector(".said")?.textContent ?? null,
    cards: [...document.querySelectorAll(".card")].map((c) => c.innerText.replaceAll("\\n", " | ").slice(0, 300)),
    editable: [...document.querySelectorAll("input, select, textarea")].filter((f) => !f.disabled).map((f) => f.name),
    buttons: [...document.querySelectorAll("button")].filter((b) => !b.disabled).map((b) => b.textContent),
    secrets: [...document.querySelectorAll('input[type="password"]')].map((f) => f.value).join(""),
})`);
const put = (field, value) => w.js(`(() => { const f = document.querySelector("[name='${field}']"); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); })()`);
const press = async (selector) => {
    await w.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`);
    return desk.press(w, selector);
};
/** Fills a form's fields, then submits it, and says what the window said. */
async function submit(form, fields) {
    for (const [field, value] of Object.entries(fields)) await put(field, value);
    await sleep(500);
    await press(`form[fx-submit="${form}"] button.primary`);
    await sleep(2500);
    const shown = await shows();
    return { said: shown.said, secretsLeft: shown.secrets.length };
}
const sid = guest(`lps show ${who} | grep -o 'S-1-5-21[-0-9]*' | head -1`);

out.start = await shows();
await desk.picture(`${name}.png`);

// The display name.
const nameWas = await w.js(`document.querySelector("[name='display-name']").value`);
out.name = await submit("save-name", { "display-name": "Settings Check" });
out.name.lps = guest(`lps show ${who} | grep -i 'display'`);
await submit("save-name", { "display-name": nameWas });

// The password: refused, then changed and changed back.
out.wrongPassword = await submit("change-password", { current: "not-it", new: "x-new-1", confirm: "x-new-1" });
out.mismatch = await submit("change-password", { current: password, new: "x-new-1", confirm: "x-new-2" });
out.changed = await submit("change-password", { current: password, new: `${password}-2`, confirm: `${password}-2` });
out.changedBack = await submit("change-password", { current: `${password}-2`, new: password, confirm: password });

// A key: refused, added, taken away.
out.keyWrongPassword = await submit("add-key", { key, "key-password": "not-it" });
out.notAKey = await submit("add-key", { key: "ssh-ed25519 AAAAnotakey", "key-password": password });
out.keyAdded = await submit("add-key", { key, "key-password": password });
out.keyAdded.listed = (await shows()).cards.find((c) => c.startsWith("SSH keys"));
out.keyAdded.lps = guest(`lps key list ${who} 2>&1`);
await desk.picture(`${name}-key.png`);
await press('button[fx-click="remove-key"]');
await sleep(1500);
out.asked = await w.js(`document.querySelector(".asking")?.innerText ?? null`);
await desk.picture(`${name}-remove.png`);
out.keyRemoved = await submit("confirm-remove", { "remove-password": password });
out.keyRemoved.lps = guest(`lps key list ${who} 2>&1`);

// Language and formats.
out.languages = await w.js(`[...document.querySelectorAll("[name='lang'] option")].map((o) => o.textContent)`);
out.language = await submit("save-language", { lang: "en_GB.UTF-8", formats: "en_GB.UTF-8" });
out.language.registry = guest(`reg get 'Users\\\\${sid}\\\\Locale' LANG; reg get 'Users\\\\${sid}\\\\Locale' LC_TIME`);
await desk.picture(`${name}-language.png`);
out.languageBack = await submit("save-language", { lang: "", formats: "" });
out.languageBack.registry = guest(`reg get 'Users\\\\${sid}\\\\Locale' LANG 2>&1`);

out.end = await shows();
out.log = w.log;
await desk.finish(out);
