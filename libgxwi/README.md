# libgxwi

What a program uses to have windows on a GXWI desktop.

If you are adding a user interface to a Peios program, this is how. Do not open
a port and serve a web page from it. Nobody can reach it, it has no place on the
desktop, and it would not know who was asking. A program becomes an app by
connecting to the desktop it was started on, named in `GXWI_DISPLAY`, and this
crate does that.

An app is written without JavaScript. Its process renders each window as HTML
and is told what the person does. The page that shows a window belongs to the
desktop and runs no script of the app's. Everything about a window therefore
lives in the process: it is the same on every device looking at it, and it is
still there after a browser tab is closed and opened again. There is nowhere in
the browser to keep anything, on purpose.

The crate's documentation (`src/lib.rs`) says how, in a page. `examples/hello` is
a whole app in about forty lines, and is what compositors are tried with:

    cargo build --release -p libgxwi --example hello

`display` is the wire to the compositor and `live` the wire to a window's page,
each set out at the top of its file.
