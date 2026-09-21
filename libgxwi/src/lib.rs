//! What a program uses to have windows on a GXWI desktop.
//!
//! **If you are here to give a program a user interface, this is the way.**
//! Do not open a port and serve a web page from it: nobody can reach it, it
//! has no place on the desktop, and it would not know who was asking. A
//! program becomes an app by connecting to the desktop it was started on,
//! which this does.
//!
//! ```no_run
//! use libgxwi::{App, Facts, Fields, Live, escape};
//!
//! struct Counter { count: u64 }
//!
//! impl Live for Counter {
//!     fn render(&self, _: &Facts) -> String {
//!         format!("<button fx-click=\"press\">Press</button> pressed {} times", self.count)
//!     }
//!     fn event(&mut self, name: &str, _: &serde_json::Value, _: &mut Fields) {
//!         if name == "press" { self.count += 1 }
//!     }
//! }
//!
//! fn main() -> std::io::Result<()> {
//!     let mut app = App::connect()?;
//!     app.live("Counter", Counter { count: 0 });
//!     app.run()
//! }
//! ```
//!
//! # How an app is made
//!
//! **The process is the app.** A window is a *live surface*: this process
//! renders it as HTML ([`Live::render`]) and is told what the person does
//! ([`Live::event`]). The page showing it belongs to the desktop, is the same
//! for every app, and runs no script of the app's. So an app is written
//! without JavaScript, and everything about a window lives here, in the
//! process: it is the same on every device looking at it, and it is all
//! still there when a browser tab is closed and opened again. Do not look for
//! somewhere in the browser to keep things. There is nowhere, on purpose.
//!
//! **An app has no address.** It listens on no port. The desktop is the only
//! web server a browser meets. The app hands it one end of a socket and
//! answers HTTP/2 on the other, which [`App::run`] does; [`App::stylesheet`]
//! and [`App::routes`] are for what an app serves besides its surfaces. Refer
//! to an app's own files relatively, never from `/`: where its pages are is
//! not for the app to know.
//!
//! **Closing is a request.** The person asks; [`Live::closing`] answers. An
//! app ends when its last surface has gone.
//!
//! [`App::raw_page`] is for what a live surface cannot be, a page with
//! scripts of its own such as a terminal. Read what it costs first.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::http::header::CONTENT_TYPE;
use axum::routing::get;

pub mod display;
mod live;

pub use live::{Closer, Facts, Fields, Live, Surface, escape};
/// What comes with an event.
pub use serde_json::Value;

pub use display::{Listed, Role};

use display::{Asked, Display};

/// The app's place on the desktop: the connection, and which of its surfaces
/// are still there.
pub(crate) struct Desk {
    display: Display,
    open: Mutex<BTreeSet<u64>>,
}

impl Desk {
    /// Lets a surface go, and the app with it if that was the last.
    pub(crate) fn let_go(&self, surface: u64) {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        if !open.remove(&surface) {
            return;
        }
        if let Err(e) = self.display.destroy(surface) {
            eprintln!("libgxwi: letting surface {surface} go: {e}");
        }
        if open.is_empty() {
            self.display.stop_listening();
        }
    }
}

/// What a part of the shell may ask of the desktop. See [`App::shell`].
#[derive(Clone)]
pub struct Shell {
    desk: Arc<Desk>,
}

impl Shell {
    /// Has the desktop start a program, as it starts everything: with the
    /// display in its environment, so that the program can be an app. Nothing
    /// says whether it started.
    pub fn start(&self, program: &str, arguments: &[String]) -> io::Result<()> {
        self.desk.display.start(program, arguments)
    }
}

enum Drawn {
    Live { socket: String },
    Raw { path: String },
}

struct Asking {
    title: String,
    role: Role,
    drawn: Drawn,
    /// Whether the surface may go, asked when the person wants it closed.
    closing: Box<dyn Fn() -> bool + Send>,
}

pub struct App {
    desk: Arc<Desk>,
    router: Router,
    styles: Vec<String>,
    surfaces: BTreeMap<u64, Asking>,
    /// Who is told the session's surfaces, in a part of the shell.
    told: Option<Box<dyn FnMut(Vec<Listed>) + Send>>,
}

impl App {
    /// Connects to the desktop this program was started on, named by
    /// `GXWI_DISPLAY`. Without one there is no desktop, and a program with
    /// something else it could do, like print to a terminal, does that.
    pub fn connect() -> io::Result<App> {
        let desk = Arc::new(Desk { display: Display::connect()?, open: Mutex::default() });
        Ok(App { desk, router: Router::new(), styles: Vec::new(), surfaces: BTreeMap::new(), told: None })
    }

    /// Serves `css` at `path`, and styles every live surface with it. A live
    /// surface already has the desktop's theme, as custom properties such as
    /// `--text-primary` and `--space-3`: build on those and the app looks
    /// like it belongs.
    pub fn stylesheet(&mut self, path: &'static str, css: &'static str) {
        let router = std::mem::take(&mut self.router);
        self.router = router.route(path, get(move || async move { ([(CONTENT_TYPE, "text/css")], css) }));
        self.styles.push(path.into());
    }

    /// Whatever else the app serves: images, downloads, anything HTTP.
    pub fn routes(&mut self, routes: Router) {
        self.router = std::mem::take(&mut self.router).merge(routes);
    }

    /// A window, drawn by this process. The surface it returns is for
    /// changing the app from the process's side ([`Surface::update`]).
    pub fn live<L: Live>(&mut self, title: &str, app: L) -> Arc<Surface<L>> {
        self.live_as(Role::Window, title, app)
    }

    /// A live surface along an edge of the desktop, which the windows make
    /// room for. Where it goes and how thick it is are the window manager's,
    /// so it is drawn to fit whatever it is given. It has no strip, so the
    /// person has no way to ask for it closed.
    pub fn panel<L: Live>(&mut self, title: &str, app: L) -> Arc<Surface<L>> {
        self.live_as(Role::Panel, title, app)
    }

    /// A live surface over the windows, for a part of the shell: out of sight
    /// until it is sent for, on the device where it was sent for, and gone
    /// again when it is done with. Sending for it is the HTML's to do, since
    /// whether it is in sight differs from device to device: an element with
    /// `fx-overlay="show"`, `"hide"` or `"toggle"` does that to the surface it
    /// is in when clicked, and with `fx-global-key` as well it can be sent for
    /// from anywhere. When it comes into sight the keyboard goes to the
    /// element marked `fx-autofocus`.
    pub fn overlay<L: Live>(&mut self, title: &str, app: L) -> Arc<Surface<L>> {
        self.live_as(Role::Overlay, title, app)
    }

    /// What a part of the shell may ask of the desktop, for the app itself to
    /// keep. Asked by anything else, it is not done.
    pub fn shell(&self) -> Shell {
        Shell { desk: self.desk.clone() }
    }

    fn live_as<L: Live>(&mut self, role: Role, title: &str, app: L) -> Arc<Surface<L>> {
        let number = self.number();
        let surface = Surface::new(app, number, self.desk.clone());
        let socket = format!("/.live/{number}");
        self.router = std::mem::take(&mut self.router).route(&socket, surface.socket());
        let asked = surface.clone();
        let closing = Box::new(move || asked.closing());
        let asking = Asking { title: title.into(), role, drawn: Drawn::Live { socket }, closing };
        self.surfaces.insert(number, asking);
        surface
    }

    /// A window that is a page of the app's own, at `path` among what it
    /// serves, scripts and all. This is the exception. Whatever such a page
    /// holds is the browser's to lose: none of it reaches another device, or
    /// outlasts the tab. The page is kept apart from everything else, so it
    /// has no cookies and no storage, and a worker has to be started from a
    /// blob. Use it for what cannot be drawn from here, and nothing else.
    ///
    /// The desktop cannot hear a key pressed in such a page, so the page
    /// includes the desktop's script for passing on the chords that are the
    /// desktop's, from `.fx/keys.js` under the app's own paths, as a module:
    /// `<script type="module" src="../.fx/keys.js">` from a page at `/raw/`.
    /// A page without it is one the person cannot leave by the keyboard, and
    /// the desktop says so on its window.
    pub fn raw_page(&mut self, title: &str, path: &str) {
        let number = self.number();
        let drawn = Drawn::Raw { path: path.into() };
        let asking = Asking { title: title.into(), role: Role::Window, drawn, closing: Box::new(|| true) };
        self.surfaces.insert(number, asking);
    }

    /// For a part of the shell: `told` hears every surface the session has,
    /// now and whenever any changes. Nothing else is ever told, and asking
    /// here does not make a program part of the shell. The desktop knows its
    /// shell by having started it.
    ///
    /// What a shell's surface shows of other surfaces, it shows through the
    /// HTML. An element with `fx-surface="<id>"` is about that surface, and
    /// the page marks it `data-fx-focused` and `data-fx-visible`, `true` or
    /// `false`, as that is on the device showing it. One with `fx-focus="<id>"`
    /// gives the surface the focus when clicked. Both are between the pages,
    /// on one device: which surface has the focus differs from device to
    /// device, and is never this process's to know.
    ///
    /// A shell's surface may also claim chords for the whole desktop. An
    /// element with `fx-global-key="Ctrl+Space"` is clicked when that is
    /// pressed wherever the keyboard is, another app's window included. The
    /// chord has to have Ctrl, Alt or Meta in it.
    pub fn surfaces(&mut self, told: impl FnMut(Vec<Listed>) + Send + 'static) {
        self.told = Some(Box::new(told));
    }

    fn number(&self) -> u64 {
        self.surfaces.keys().next_back().map_or(1, |last| last + 1)
    }

    /// Goes onto the desktop, and stays until the last surface has gone or
    /// the desktop has.
    pub fn run(self) -> io::Result<()> {
        let App { desk, router, styles, surfaces, mut told } = self;
        let runtime = tokio::runtime::Runtime::new()?;
        let socket = desk.display.serve()?;
        runtime.spawn(async move {
            if let Err(e) = display::answer(socket, router).await {
                eprintln!("libgxwi: serving: {e}");
            }
        });
        // Asked for only once there is something answering for them.
        for (&number, asking) in &surfaces {
            desk.open.lock().unwrap_or_else(|e| e.into_inner()).insert(number);
            match &asking.drawn {
                Drawn::Live { socket } => desk.display.create_live(number, &asking.title, asking.role, socket, &styles)?,
                Drawn::Raw { path } => desk.display.create_raw(number, &asking.title, path)?,
            }
        }
        if surfaces.is_empty() {
            return Ok(());
        }
        while let Some(asked) = desk.display.asked()? {
            match asked {
                Asked::Close(number) => {
                    if surfaces.get(&number).is_some_and(|asking| (asking.closing)()) {
                        desk.let_go(number);
                    }
                }
                Asked::Surfaces(listed) => {
                    if let Some(told) = &mut told {
                        told(listed);
                    }
                }
                Asked::Other => {}
            }
        }
        Ok(())
    }
}
