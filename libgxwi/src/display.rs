//! An app's end of the display socket.
//!
//! One `SOCK_SEQPACKET` connection to the compositor, found by `GXWI_DISPLAY`,
//! carrying one JSON object a message. Neither side waits on the other for an
//! answer, and an app numbers its own surfaces.
//!
//!   app → compositor   { "type": "serve" }, with a stream socket attached
//!   app → compositor   { "type": "create", "surface": n, "title",
//!                        "kind": "live", "socket", "styles": [...] }
//!                   or { ..., "kind": "raw", "path" }
//!   app → compositor   { "type": "destroy", "surface": n }
//!   compositor → app   { "type": "close", "surface": n }
//!
//! `App` is the way to use this. It is public for a program that wants the
//! wire and nothing built on it.

use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;

use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::service::TowerToHyperService;
use peios::token::ImpersonationLevel;
use serde_json::{Value, json};

pub struct Display(OwnedFd);

/// What the desktop asks of an app.
pub enum Asked {
    /// The person wants this surface closed. What that means is the app's:
    /// the surface stays until the app lets it go.
    Close(u64),
    /// Something this library does not know about, which is not an error.
    Other,
}

impl Display {
    /// Connects to the desktop named in `GXWI_DISPLAY`, without lending this
    /// process's identity: the desktop needs to see who an app is, and has no
    /// business acting as it.
    pub fn connect() -> io::Result<Display> {
        let path = std::env::var_os("GXWI_DISPLAY")
            .ok_or_else(|| io::Error::other("GXWI_DISPLAY is not set: there is no desktop here to be on"))?;
        let path = path.as_encoded_bytes();
        // SAFETY: a zeroed sockaddr_un is a valid one.
        let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        if path.len() >= addr.sun_path.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "socket path too long"));
        }
        for (to, from) in addr.sun_path.iter_mut().zip(path) {
            *to = *from as libc::c_char;
        }
        // SAFETY: the descriptor is checked before it is owned, and the
        // address is the one filled in above with its true length.
        unsafe {
            let fd = libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0);
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let socket = OwnedFd::from_raw_fd(fd);
            ImpersonationLevel::Identification.set_on_socket(socket.as_fd())?;
            let len = (std::mem::size_of::<libc::sa_family_t>() + path.len() + 1) as libc::socklen_t;
            if libc::connect(socket.as_raw_fd(), (&raw const addr).cast(), len) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Display(socket))
        }
    }

    fn say(&self, message: Value, attached: &[BorrowedFd<'_>]) -> io::Result<()> {
        peios::socket::send_message(self.0.as_fd(), message.to_string().as_bytes(), None, attached, libc::MSG_NOSIGNAL)?;
        Ok(())
    }

    /// Hands the desktop one end of a socket, and returns the end to answer
    /// HTTP/2 on. An app listens nowhere and has no address.
    pub fn serve(&self) -> io::Result<UnixStream> {
        let (ours, theirs) = UnixStream::pair()?;
        self.say(json!({ "type": "serve" }), &[theirs.as_fd()])?;
        Ok(ours)
    }

    /// Asks for a surface this process draws: the desktop's own page shows
    /// what comes down the websocket at `socket`, styled by `styles`.
    pub fn create_live(&self, surface: u64, title: &str, socket: &str, styles: &[String]) -> io::Result<()> {
        self.say(
            json!({ "type": "create", "surface": surface, "title": title, "kind": "live", "socket": socket, "styles": styles }),
            &[],
        )
    }

    /// Asks for a surface that is a page of the app's own, at `path`.
    pub fn create_raw(&self, surface: u64, title: &str, path: &str) -> io::Result<()> {
        self.say(json!({ "type": "create", "surface": surface, "title": title, "kind": "raw", "path": path }), &[])
    }

    /// Lets a surface go.
    pub fn destroy(&self, surface: u64) -> io::Result<()> {
        self.say(json!({ "type": "destroy", "surface": surface }), &[])
    }

    /// Waits for the desktop to ask something. `None` is the end: the desktop
    /// has gone, or this process has said it is done listening.
    pub fn asked(&self) -> io::Result<Option<Asked>> {
        let mut buf = vec![0u8; 64 * 1024];
        let got = peios::socket::recv_message(self.0.as_fd(), &mut buf, 0, 0)?;
        if got.len == 0 {
            return Ok(None);
        }
        let message: Value = serde_json::from_slice(&buf[..got.len]).unwrap_or_default();
        Ok(Some(match (message["type"].as_str(), message["surface"].as_u64()) {
            (Some("close"), Some(surface)) => Asked::Close(surface),
            _ => Asked::Other,
        }))
    }

    /// Stops listening, which wakes whoever is waiting in `asked` with the
    /// end. What is sent still goes.
    pub fn stop_listening(&self) {
        // SAFETY: the descriptor is this value's own, and live.
        unsafe { libc::shutdown(self.0.as_raw_fd(), libc::SHUT_RD) };
    }
}

/// Answers HTTP/2 with `app` on the socket whose other end the desktop has.
pub async fn answer(socket: UnixStream, app: Router) -> io::Result<()> {
    socket.set_nonblocking(true)?;
    let socket = tokio::net::UnixStream::from_std(socket)?;
    // Websockets come over HTTP/2 as a CONNECT, which has to be asked for.
    let mut http = hyper::server::conn::http2::Builder::new(TokioExecutor::new());
    http.enable_connect_protocol();
    http.serve_connection(TokioIo::new(socket), TowerToHyperService::new(app)).await.map_err(io::Error::other)
}
