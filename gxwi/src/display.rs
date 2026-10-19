//! An app's end of the display socket.
//!
//! One `SOCK_SEQPACKET` connection to the compositor, found by `GXWI_DISPLAY`,
//! carrying one JSON object a message. Neither side waits on the other for an
//! answer, and an app numbers its own surfaces.
//!
//!   app → compositor   { "type": "serve" }, with a stream socket attached
//!   app → compositor   { "type": "create", "surface": n, "title", "role"?,
//!                        "edge"?, "kind": "live", "socket", "styles": [...] }
//!                   or { ..., "kind": "raw", "path" }
//!   app → compositor   { "type": "title", "surface": n, "title" }
//!   app → compositor   { "type": "destroy", "surface": n }
//!   shell → compositor { "type": "start", "program", "arguments": [...] }
//!   shell → compositor { "type": "close", "id": n }
//!   shell → compositor { "type": "log_off" }
//!   compositor → app   { "type": "close", "surface": n }
//!   compositor → shell { "type": "surfaces",
//!                        "surfaces": [{ "id", "title", "role", "icon", "app",
//!                                       "workspace", "own"?,
//!                                       "application"?: { "id", "title" } }] }
//!
//! `role` is "window" unless said, and `edge` is which edge a panel lies
//! along ("top", "bottom", "left" or "right"), "bottom" unless said. `app`
//! tells the surfaces of one program from another's: it is the compositor's
//! number for the connection, and 0 for the desktop's own. `workspace` is
//! which workspace a window is on, from 1, and 0 for anything that is not a
//! window. `application` is the declaration the program behind a surface
//! matched (PGSS Applications, [`crate::apps`]), when it matched one: the
//! id, and the title it is listed under. The messages marked shell → compositor
//! are done only for a part of the shell, which is a program the compositor
//! started as one, and so is the last: see [`Asked::Surfaces`]. The `id` a
//! shell asks to have closed is the desktop's for a surface of anyone's, as
//! `surfaces` gave it, and the asking is passed on to the app whose surface
//! it is as `close`, with that app's own number.
//!
//! `App` is the way to use this. It is public for a program that wants the
//! wire and nothing built on it.

use std::io;
use std::os::fd::FromRawFd;
use std::ptr::NonNull;
use std::os::unix::net::UnixStream;

use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::service::TowerToHyperService;
use gxwi_abi as abi;

use crate::sys;

/// Owns a connection through libgxwi.so.1.
pub struct Display(NonNull<sys::Display>);

/// What a surface is for. The desktop's window manager goes by it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    /// A window among the others.
    Window,
    /// Something along an edge of the desktop that the windows make room
    /// for, such as a taskbar.
    Panel,
    /// Something over the windows, out of sight until it is sent for and
    /// gone again when it is done with, such as a launcher. Only the shell
    /// can send for one.
    Overlay,
    /// Something under everything, filling the desktop: the wallpaper, and
    /// whatever else a shell puts on the desktop itself.
    Background,
    /// A window of its own that floats over the others, such as a program's
    /// dialog.
    Dialog,
}

impl Role {
    fn code(self) -> u32 {
        match self {
            Role::Window => abi::ROLE_WINDOW,
            Role::Panel => abi::ROLE_PANEL,
            Role::Overlay => abi::ROLE_OVERLAY,
            Role::Background => abi::ROLE_BACKGROUND,
            Role::Dialog => abi::ROLE_DIALOG,
        }
    }
}

/// Which edge of the desktop a panel lies along.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Edge {
    Top,
    Bottom,
    Left,
    Right,
}

impl Edge {
    fn code(self) -> u32 {
        match self {
            Edge::Top => abi::EDGE_TOP,
            Edge::Bottom => abi::EDGE_BOTTOM,
            Edge::Left => abi::EDGE_LEFT,
            Edge::Right => abi::EDGE_RIGHT,
        }
    }
}

/// A surface of the session's, anyone's, as a part of the shell is told of it.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    /// What the desktop knows the surface by. It is what `fx-surface` and
    /// `fx-focus` take in a live surface's HTML, and is nothing like the
    /// numbers an app gives its own surfaces.
    pub id: u64,
    pub title: String,
    pub role: Role,
    /// The name of the icon of the program behind it, as PGSS Icons finds
    /// it, for [`crate::icons::href`].
    pub icon: String,
    /// Which program it belongs to, as a number that is the same for every
    /// surface of one connection and different between two, for showing a
    /// program's windows together. 0 is the desktop's own.
    pub app: u64,
    /// Which workspace a window is on, from 1. Anything that is not a
    /// window is on none, which is 0. Which workspace a device is showing
    /// is that device's, and comes to the HTML as `fx-workspace` marks.
    pub workspace: u32,
    /// The app's own number for it, when it is one of this app's: what
    /// [`crate::Surface::number`] gives. So a part of the shell can find the
    /// desktop's id for one of its own surfaces, which its HTML needs to send
    /// for an overlay from a panel.
    pub own: Option<u64>,
    /// The application the program behind it is declared as (PGSS
    /// Applications), if it is declared as one.
    pub application: Option<Declaration>,
}

/// An application a running program was matched to: enough of its
/// declaration to name it by, which [`crate::apps::Catalogue::get`] gives the
/// rest of.
#[derive(Clone, Debug, PartialEq)]
pub struct Declaration {
    pub id: String,
    pub title: String,
}

/// What the desktop asks of an app, or tells it.
pub enum Asked {
    /// The person wants this surface closed. What that means is the app's:
    /// the surface stays until the app lets it go.
    Close(u64),
    /// Every surface the session has, sent whenever any of them changes. Only
    /// a part of the shell is told, and a program cannot make itself one: the
    /// compositor knows its shell by having started it.
    Surfaces(Vec<Listed>),
    /// Something this library does not know about, which is not an error.
    Other,
}

// SAFETY: libgxwi permits concurrent sends/receives/shutdown; all handle state
// is immutable until destruction, which Rust ownership excludes from calls.
unsafe impl Send for Display {}
// SAFETY: the same libgxwi concurrency contract covers shared references.
unsafe impl Sync for Display {}

impl Drop for Display {
    fn drop(&mut self) {
        // SAFETY: this uniquely owned handle has no surviving borrowed calls.
        unsafe { sys::peios_gxwi_display_destroy(self.0.as_ptr()) };
    }
}

fn checked(status: i32) -> io::Result<()> {
    if status < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn bytes(text: &str) -> abi::Bytes {
    abi::Bytes::new(text.as_bytes())
}

impl Display {
    /// Connects to GXWI_DISPLAY, setting Identification before connecting.
    pub fn connect() -> io::Result<Self> {
        let mut display = std::ptr::null_mut();
        // SAFETY: display is a writable output pointer; no other inputs exist.
        checked(unsafe { sys::peios_gxwi_connect(&mut display) })?;
        let display =
            NonNull::new(display).ok_or_else(|| io::Error::other("libgxwi returned no display"))?;
        Ok(Self(display))
    }

    /// Returns the owned HTTP/2 stream whose peer was sent to the desktop.
    pub fn serve(&self) -> io::Result<UnixStream> {
        let mut fd = -1;
        // SAFETY: the handle is live and fd is writable; success transfers ownership.
        checked(unsafe { sys::peios_gxwi_serve(self.0.as_ptr(), &mut fd) })?;
        // SAFETY: successful serve returns a fresh, exclusively owned stream fd.
        Ok(unsafe { UnixStream::from_raw_fd(fd) })
    }

    /// Requests a live surface; edge selects the side for a panel.
    pub fn create_live(
        &self,
        surface: u64,
        title: &str,
        role: Role,
        edge: Option<Edge>,
        socket: &str,
        styles: &[String],
    ) -> io::Result<()> {
        let styles: Vec<_> = styles.iter().map(|style| bytes(style)).collect();
        let options = abi::LiveOptions {
            surface,
            title: bytes(title),
            role: role.code(),
            edge: edge.map_or(abi::EDGE_DEFAULT, Edge::code),
            socket: bytes(socket),
            styles: styles.as_ptr(),
            style_count: styles.len(),
        };
        // SAFETY: all spans and the handle remain live until this synchronous call returns.
        checked(unsafe { sys::peios_gxwi_create_live(self.0.as_ptr(), &options) })
    }

    /// Requests a raw page at a path served by this app.
    pub fn create_raw(&self, surface: u64, title: &str, path: &str) -> io::Result<()> {
        // SAFETY: input spans borrow valid UTF-8 for this call; the handle is live.
        checked(unsafe {
            sys::peios_gxwi_create_raw(self.0.as_ptr(), surface, bytes(title), bytes(path))
        })
    }

    /// Sends a shell start request. Sending is not authorization or an acknowledgement.
    pub fn start(&self, program: &str, arguments: &[String]) -> io::Result<()> {
        let arguments: Vec<_> = arguments.iter().map(|argument| bytes(argument)).collect();
        // SAFETY: the array, spans and handle remain live during this call.
        checked(unsafe {
            sys::peios_gxwi_start(
                self.0.as_ptr(),
                bytes(program),
                arguments.as_ptr(),
                arguments.len(),
            )
        })
    }

    /// Asks the desktop to request closing a surface identified by its desktop ID.
    /// Only a shell connection is authorized by the compositor to do this.
    pub fn close(&self, id: u64) -> io::Result<()> {
        // SAFETY: the handle is live for the call.
        checked(unsafe { sys::peios_gxwi_close(self.0.as_ptr(), id) })
    }

    /// Sends a shell log-off request; the compositor decides whether to act.
    pub fn log_off(&self) -> io::Result<()> {
        // SAFETY: the handle is live for the call.
        checked(unsafe { sys::peios_gxwi_log_off(self.0.as_ptr()) })
    }

    /// Changes the title of an app-owned surface.
    pub fn title(&self, surface: u64, title: &str) -> io::Result<()> {
        // SAFETY: the UTF-8 span and handle remain live during this call.
        checked(unsafe { sys::peios_gxwi_title(self.0.as_ptr(), surface, bytes(title)) })
    }

    /// Releases an app-owned surface.
    pub fn destroy(&self, surface: u64) -> io::Result<()> {
        // SAFETY: the handle is live for the call.
        checked(unsafe { sys::peios_gxwi_destroy(self.0.as_ptr(), surface) })
    }

    /// Waits for a desktop event; EOF means the desktop closed or listening stopped.
    pub fn asked(&self) -> io::Result<Option<Asked>> {
        let mut event = std::ptr::null_mut();
        // SAFETY: the handle is live and event is writable; success transfers ownership.
        let status = unsafe { sys::peios_gxwi_receive(self.0.as_ptr(), &mut event) };
        checked(status)?;
        if status == 0 {
            return Ok(None);
        }
        let event =
            NonNull::new(event).ok_or_else(|| io::Error::other("libgxwi returned no event"))?;
        Event(event).understood().map(Some)
    }

    /// Wakes receiving calls with EOF, leaving sending available.
    pub fn stop_listening(&self) {
        // SAFETY: the handle remains live. This preserves the existing API's
        // best-effort shutdown semantics; there is no returned error channel.
        let _ = unsafe { sys::peios_gxwi_stop_listening(self.0.as_ptr()) };
    }
}

struct Event(NonNull<sys::Event>);

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: all borrowed views were consumed within methods on this owner.
        unsafe { sys::peios_gxwi_event_destroy(self.0.as_ptr()) };
    }
}

impl Event {
    fn understood(&self) -> io::Result<Asked> {
        let mut kind = abi::EVENT_OTHER;
        // SAFETY: self owns a live event, and kind is writable.
        checked(unsafe { sys::peios_gxwi_event_kind(self.0.as_ptr(), &mut kind) })?;
        match kind {
            abi::EVENT_CLOSE => {
                let mut surface = 0;
                // SAFETY: event is live; the typed getter initializes surface on success.
                checked(unsafe { sys::peios_gxwi_event_close(self.0.as_ptr(), &mut surface) })?;
                Ok(Asked::Close(surface))
            }
            abi::EVENT_SURFACES => self.surfaces().map(Asked::Surfaces),
            _ => Ok(Asked::Other),
        }
    }

    fn surfaces(&self) -> io::Result<Vec<Listed>> {
        let mut count = 0;
        // SAFETY: self owns the event and count is writable.
        checked(unsafe { sys::peios_gxwi_event_surface_count(self.0.as_ptr(), &mut count) })?;
        (0..count).map(|index| self.surface(index)).collect()
    }

    fn surface(&self, index: usize) -> io::Result<Listed> {
        let mut surface = std::mem::MaybeUninit::uninit();
        // SAFETY: the event is live and the getter initializes the complete view on success.
        checked(unsafe {
            sys::peios_gxwi_event_surface(self.0.as_ptr(), index, surface.as_mut_ptr())
        })?;
        // SAFETY: the successful call initialized this value and its borrowed strings.
        let surface = unsafe { surface.assume_init() };
        // SAFETY: each span belongs to this still-live immutable event. Every
        // string is copied before self can be destroyed; no borrow escapes.
        unsafe {
            Ok(Listed {
                id: surface.id,
                title: copy_text(surface.title)?,
                role: decode_role(surface.role)?,
                icon: copy_text(surface.icon)?,
                app: surface.app,
                workspace: surface.workspace,
                own: (surface.flags & abi::LISTED_HAS_OWN != 0).then_some(surface.own),
                application: if surface.flags & abi::LISTED_HAS_APPLICATION != 0 {
                    Some(Declaration {
                        id: copy_text(surface.application_id)?,
                        title: copy_text(surface.application_title)?,
                    })
                } else {
                    None
                },
            })
        }
    }
}

fn decode_role(role: u32) -> io::Result<Role> {
    match role {
        abi::ROLE_WINDOW => Ok(Role::Window),
        abi::ROLE_PANEL => Ok(Role::Panel),
        abi::ROLE_OVERLAY => Ok(Role::Overlay),
        abi::ROLE_BACKGROUND => Ok(Role::Background),
        abi::ROLE_DIALOG => Ok(Role::Dialog),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unknown libgxwi surface role",
        )),
    }
}

unsafe fn copy_text(span: abi::Bytes) -> io::Result<String> {
    if span.len == 0 {
        return Ok(String::new());
    }
    // SAFETY: caller supplies a span borrowed from a live libgxwi event.
    let bytes = unsafe { std::slice::from_raw_parts(span.data, span.len) };
    String::from_utf8(bytes.to_vec())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
/// Answers HTTP/2 with `app` on the socket whose other end the desktop has.
pub async fn answer(socket: UnixStream, app: Router) -> io::Result<()> {
    socket.set_nonblocking(true)?;
    let socket = tokio::net::UnixStream::from_std(socket)?;
    // Websockets come over HTTP/2 as a CONNECT, which has to be asked for.
    let mut http = hyper::server::conn::http2::Builder::new(TokioExecutor::new());
    http.enable_connect_protocol();
    http.serve_connection(TokioIo::new(socket), TowerToHyperService::new(app))
        .await
        .map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exported_errors_cross_the_dynamic_boundary_without_losing_errno() {
        // SAFETY: null is a deliberately invalid argument documented to return EINVAL.
        let result = unsafe { sys::peios_gxwi_connect(std::ptr::null_mut()) };
        assert_eq!(
            checked(result).unwrap_err().raw_os_error(),
            Some(libc::EINVAL)
        );
    }

    #[test]
    fn role_codes_round_trip() {
        for role in [
            Role::Window,
            Role::Panel,
            Role::Overlay,
            Role::Background,
            Role::Dialog,
        ] {
            assert_eq!(decode_role(role.code()).unwrap(), role);
        }
        assert!(decode_role(u32::MAX).is_err());
    }

    #[test]
    fn returned_text_is_copied_and_keeps_embedded_nuls() {
        let original = String::from("Notes\0λ");
        // SAFETY: this test supplies a live UTF-8 buffer as the event would.
        let copied = unsafe { copy_text(bytes(&original)) }.unwrap();
        drop(original);
        assert_eq!(copied, "Notes\0λ");
    }
}
