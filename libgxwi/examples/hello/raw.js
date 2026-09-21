// What a page kept apart the way an app's is can and cannot do, found out by
// trying. The process is told, so that it can be read from outside the frame.

// Whatever `what` does, now or later, comes back as words and never as an
// exception: some of these refuse the moment they are touched.
const attempt = (what) => Promise.resolve().then(what).catch((e) => `refused: ${e?.name ?? e}`);
const worker = (url) =>
    new Promise((resolve, reject) => {
        const made = new Worker(url);
        made.onmessage = (message) => resolve(`works: ${message.data}`);
        made.onerror = () => reject(new Error("the worker did not start"));
        setTimeout(() => reject(new Error("nothing heard from the worker")), 2000);
    });

const found = {
    origin: location.origin,
    localStorage: await attempt(() => (localStorage.setItem("probe", "1"), "works")),
    cookies: await attempt(() => ((document.cookie = "probe=1"), document.cookie ? "works" : "kept nothing")),
    indexedDB: await attempt(() => (indexedDB.open("probe"), "works")),
    serviceWorker: await attempt(() => navigator.serviceWorker.register("worker.js").then(() => "works")),
    fetch: await attempt(() => fetch("ping").then((answer) => `works: ${answer.status}`)),
    fetchAskingFirst: await attempt(() =>
        fetch("ping", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((answer) => `works: ${answer.status}`),
    ),
    workerByAddress: await attempt(() => worker("worker.js")),
    workerByBlob: await attempt(() => fetch("worker.js").then((answer) => answer.blob()).then((blob) => worker(URL.createObjectURL(blob)))),
    pushState: await attempt(() => {
        const before = location.href;
        history.pushState({}, "", "somewhere-else");
        const moved = location.pathname.endsWith("/somewhere-else");
        history.replaceState({}, "", before);
        return moved ? "works" : "did nothing";
    }),
    readingTheDesktop: await attempt(() => (parent.document.title, "NOT REFUSED")),
    navigatingTheDesktop: await attempt(() => ((top.location = "about:blank#taken-over-by-an-app"), "NOT REFUSED")),
};
document.getElementById("found").textContent = Object.entries(found).map(([what, how]) => `${what.padEnd(22)}${how}`).join("\n");
fetch("found", { method: "POST", body: JSON.stringify(found) });
