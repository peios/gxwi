//! gxwi-server — the network-facing half of GXWI. It opens nothing for itself:
//! gxwid hands it a listening socket and a channel back to gxwid.

use std::net::SocketAddr;
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::net::UnixStream;

mod form;
mod logon;
mod pages;

#[tokio::main]
async fn main() {
    let listener_fd = fd_arg("--listener-fd");
    let channel_fd = fd_arg("--channel-fd");
    if !std::env::args().any(|a| a == "--unrestricted") {
        refuse_unless_sandboxed();
    }

    // SAFETY: gxwid placed these descriptors for us and nothing else in this
    // process owns them.
    let (listener, channel) = unsafe {
        (
            std::net::TcpListener::from_raw_fd(listener_fd),
            UnixStream::from_raw_fd(channel_fd),
        )
    };
    listener
        .set_nonblocking(true)
        .unwrap_or_else(|e| die(&format!("descriptor {listener_fd} is not a listening socket: {e}")));
    let listener = tokio::net::TcpListener::from_std(listener)
        .unwrap_or_else(|e| die(&format!("listener: {e}")));

    // Until there are sessions, logon is all there is to serve.
    let app = logon::routes(channel);
    eprintln!("gxwi-server: serving on descriptor {listener_fd}");
    // The peer's address rides along with each request: gxwid throttles on it.
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}

/// This process parses everything the network sends, so it serves only from
/// inside gxwid's restricted token. Listing `/` is the probe: anyone may
/// ordinarily do it, and the restricted token may not.
fn refuse_unless_sandboxed() {
    match std::fs::read_dir("/") {
        Ok(_) => die("can list /, so this is not gxwid's restricted token; refusing to serve"),
        Err(e) => eprintln!("gxwi-server: sandboxed (listing / gives: {e})"),
    }
}

fn fd_arg(name: &str) -> RawFd {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == name {
            return args
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| die(&format!("{name} needs a descriptor number")));
        }
    }
    die(&format!("missing {name}: gxwi-server is started by gxwid, not by hand"))
}

fn die(msg: &str) -> ! {
    eprintln!("gxwi-server: {msg}");
    std::process::exit(1);
}
