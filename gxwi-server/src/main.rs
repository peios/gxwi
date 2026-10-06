//! gxwi-server — the network-facing half of GXWI. It opens nothing for itself:
//! gxwid hands it a listening socket, a channel back to gxwid, a channel on
//! which gxwid says where the overlay stands, and this machine's key and
//! certificate.

use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::net::UnixStream;

mod form;
mod logon;
mod origin;
mod overlay;
mod pages;
mod serve;
mod session;

#[tokio::main]
async fn main() {
    let listener_fd = fd_arg("--listener-fd");
    let channel_fd = fd_arg("--channel-fd");
    let overlay_fd = fd_arg("--overlay-fd");
    let tls_fd = fd_arg("--tls-fd");
    if !std::env::args().any(|a| a == "--unrestricted") {
        refuse_unless_sandboxed();
    }
    // What the administrator has the pages say. gxwid read it from the
    // registry, which nothing in here can open.
    let (name, notice) = page_args();
    pages::say(name, notice);

    // SAFETY: gxwid placed these descriptors for us and nothing else in this
    // process owns them.
    let (listener, channel, overlay, mut keys) = unsafe {
        (
            std::net::TcpListener::from_raw_fd(listener_fd),
            UnixStream::from_raw_fd(channel_fd),
            UnixStream::from_raw_fd(overlay_fd),
            UnixStream::from_raw_fd(tls_fd),
        )
    };
    // The key and certificate in force, before anything is served; then each
    // renewal, for as long as gxwid has one to give.
    let handed = serve::message(&mut keys).unwrap_or_else(|e| die(&format!("descriptor {tls_fd}: {e}")));
    let (acceptor, certificate) = serve::acceptor(&handed).unwrap_or_else(|e| die(&format!("TLS: {e}")));
    drop(handed);
    std::thread::Builder::new()
        .name("certificate".into())
        .spawn(move || {
            // Ends when gxwid does, which ends this process too.
            while let Ok(renewed) = serve::message(&mut keys) {
                match certificate.renewed(&renewed) {
                    Ok(()) => eprintln!("gxwi-server: serving the renewed certificate"),
                    Err(e) => eprintln!("gxwi-server: gxwid's renewed certificate cannot be used ({e}); keeping the one in force"),
                }
            }
        })
        .unwrap_or_else(|e| die(&format!("certificate thread: {e}")));
    listener
        .set_nonblocking(true)
        .unwrap_or_else(|e| die(&format!("descriptor {listener_fd} is not a listening socket: {e}")));
    let listener = tokio::net::TcpListener::from_std(listener)
        .unwrap_or_else(|e| die(&format!("listener: {e}")));

    // Before anything is served: a server that does not know where the
    // overlay stands would show what an overlay is there to keep people from.
    let overlay = overlay::Overlay::listen(overlay)
        .await
        .unwrap_or_else(|e| die(&format!("gxwid did not say where the overlay stands: {e}")));

    let app = logon::routes(channel, overlay);
    eprintln!("gxwi-server: serving HTTPS on descriptor {listener_fd}");
    serve::serve(listener, acceptor, app).await
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

/// `--logon-name` and each `--logon-notice`, in order. Read in one pass, so
/// that a value is never taken for the name of the next.
fn page_args() -> (Option<String>, Vec<String>) {
    let (mut name, mut notice) = (None, Vec::new());
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--logon-name" => name = args.next(),
            "--logon-notice" => notice.extend(args.next()),
            "--listener-fd" | "--channel-fd" | "--overlay-fd" | "--tls-fd" => drop(args.next()),
            _ => {}
        }
    }
    (name, notice)
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
