//! The overlay, from gxwi-server's side: where gxwid last said it stands.
//!
//! An overlay is one program for the whole machine that everyone is sent to in
//! place of the logon pages and of their own session. Whether there is one is
//! the administrator's to say and gxwid's to read. Nothing is asked here and
//! nothing decided: gxwid says there is none, or that there is one and it
//! cannot be reached, or hands over a socket to it, and every request is
//! served accordingly.
//!
//! It is known before the first request is served. gxwid writes where the
//! overlay stands before it starts this process, and nothing is listened for
//! until that has been read: an overlay keeps people from what is behind it,
//! and must not be late.

use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::{TokioExecutor, TokioIo};

use gxwi_channel::{CONTROL, MSG_OVERLAY, MSG_OVERLAY_NONE, MSG_OVERLAY_UNAVAILABLE};
use auth_core::transport::recv_message_with_fd;

pub struct Overlay(Mutex<Standing>);

enum Standing {
    None,
    Unavailable,
    Up(SendRequest<Body>),
}

/// What becomes of a request, given where the overlay stands.
pub enum Route {
    /// There is no overlay: the logon pages and the sessions, as ever.
    Behind,
    /// There is one, and this is the way to it.
    Overlay(SendRequest<Body>),
    /// There is one and it cannot be reached. Nothing else is served.
    Unavailable,
}

impl Overlay {
    /// Reads where the overlay stands from gxwid's channel, then goes on
    /// reading it for as long as gxwid has more to say.
    pub async fn listen(channel: UnixStream) -> io::Result<Arc<Overlay>> {
        let overlay = Arc::new(Overlay(Mutex::new(Standing::Unavailable)));
        let (channel, first) = tokio::task::spawn_blocking(move || {
            let first = recv_message_with_fd(&CONTROL, &channel);
            (channel, first)
        })
        .await
        .map_err(io::Error::other)?;
        let (message, descriptor) = first?;
        overlay.told(message.expose(), descriptor).await;

        let (listening, runtime) = (overlay.clone(), tokio::runtime::Handle::current());
        std::thread::Builder::new()
            .name("overlay".into())
            .spawn(move || {
                // Ends when gxwid does, which ends this process too.
                while let Ok((message, descriptor)) = recv_message_with_fd(&CONTROL, &channel) {
                    runtime.block_on(listening.told(message.expose(), descriptor));
                }
            })?;
        Ok(overlay)
    }

    /// Takes one statement from gxwid. One that cannot be understood, or a
    /// socket that cannot be used, leaves an overlay that cannot be reached:
    /// what is not known to be no overlay is not served as none.
    async fn told(&self, message: &[u8], descriptor: Option<OwnedFd>) {
        let standing = match (gxwi_channel::control_message_type(message), descriptor) {
            (Ok(MSG_OVERLAY_NONE), _) => Standing::None,
            (Ok(MSG_OVERLAY_UNAVAILABLE), _) => Standing::Unavailable,
            (Ok(MSG_OVERLAY), Some(socket)) => match open(UnixStream::from(socket)).await {
                Ok(sender) => Standing::Up(sender),
                Err(e) => {
                    eprintln!("gxwi-server: the overlay's socket could not be used: {e}");
                    Standing::Unavailable
                }
            },
            _ => {
                eprintln!(
                    "gxwi-server: gxwid said something about the overlay that could not be read"
                );
                Standing::Unavailable
            }
        };
        eprintln!("gxwi-server: the overlay is {}", standing.name());
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = standing;
    }

    pub fn route(&self) -> Route {
        match &*self.0.lock().unwrap_or_else(|e| e.into_inner()) {
            Standing::None => Route::Behind,
            // A connection that has closed is an overlay that has gone.
            // gxwid starts it again and says so; until then it is unreachable.
            Standing::Up(sender) if !sender.is_closed() => Route::Overlay(sender.clone()),
            Standing::Up(_) | Standing::Unavailable => Route::Unavailable,
        }
    }

    #[cfg(test)]
    fn standing(standing: Standing) -> Overlay {
        Overlay(Mutex::new(standing))
    }
}

impl Standing {
    fn name(&self) -> &'static str {
        match self {
            Standing::None => "not set",
            Standing::Unavailable => "set, and not available",
            Standing::Up(_) => "up",
        }
    }
}

/// Opens HTTP/2 on a socket to the overlay, as on one to a compositor.
async fn open(socket: UnixStream) -> io::Result<SendRequest<Body>> {
    socket.set_nonblocking(true)?;
    let socket = tokio::net::UnixStream::from_std(socket)?;
    let (sender, connection) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(socket))
            .await
            .map_err(io::Error::other)?;
    tokio::spawn(async move {
        let how = connection
            .await
            .err()
            .map(|e| format!(" ({e})"))
            .unwrap_or_default();
        eprintln!("gxwi-server: the overlay's connection closed{how}");
    });
    Ok(sender)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gxwi_channel::control_message;

    fn is(route: Route) -> &'static str {
        match route {
            Route::Behind => "behind",
            Route::Overlay(_) => "overlay",
            Route::Unavailable => "unavailable",
        }
    }

    #[tokio::test]
    async fn what_gxwid_says_is_how_requests_are_served() {
        let overlay = Overlay::standing(Standing::Unavailable);
        assert_eq!(is(overlay.route()), "unavailable");
        overlay.told(&control_message(MSG_OVERLAY_NONE), None).await;
        assert_eq!(is(overlay.route()), "behind");
        overlay
            .told(&control_message(MSG_OVERLAY_UNAVAILABLE), None)
            .await;
        assert_eq!(is(overlay.route()), "unavailable");
    }

    #[tokio::test]
    async fn what_cannot_be_understood_is_not_taken_for_no_overlay() {
        let overlay = Overlay::standing(Standing::None);
        // An overlay with no socket to it.
        overlay.told(&control_message(MSG_OVERLAY), None).await;
        assert_eq!(is(overlay.route()), "unavailable");

        let overlay = Overlay::standing(Standing::None);
        overlay
            .told(&control_message(gxwi_channel::MSG_CONVERSATION), None)
            .await;
        assert_eq!(is(overlay.route()), "unavailable");

        let overlay = Overlay::standing(Standing::None);
        overlay.told(b"nonsense", None).await;
        assert_eq!(is(overlay.route()), "unavailable");
    }

    #[tokio::test]
    async fn an_overlay_is_reached_until_its_connection_closes() {
        // The far end of the socket gxwid would hand over, speaking HTTP/2 as
        // an overlay does.
        let (ours, theirs) = UnixStream::pair().unwrap();
        theirs.set_nonblocking(true).unwrap();
        let theirs = tokio::net::UnixStream::from_std(theirs).unwrap();
        let serving = tokio::spawn(async move {
            let service = hyper::service::service_fn(
                |_request: hyper::Request<hyper::body::Incoming>| async {
                    Ok::<_, std::convert::Infallible>(hyper::Response::new(Body::from("overlay")))
                },
            );
            let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                .serve_connection(TokioIo::new(theirs), service)
                .await;
        });

        let overlay = Overlay::standing(Standing::None);
        overlay
            .told(&control_message(MSG_OVERLAY), Some(OwnedFd::from(ours)))
            .await;
        let Route::Overlay(mut sender) = overlay.route() else {
            panic!("the overlay should be up")
        };
        let request = hyper::Request::builder()
            .uri("http://gxwi/")
            .body(Body::empty())
            .unwrap();
        assert_eq!(sender.send_request(request).await.unwrap().status(), 200);

        serving.abort();
        let _ = serving.await;
        for _ in 0..100 {
            if is(overlay.route()) == "unavailable" {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("an overlay whose connection closed is still being sent requests");
    }
}
