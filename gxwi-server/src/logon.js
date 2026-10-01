// The only script the logon pages run, and they work without it. The policy
// they are served under names these exact bytes by hash; change one and the
// test beside the hash says what it has become.
//
// It does two things: the button that shows a password, and the stars behind
// the page.
for (const button of document.querySelectorAll("button.reveal")) {
    const field = button.previousElementSibling;
    const show = (on) => {
        field.type = on ? "text" : "password";
        button.setAttribute("aria-pressed", String(on));
    };
    button.hidden = false;
    button.addEventListener("click", () => {
        show(field.type === "password");
        field.focus();
    });
    // A browser remembers what is typed into text fields. Not this.
    field.form.addEventListener("submit", () => show(false));
}

// The stars, as the installer and first-boot setup draw theirs: a slow drift
// that answers the pointer a little, a few near ones catching the light now
// and then.
//
// Each logon page is a page of its own, so the field would start afresh at
// every step. Instead, as a page goes, it leaves the field as it stands in
// this tab's session storage, and the next page takes it up where it was, the
// glows behind it too: the stars carry on across the step as if nothing had
// been loaded. A page of this origin that is not GXWI's can leave its own
// there in the same shape (an overlay going, as setup does as it finishes),
// and ask for the page to arrive rather than simply be there. What is found
// there is only read as numbers, and drawn: nothing in it is run or put in
// the page.
(() => {
    const canvas = document.getElementById("field");
    const ctx = canvas && canvas.getContext && canvas.getContext("2d");
    if (!ctx) return;
    const KEY = "gxwi.field";
    // A field older than this is not the one the page before was showing.
    const FRESH = 15000;
    const MAX = 4000;
    // The installer's colours, by the index a field left behind names them by.
    const PALETTE = [["#62d2ff", .55], ["#c8f1ff", .25], ["#9d8cff", .12], ["#4fd1c5", .08]];
    // Seven numbers a star: where it is, how near (0 to 1), its phase, its
    // colour, whether it catches the light, and how bright it is.
    const EACH = 7;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const glows = [...document.querySelectorAll(".aurora i")];

    let W = 0, H = 0;
    let stars = [];
    let mx = 0, my = 0, smx = 0, smy = 0;
    // The field's own clock, in ms: carried over with the stars, since how
    // they drift and when they glint go by it.
    let clock = 0, base = 0;

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = window.innerWidth;
        H = window.innerHeight;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const pick = () => {
        let r = Math.random();
        for (let i = 0; i < PALETTE.length; i++) if ((r -= PALETTE[i][1]) <= 0) return i;
        return 0;
    };
    const target = (z) => .1 + .5 * z * z;

    function star(x, y, z, ph, colour, glint, a) {
        return { x, y, z, ph, col: PALETTE[colour][0], colour, glint, a, vx: 0, vy: 0 };
    }

    // A field of its own, faded in from nothing.
    function seed() {
        const n = W * H < 480000 ? 1200 : 1900;
        stars = [];
        for (let i = 0; i < n; i++) {
            const z = Math.random();
            stars.push(star(Math.random() * W, Math.random() * H, z, Math.random() * Math.PI * 2, pick(),
                z > .55 && Math.random() < .0125, reduced ? target(z) : 0));
        }
        clock = 0;
    }

    // The field the page before left, if there is one fit to take up. It
    // was drawn in a window perhaps not quite this size, and is stretched to
    // this one.
    function taken() {
        let left;
        try {
            left = JSON.parse(sessionStorage.getItem(KEY));
            sessionStorage.removeItem(KEY);
        } catch {
            return false;
        }
        if (!left || left.v !== 1) return false;
        const age = Date.now() - left.at;
        const { w, h, t, glows: phases, rise } = left;
        const flat = left.stars;
        if (!(age >= 0 && age < FRESH) || !(w > 0 && h > 0) || !Number.isFinite(t) || !Array.isArray(flat)
            || flat.length % EACH || flat.length / EACH > MAX) return false;
        const sx = W / w, sy = H / h, next = [];
        for (let i = 0; i < flat.length; i += EACH) {
            const [x, y, z, ph, colour, glint, a] = flat.slice(i, i + EACH);
            if (![x, y, z, ph, a].every(Number.isFinite) || !(z >= 0 && z <= 1) || !(a >= 0 && a <= 1)
                || !PALETTE[colour]) return false;
            next.push(star(x * sx, y * sy, z, ph, colour, glint === 1, a));
        }
        stars = next;
        clock = t + age;
        // The glows, where they had drifted to.
        if (Array.isArray(phases)) {
            glows.forEach((glow, i) => {
                if (Number.isFinite(phases[i])) glow.style.animationDelay = `${-Math.round(phases[i])}ms`;
            });
        }
        if (rise === true) document.documentElement.classList.add("arriving");
        return true;
    }

    /** The field as it stands, for the next page. */
    function leave() {
        const flat = [];
        for (const p of stars) {
            const [x, y] = drawnAt(p);
            flat.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p.z * 1000) / 1000,
                Math.round(p.ph * 1000) / 1000, p.colour, p.glint ? 1 : 0, Math.round(p.a * 1000) / 1000);
        }
        // How far into its drift each glow is, counting the start it was
        // given here.
        const phases = glows.map((glow) => {
            const running = glow.getAnimations ? glow.getAnimations().find((a) => a.animationName) : null;
            return running ? (Number(running.currentTime) || 0) - (running.effect.getTiming().delay || 0) : 0;
        });
        try {
            sessionStorage.setItem(KEY, JSON.stringify({ v: 1, at: Date.now(), w: W, h: H, t: now(), glows: phases, stars: flat }));
        } catch { /* no storage: the next page starts a field of its own */ }
    }

    const now = () => clock + (performance.now() - base);

    // Where a star is drawn: where it is, moved a little by the pointer.
    const drawnAt = (p) => [p.x + smx * p.z * 22, p.y + smy * p.z * 22];

    function drift(p, t) {
        const dvx = Math.cos(p.ph + t * .00013) * .14 * (.3 + p.z);
        const dvy = Math.sin(p.ph * 1.3 + t * .00011) * .1 * (.3 + p.z) - .04 * p.z;
        p.vx += (dvx - p.vx) * .025;
        p.vy += (dvy - p.vy) * .025;
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -30) p.x += W + 60; else if (p.x > W + 30) p.x -= W + 60;
        if (p.y < -30) p.y += H + 60; else if (p.y > H + 30) p.y -= H + 60;
    }

    // A four-point sparkle, brightest for a moment every few seconds.
    function glint(p, x, y, t) {
        const g = Math.pow(Math.max(0, Math.sin(t * .0011 + p.ph * 5)), 14);
        if (g < .02) return;
        const L = 1.5 + g * (5 + p.z * 7);
        ctx.globalAlpha = g * .95;
        ctx.fillStyle = "#e8fbff";
        ctx.fillRect(x - L, y - .5, L * 2, 1);
        ctx.fillRect(x - .5, y - L, 1, L * 2);
        ctx.globalAlpha = g * .5;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }

    function draw() {
        const t = now();
        smx += (mx - smx) * .04;
        smy += (my - smy) * .04;
        ctx.clearRect(0, 0, W, H);
        ctx.globalCompositeOperation = "lighter";
        for (const p of stars) {
            if (!reduced) drift(p, t);
            p.a += (target(p.z) - p.a) * .03;
            const [x, y] = drawnAt(p);
            const s = .7 + p.z * 1.5;
            ctx.globalAlpha = p.a;
            ctx.fillStyle = p.col;
            ctx.fillRect(x - s / 2, y - s / 2, s, s);
            if (p.glint && !reduced) glint(p, x, y, t);
        }
        ctx.globalAlpha = 1;
    }

    function frame() {
        draw();
        requestAnimationFrame(frame);
    }

    resize();
    base = performance.now();
    if (!taken()) seed();
    // The first frame now, so that the page is first seen with its stars.
    draw();
    if (!reduced) requestAnimationFrame(frame);
    window.addEventListener("resize", () => {
        const [w, h] = [W, H];
        resize();
        for (const p of stars) {
            p.x *= W / w;
            p.y *= H / h;
        }
        if (reduced) draw();
    });
    window.addEventListener("pointermove", (e) => {
        mx = (e.clientX / W - .5) * 2;
        my = (e.clientY / H - .5) * 2;
    });
    window.addEventListener("pagehide", leave);
})();
