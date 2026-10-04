// What the checks here have in common: a headless Chromium, a session as
// alice on the dev VM, and ways to look into the desktop's page and the
// frames of its surfaces and to press things in them as a person does.
//
//     const desk = await session(9354);
//     const dock = await desk.frame(".dock", '.fx-surface[data-edge="left"]');
//     await desk.press(dock, "#program-3 button");
//     await desk.finish({ what: "was seen" });
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launch } from "./launch.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a shell command in the VM, as its console's administrator. */
export const guest = (command) => execFileSync(new URL("../guest.sh", import.meta.url).pathname, [command], { encoding: "utf8" });

/** `who` signs in: alice, an ordinary user, unless another is named. */
export async function session(port, who = { user: "alice", password: "alice-dev-password" }) {
    const chrome = spawn("chromium", ["--headless", "--disable-gpu", "--hide-scrollbars",
        "--blink-settings=preferredColorScheme=0", "--window-size=1200,800",
        `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
    const browser = (path, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method }).then((r) => r.json());

    async function attach(target) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        let next = 1;
        const waiting = new Map();
        const log = [];
        ws.onmessage = (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id) waiting.get(msg.id)?.(msg);
            else if (msg.method === "Log.entryAdded") log.push(msg.params.entry.text);
            else if (msg.method === "Runtime.consoleAPICalled") log.push(msg.params.args.map((a) => a.value).join(" "));
            else if (msg.method === "Runtime.exceptionThrown") log.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
        };
        // A frame that has gone answers nothing, and is not waited for.
        const send = (method, params = {}) => new Promise((r) => {
            const id = next++;
            waiting.set(id, r);
            setTimeout(() => r({ error: { message: `no answer to ${method}` }, result: {} }), 15000);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, method, params }));
            else r({ error: { message: "gone" }, result: {} });
        });
        await send("Log.enable");
        await send("Runtime.enable");
        const js = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.result?.value;
        return { id: target.id, url: target.url, send, js, log };
    }

    for (let i = 0; i < 40; i++) {
        await sleep(500);
        try { await browser("/json"); break; } catch {}
    }
    const version = await browser("/json/version");
    const whole = await attach({ webSocketDebuggerUrl: version.webSocketDebuggerUrl, id: "browser" }).catch(() => null);
    const a = await attach(await browser("/json/new?http://127.0.0.1:7780/", "PUT"));
    await sleep(1500);
    await a.js(`document.querySelector("#username").value = ${JSON.stringify(who.user)}; document.forms[0].submit()`);
    await sleep(2000);
    await a.js(`document.querySelector(".secret input").value = ${JSON.stringify(who.password)}; document.forms[0].submit()`);
    await sleep(4000);

    /** Every frame of the desktop's with something matching `has` in it. */
    async function frames(has) {
        const all = await Promise.all((await browser("/json")).filter((t) => t.type === "iframe" && t.parentId === a.id).map(attach));
        const found = [];
        for (const one of all) if (await one.js(`!!document.querySelector(${JSON.stringify(has)})`)) found.push(one);
        return found;
    }

    /** Where a frame is on the desktop's page. A frame's page cannot say
        where it is and the desktop's cannot see into it, and the address
        changes on the way in, so whoever asked for the frame says which
        surface it is in, as the desktop's page would find it. */
    async function place(frame) {
        return a.js(`(() => {
            const r = document.querySelector(${JSON.stringify(frame.surface)})?.querySelector("iframe")?.getBoundingClientRect();
            return r ? { x: r.left, y: r.top } : null;
        })()`);
    }

    /** The middle of what `selector` finds in `frame`, as the desktop's page measures. */
    async function middle(frame, selector) {
        const [origin, within] = [await place(frame), await frame.js(`(() => {
            const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
            return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        })()`)];
        return origin && within ? { x: origin.x + within.x, y: origin.y + within.y } : null;
    }

    const mouse = (type, at, more = {}) => a.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...more });

    /** A real press and release at a point of the desktop's page. */
    async function pressAt(at) {
        await mouse("mousePressed", at);
        await mouse("mouseReleased", at);
        await sleep(400);
    }

    return {
        a,
        whole,
        frames,
        /** The first frame with `has` in it, which is in the surface `surface` finds on the desktop's page. */
        frame: async (has, surface) => {
            const found = (await frames(has))[0] ?? null;
            if (found) found.surface = surface;
            return found;
        },
        middle,
        pressAt,
        /** The pointer moved over a point of the desktop's page, no button down. */
        hoverAt: async (at) => {
            await mouse("mouseMoved", at, { button: "none", buttons: 0 });
            await sleep(400);
        },
        /** A real press on what `selector` finds in `frame`. */
        press: async (frame, selector) => {
            const at = await middle(frame, selector);
            if (at) await pressAt(at);
            return Boolean(at);
        },
        /** A real double press on what `selector` finds in `frame`: the
            second press counts two, which is what makes a dblclick. */
        doublePress: async (frame, selector) => {
            const at = await middle(frame, selector);
            if (!at) return false;
            await mouse("mousePressed", at);
            await mouse("mouseReleased", at);
            await mouse("mousePressed", at, { clickCount: 2 });
            await mouse("mouseReleased", at, { clickCount: 2 });
            await sleep(400);
            return true;
        },
        /** A real drag from one point of the desktop's page to another, in steps. */
        drag: async (from, to, steps = 12) => {
            await mouse("mouseMoved", from, { buttons: 0 });
            await mouse("mousePressed", from);
            for (let i = 1; i <= steps; i++) {
                await mouse("mouseMoved", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
                await sleep(30);
            }
            return async () => {
                await mouse("mouseReleased", to);
                await sleep(600);
            };
        },
        /** A secondary press on what `selector` finds in `frame`, in the middle of it. */
        menuOn: (frame, selector) => frame.js(`(() => {
            const at = document.querySelector(${JSON.stringify(selector)});
            if (!at) return "no such element";
            const r = at.getBoundingClientRect();
            at.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }));
            return "asked";
        })()`).then(async (said) => { await sleep(400); return said; }),
        /** The labels of the menu in sight, with a line for a separator, or null. */
        menu: () => a.js(`(() => {
            const menu = document.querySelector(".fx-menu");
            return menu ? [...menu.querySelectorAll("li")].map((li) => li.getAttribute("role") === "separator" ? "—" : li.textContent) : null;
        })()`),
        /** A real press on the item of the menu in sight that says `label`. */
        choose: async (label) => {
            const at = await a.js(`(() => {
                const b = [...document.querySelectorAll(".fx-menu button")].find((b) => b.textContent === ${JSON.stringify(label)});
                const r = b?.getBoundingClientRect();
                return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
            })()`);
            if (at) await pressAt(at);
            await sleep(600);
            return Boolean(at);
        },
        key: async (key, more = {}, text) => {
            const params = { key, code: more.code ?? key, windowsVirtualKeyCode: more.vk ?? { Enter: 13, Escape: 27, F2: 113, Delete: 46 }[key] ?? 0, modifiers: more.modifiers ?? 0 };
            await a.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...params, ...(text ? { text } : {}) });
            await a.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
            await sleep(400);
        },
        /** Types `text` wherever the keyboard is. */
        type: async (text) => {
            await a.send("Input.insertText", { text });
            await sleep(500);
        },
        launch: async (typed) => {
            await launch(a.send, typed);
            await sleep(3500);
        },
        picture: async (name) => writeFileSync(new URL(name, import.meta.url), Buffer.from((await a.send("Page.captureScreenshot")).result.data, "base64")),
        /** Which surface has the focus, which are in sight, and the workspace shown. */
        desk: () => a.js(`({
            focused: Number(document.querySelector('.fx-surface[data-focused="true"]')?.dataset.id ?? 0),
            inSight: [...document.querySelectorAll('.fx-surface[data-role="window"]')].filter((s) => !s.hidden).map((s) => Number(s.dataset.id)),
            windows: [...document.querySelectorAll('.fx-surface[data-role="window"]')].map((s) => Number(s.dataset.id)),
        })`),
        /** Closes this browser and leaves the script running, for a check that drives two people. */
        close: () => chrome.kill(),
        finish: async (out, code = 0) => {
            out.desktopLog = a.log;
            await a.js(`fetch("/.fenestra/logoff", { method: "POST" }).then(() => 0, () => 0)`);
            await sleep(1500);
            console.log(JSON.stringify(out, null, 1));
            chrome.kill();
            process.exit(code);
        },
    };
}
