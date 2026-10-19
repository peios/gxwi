//! A live surface, from the process's side: the state of one surface, the
//! pages looking at it, and the wire between them.
//!
//! The state belongs to the surface and not to any page. Pages come and go,
//! on whatever devices. Each is shown the surface as it stands and then every
//! change, and none of them is needed for the surface to carry on.
//!
//! THE WIRE is a websocket from the compositor's page to this process,
//! carrying JSON.
//!
//!   process → page   { type: "hello", view }           which page this is
//!                    { type: "render", html, inputs }  the whole surface, and
//!                                                      what its fields hold:
//!                                                      { name: { value, by } }
//!   page → process   { type: "event", name, value, form? }
//!                    { type: "input", name, value }

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::routing::{MethodRouter, any};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::Desk;

/// What an app is, for one live surface.
///
/// The HTML names what the person can do: an element with `fx-click="press"`
/// sends the event `press` when it is clicked, with its `fx-value-*`
/// attributes as the value, `fx-dblclick` does the same for a double click,
/// and a form with `fx-submit` sends its fields as well. Nothing else in the
/// HTML does anything. No script in it runs.
///
/// A grid whose columns the person may widen or narrow is an element with an
/// id and `fx-columns="16px minmax(0, 1fr) 140px"`, whose rows are styled
/// with `grid-template-columns: var(--fx-columns)`: the page sets that from
/// the attribute and changes it as the edges between the cells of the first
/// row are dragged. The widths depend on the screen, so they are the
/// device's and never reach the process.
///
/// Keys are named there too. An element with `fx-key="Ctrl+Enter"` is clicked
/// when that is pressed while the surface has the keyboard, and several
/// chords go in one attribute with spaces between. A chord is its modifiers,
/// as Ctrl, Alt, Shift and Meta, then the key: a letter or digit, or a name
/// such as `Enter`, `Escape`, `ArrowDown`, `Space` or `F5`. While the
/// keyboard is in a field, what would type or edit there (`P`, `Backspace`,
/// `ArrowLeft`, `Home`, `Ctrl+V`, `Ctrl+Z`) is the field's, and so is
/// `Enter` in a field of a form with `fx-submit`, which sends the form. Some chords are the desktop's
/// and never arrive: what they are is the desktop's to say, and the
/// person's to change ([`crate::shortcuts`]), and they all have Ctrl, Alt or
/// Meta in them.
///
/// The keyboard goes to an element marked `fx-autofocus` when a render
/// brings it where there was none, if the keyboard is in the surface
/// already, and what a field holds is selected: a field that appears because
/// the person asked for it is where they type next.
///
/// What the person may copy is named there. An element with `fx-copy="path"`
/// puts the value it has by that name, its `fx-value-path`, where the person
/// pastes from when it is clicked, on the device it was clicked on. The text
/// does not come by the process; an element that has `fx-click` as well
/// tells the process it was pressed.
///
/// A list the person may put in another order is an element with
/// `fx-reorder="moved"`, whose children marked `fx-drag` are dragged along
/// it, across or down as the list lies. Let go somewhere else among them,
/// the event `moved` comes with the list's `fx-value-*` attributes, the
/// dragged child's over them, and `to`: where among the `fx-drag` children
/// it now is, counted from `"0"`. The children want ids, and what is
/// rendered next says where each of them is, whatever the person did.
///
/// A menu is named there as well. An element with `fx-menu="tools"` names a
/// `<menu id="tools" hidden>` elsewhere in the HTML, whose descendants with
/// `fx-click` or `fx-copy` are its items in the order written, with an `<hr>` among them
/// as a separator and a `disabled` one shown but not to be chosen. A
/// secondary press on the element, a right-click, the Menu key, or a long
/// press, opens the menu, which the desktop draws over every surface; the
/// chosen item is clicked, with its `fx-value-*` attributes over the
/// element's, so one menu serves every row of a list and the row's values
/// come with the choice. A menu's labels cross to the desktop as text: an
/// item is what its text says and nothing more is drawn.
pub trait Live: Send + 'static {
    /// The surface as HTML. Called after anything that might have changed it.
    /// Text that came from anywhere goes through [`escape`].
    fn render(&self, facts: &Facts) -> String;

    /// The person did something the HTML gave a name to.
    fn event(&mut self, name: &str, value: &Value, fields: &mut Fields);

    /// The person changed the named field `name`, which `fields` already
    /// holds. The surface is rendered again whether or not this does
    /// anything. It is for what else has to change with a field, such as
    /// which of a list's matches is picked.
    fn input(&mut self, _name: &str, _fields: &mut Fields) {}

    /// The person asked for the surface to be closed. `true` lets it go.
    /// `false` keeps it, for an app with something to ask first: what it
    /// renders next can ask, and [`Surface::close`] lets go when it is time.
    fn closing(&mut self, _fields: &mut Fields) -> bool {
        true
    }
}

/// What the surface knows that the app did not tell it.
pub struct Facts<'a> {
    /// How many pages are showing the surface now.
    pub views: u64,
    /// What the surface's named fields hold.
    pub fields: &'a Fields,
}

/// What the surface's named fields hold. They are part of the surface and not
/// of a page, so what is typed is still there on another device, or later.
#[derive(Default)]
pub struct Fields(BTreeMap<String, Field>);

#[derive(Clone, Serialize)]
struct Field {
    value: String,
    /// The page that last set it, or 0 for the process. A page leaves alone
    /// what it sent itself while the person is still typing there.
    by: u64,
}

impl Fields {
    pub fn get(&self, name: &str) -> &str {
        self.0.get(name).map_or("", |field| &field.value)
    }

    /// Sets a field from the process's side, which every page obeys, the one
    /// the person is typing in included.
    pub fn set(&mut self, name: &str, value: &str) {
        self.0.insert(
            name.into(),
            Field {
                value: value.into(),
                by: 0,
            },
        );
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum FromPage {
    Event {
        name: String,
        #[serde(default)]
        value: Value,
    },
    Input {
        name: String,
        value: String,
    },
}

/// The most one field may hold, the most fields, and the most they may hold
/// between them: a page is not trusted to be the compositor's. A field is
/// let hold a file's worth of text, for an app that edits one.
pub const MAX_FIELD_BYTES: usize = 1024 * 1024;
const MAX_FIELDS: usize = 256;
const MAX_FIELD_NAME_BYTES: usize = 256;
const MAX_FIELDS_BYTES: usize = 4 * MAX_FIELD_BYTES;

pub struct Surface<L> {
    state: Mutex<(L, Fields)>,
    views: AtomicU64,
    pages: AtomicU64,
    /// Rung whenever the pages should be shown the surface again.
    changed: watch::Sender<()>,
    number: u64,
    desk: Arc<Desk>,
}

impl<L: Live> Surface<L> {
    pub(crate) fn new(app: L, number: u64, desk: Arc<Desk>) -> Arc<Surface<L>> {
        Arc::new(Surface {
            state: Mutex::new((app, Fields::default())),
            views: 0.into(),
            pages: 0.into(),
            changed: watch::channel(()).0,
            number,
            desk,
        })
    }

    /// Changes the app from the process's side, as when a timer fires or a
    /// file changes, and shows every page the result.
    pub fn update(&self, change: impl FnOnce(&mut L, &mut Fields)) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (app, fields) = &mut *state;
        change(app, fields);
        self.changed.send_replace(());
    }

    /// Looks at the app and its fields without changing them.
    pub fn look<T>(&self, at: impl FnOnce(&L, &Fields, &Facts) -> T) -> T {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        at(
            &state.0,
            &state.1,
            &Facts {
                views: self.views.load(Ordering::Relaxed),
                fields: &state.1,
            },
        )
    }

    /// Calls the surface something else than it was made as: what is on its
    /// window's strip, and what a shell lists it as. Nothing happens before
    /// the app is on the desktop ([`crate::App::run`]), where a surface is
    /// called what it was made as.
    pub fn retitle(&self, title: &str) {
        self.desk.retitle(self.number, title);
    }

    /// Lets the surface go. When an app's last surface goes, `App::run` ends.
    pub fn close(&self) {
        self.desk.let_go(self.number);
    }

    /// The app's own number for the surface, which is what the desktop's
    /// list of surfaces gives as [`crate::Listed::own`] for it.
    pub fn number(&self) -> u64 {
        self.number
    }

    /// Something that can let the surface go, for the app itself to keep: an
    /// app cannot hold its own surface, which holds it.
    pub fn closer(&self) -> Closer {
        Closer {
            number: self.number,
            desk: self.desk.clone(),
        }
    }

    pub(crate) fn closing(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (app, fields) = &mut *state;
        let go = app.closing(fields);
        self.changed.send_replace(());
        go
    }

    /// The websocket the compositor's page connects to.
    pub(crate) fn socket(self: &Arc<Self>) -> MethodRouter {
        let surface = self.clone();
        any(move |upgrade: WebSocketUpgrade| {
            let surface = surface.clone();
            async move { upgrade.on_upgrade(|socket| surface.show(socket)) }
        })
    }

    async fn show(self: Arc<Self>, mut socket: WebSocket) {
        let page = self.pages.fetch_add(1, Ordering::Relaxed) + 1;
        let mut changed = self.changed.subscribe();
        self.views.fetch_add(1, Ordering::Relaxed);
        self.changed.send_replace(());
        let hello = json!({ "type": "hello", "view": page }).to_string();
        let mut open = socket.send(Message::Text(hello.into())).await.is_ok();
        while open {
            // Whatever rang before now is in the render about to be made.
            changed.borrow_and_update();
            let render = self.look(|app, fields, facts| {
                json!({ "type": "render", "html": app.render(facts), "inputs": fields.0 })
                    .to_string()
            });
            if socket.send(Message::Text(render.into())).await.is_err() {
                break;
            }
            tokio::select! {
                _ = changed.changed() => {}
                message = socket.recv() => match message {
                    Some(Ok(Message::Text(text))) => self.hear(page, text.as_str()),
                    Some(Ok(_)) => {}
                    _ => open = false,
                },
            }
        }
        self.views.fetch_sub(1, Ordering::Relaxed);
        self.changed.send_replace(());
    }

    fn hear(&self, page: u64, text: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (app, fields) = &mut *state;
        match serde_json::from_str(text) {
            Ok(FromPage::Event { name, value }) => app.event(&name, &value, fields),
            Ok(FromPage::Input { name, value }) => {
                let room = fields.0.len() < MAX_FIELDS || fields.0.contains_key(&name);
                let others: usize = fields
                    .0
                    .iter()
                    .filter(|(other, _)| **other != name)
                    .map(|(_, field)| field.value.len())
                    .sum();
                if room
                    && value.len() <= MAX_FIELD_BYTES
                    && others + value.len() <= MAX_FIELDS_BYTES
                    && name.len() <= MAX_FIELD_NAME_BYTES
                {
                    fields.0.insert(name.clone(), Field { value, by: page });
                    app.input(&name, fields);
                }
            }
            Err(e) => eprintln!("gxwi: a page sent something that is not a message: {e}"),
        }
        self.changed.send_replace(());
    }
}

/// Lets one surface go. See [`Surface::closer`] and [`crate::App::raw_page`].
#[derive(Clone)]
pub struct Closer {
    number: u64,
    desk: Arc<Desk>,
}

impl Closer {
    pub(crate) fn new(number: u64, desk: Arc<Desk>) -> Closer {
        Closer { number, desk }
    }

    /// Calls the surface something else. See [`Surface::retitle`].
    pub fn retitle(&self, title: &str) {
        self.desk.retitle(self.number, title);
    }

    pub fn close(&self) {
        self.desk.let_go(self.number);
    }
}

/// Text as it may safely appear in HTML, between tags or in an attribute.
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_escaped_can_close_a_tag_or_an_attribute() {
        assert_eq!(escape(r#"<b a="1">&"#), "&lt;b a=&quot;1&quot;&gt;&amp;");
    }

    #[test]
    fn what_the_process_sets_is_marked_as_the_processs() {
        let mut fields = Fields::default();
        fields.0.insert(
            "note".into(),
            Field {
                value: "typed".into(),
                by: 3,
            },
        );
        assert_eq!(fields.get("note"), "typed");
        fields.set("note", "");
        assert_eq!(fields.0["note"].by, 0);
        assert_eq!(fields.get("never set"), "");
    }
}
