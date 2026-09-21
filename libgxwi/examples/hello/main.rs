//! A small app: one window, which greets whoever is looking, counts presses
//! of a button and keeps a note. It is what compositors are tried with, and
//! the shortest honest answer to "how do I write an app".
//!
//! Everything about the window is in this process. The count, and the note
//! half typed, are the same on every device looking at it, and are still
//! there after every one of them has gone away and come back.
//!
//! Anything after the program's name is said in place of the greeting, except
//! `--raw`, which opens a page of the app's own instead: one that tries what
//! such a page can and cannot do, and reports it at `raw/found`.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::routing::get;
use libgxwi::{App, Facts, Fields, Live, Value, escape};
use serde_json::json;

struct Hello {
    greeting: String,
    count: u64,
}

impl Live for Hello {
    fn render(&self, facts: &Facts) -> String {
        format!(
            "<h1>{greeting}</h1>\n\
             <p><button fx-click=\"press\">Press</button> <span id=\"count\">pressed {count} times</span></p>\n\
             <p><label>Note <input name=\"note\" autocomplete=\"off\"></label> <button fx-click=\"clear\">Clear</button></p>\n\
             <p id=\"facts\">process {pid}, showing in {views} places</p>\n",
            greeting = escape(&self.greeting),
            count = self.count,
            pid = std::process::id(),
            views = facts.views,
        )
    }

    fn event(&mut self, name: &str, _value: &Value, fields: &mut Fields) {
        match name {
            "press" => self.count += 1,
            "clear" => fields.set("note", ""),
            _ => {}
        }
    }
}

fn main() {
    let mut said: Vec<String> = std::env::args().skip(1).collect();
    let raw = said.first().is_some_and(|first| first == "--raw");
    if raw {
        said.remove(0);
    }
    let greeting = if said.is_empty() { "Hello, World".to_string() } else { said.join(" ") };

    let mut app = App::connect().unwrap_or_else(|e| die(&format!("the display: {e}")));
    app.stylesheet("/style.css", include_str!("style.css"));
    if raw {
        app.routes(raw_page());
        app.raw_page("Hello, by its own page", "/raw/");
    } else {
        let surface = app.live("Hello", Hello { greeting, count: 0 });
        // For whoever is checking from outside the frame, which cannot be seen into.
        app.routes(Router::new().route(
            "/state",
            get(move || async move {
                let state = surface.look(|hello, fields, facts| {
                    json!({ "count": hello.count, "note": fields.get("note"), "views": facts.views })
                });
                ([(CONTENT_TYPE, "application/json")], state.to_string())
            }),
        ));
    }
    app.run().unwrap_or_else(|e| die(&format!("the display: {e}")));
}

/// A page of the app's own, which finds out what a page kept apart the way
/// an app's is can and cannot do, and says so here so it can be read from
/// outside the frame.
fn raw_page() -> Router {
    let file = |kind: &'static str, body: &'static str| get(move || async move { ([(CONTENT_TYPE, kind)], body) });
    let found = Arc::new(Mutex::new(Value::Null));
    Router::new()
        .route("/raw/", file("text/html; charset=utf-8", include_str!("raw.html")))
        .route("/raw/raw.js", file("text/javascript", include_str!("raw.js")))
        .route("/raw/worker.js", file("text/javascript", include_str!("worker.js")))
        .route("/raw/ping", get(|| async { "pong" }).post(|| async { "pong" }))
        .route(
            "/raw/found",
            get(|State(found): State<Arc<Mutex<Value>>>| async move {
                let found = found.lock().unwrap_or_else(|e| e.into_inner()).clone();
                ([(CONTENT_TYPE, "application/json")], found.to_string())
            })
            .post(|State(found): State<Arc<Mutex<Value>>>, body: String| async move {
                *found.lock().unwrap_or_else(|e| e.into_inner()) = serde_json::from_str(&body).unwrap_or_default();
            }),
        )
        .with_state(found)
}

fn die(message: &str) -> ! {
    eprintln!("hello: {message}");
    std::process::exit(1);
}
