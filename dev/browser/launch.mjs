// Starts a program the way a person does: sends for Fenestra's launcher, types,
// and presses Enter. The keys go wherever the keyboard is, which is the point:
// the launcher's chord is the desktop's from anywhere.
//
// The dev VM declares the test app in the catalogue as "Hello", so "hello"
// finds it and nothing else, and "hello --raw" starts it with a page of its
// own.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `send` is a debugger connection's, to the desktop's page. */
export async function launch(send, typed = "hello") {
    const key = async (params, text) => {
        await send("Input.dispatchKeyEvent", {
            type: text ? "keyDown" : "rawKeyDown",
            ...params,
            ...(text ? { text } : {}),
        });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    };
    await key({ key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 2 });
    await sleep(600);
    for (const letter of typed) {
        const code = /[a-z]/i.test(letter)
            ? `Key${letter.toUpperCase()}`
            : ({ " ": "Space", "-": "Minus" }[letter] ?? "");
        await key(
            {
                key: letter,
                code,
                windowsVirtualKeyCode: letter === "-" ? 189 : letter.toUpperCase().charCodeAt(0),
            },
            letter,
        );
    }
    // What is typed is held back a moment before the process is told.
    await sleep(600);
    await key({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}
