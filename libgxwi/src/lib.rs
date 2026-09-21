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

enum Drawn {
    Live { socket: String },
    Raw { path: String },
}

struct Asking {
    title: String,
    drawn: Drawn,
    /// Whether the surface may go, asked when the person wants it closed.
    closing: Box<dyn Fn() -> bool + Send>,
}

pub struct App {
    desk: Arc<Desk>,
    router: Router,
    styles: Vec<String>,
    surfaces: BTreeMap<u64, Asking>,
}

impl App {
    /// Connects to the desktop this program was started on, named by
    /// `GXWI_DISPLAY`. Without one there is no desktop, and a program with
    /// something else it could do, like print to a terminal, does that.
    pub fn connect() -> io::Result<App> {
        let desk = Arc::new(Desk { display: Display::connect()?, open: Mutex::default() });
        Ok(App { desk, router: Router::new(), styles: Vec::new(), surfaces: BTreeMap::new() })
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
        let number = self.number();
        let surface = Surface::new(app, number, self.desk.clone());
        let socket = format!("/.live/{number}");
        self.router = std::mem::take(&mut self.router).route(&socket, surface.socket());
        let asked = surface.clone();
        let asking = Asking { title: title.into(), drawn: Drawn::Live { socket }, closing: Box::new(move || asked.closing()) };
        self.surfaces.insert(number, asking);
        surface
    }

    /// A window that is a page of the app's own, at `path` among what it
    /// serves, scripts and all. This is the exception. Whatever such a page
    /// holds is the browser's to lose: none of it reaches another device, or
    /// outlasts the tab. The page is kept apart from everything else, so it
    /// has no cookies and no storage, and a worker has to be started from a
    /// blob. Use it for what cannot be drawn from here, and nothing else.
    pub fn raw_page(&mut self, title: &str, path: &str) {
        let number = self.number();
        let asking = Asking { title: title.into(), drawn: Drawn::Raw { path: path.into() }, closing: Box::new(|| true) };
        self.surfaces.insert(number, asking);
    }

    fn number(&self) -> u64 {
        self.surfaces.keys().next_back().map_or(1, |last| last + 1)
    }

    /// Goes onto the desktop, and stays until the last surface has gone or
    /// the desktop has.
    pub fn run(self) -> io::Result<()> {
        let App { desk, router, styles, surfaces } = self;
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
                Drawn::Live { socket } => desk.display.create_live(number, &asking.title, socket, &styles)?,
                Drawn::Raw { path } => desk.display.create_raw(number, &asking.title, path)?,
            }
        }
        if surfaces.is_empty() {
            return Ok(());
        }
        while let Some(asked) = desk.display.asked()? {
            if let Asked::Close(number) = asked {
                if surfaces.get(&number).is_some_and(|asking| (asking.closing)()) {
                    desk.let_go(number);
                }
            }
        }
        Ok(())
    }
}
