//! gxwi-hello — a stand-in for the compositor, there to prove the path to one.
//!
//! gxwid starts it as the person who logged on and hands it a listening
//! socket. It answers HTTP/2 on that socket with who it is running as, read
//! from its own token, so that a browser shows the identity the logon
//! actually produced; it echoes a websocket, because everything interactive
//! will need one; and it can be told to log off, which is simply exiting.

use std::os::fd::{AsFd, FromRawFd};
use std::os::unix::net::UnixListener;

use axum::Router;
use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::response::{Html, IntoResponse};
use axum::routing::{any, get, post};
use peios::token::{ImpersonationLevel, Token, TokenAccess};

/// Where peinit puts the first descriptor a job was submitted with.
const LISTENER_FD: i32 = 3;

#[tokio::main]
async fn main() {
    if std::env::var("LISTEN_FDS")
        .ok()
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(0)
        < 1
    {
        die("no socket was handed over: gxwi-hello is started by gxwid, not by hand");
    }
    // SAFETY: peinit placed this descriptor for us and nothing else owns it.
    let listener = unsafe { UnixListener::from_raw_fd(LISTENER_FD) };
    // gxwid bound this socket, so it still answers in gxwid's name. gxwid
    // waits for it to answer in ours before it sends anyone here.
    ImpersonationLevel::restamp_listener(listener.as_fd())
        .unwrap_or_else(|e| die(&format!("restamp: {e}")));
    listener
        .set_nonblocking(true)
        .unwrap_or_else(|e| die(&format!("listener: {e}")));
    let listener = tokio::net::UnixListener::from_std(listener)
        .unwrap_or_else(|e| die(&format!("listener: {e}")));

    // Only SYSTEM can reach the socket, by the descriptor gxwid put on it, so
    // there is nobody to check for here.
    let app = Router::new()
        .route(
            "/.hello/echo",
            any(|upgrade: WebSocketUpgrade| async { upgrade.on_upgrade(echo) }),
        )
        .route("/.hello/logoff", post(logoff))
        .fallback(get(hello));
    axum::serve(listener, app)
        .await
        .unwrap_or_else(|e| die(&format!("serve: {e}")));
}

async fn hello(uri: axum::http::Uri) -> Html<String> {
    Html(
        PAGE.replace("{identity}", &escape(&identity()))
            .replace("{path}", &escape(&uri.to_string())),
    )
}

fn identity() -> String {
    let token = match Token::open_self(true, TokenAccess::QUERY) {
        Ok(token) => token,
        Err(e) => return format!("this process's token could not be opened: {e}"),
    };
    let mut out = String::new();
    let line =
        |out: &mut String, name: &str, value: String| out.push_str(&format!("{name:<14}{value}\n"));
    line(&mut out, "process", std::process::id().to_string());
    line(
        &mut out,
        "user",
        token
            .user()
            .map_or_else(|e| e.to_string(), |sid| sid.to_string()),
    );
    line(
        &mut out,
        "logon session",
        token
            .auth_id()
            .map_or_else(|e| e.to_string(), |id| format!("{:#x}", id.0)),
    );
    line(
        &mut out,
        "integrity",
        token
            .integrity()
            .map_or_else(|e| e.to_string(), |level| format!("{level:?}")),
    );
    match token.groups() {
        Ok(groups) => {
            for (sid, attributes) in groups {
                line(&mut out, "group", format!("{sid}  ({attributes:#x})"));
            }
        }
        Err(e) => line(&mut out, "groups", e.to_string()),
    }
    out
}

async fn echo(mut socket: WebSocket) {
    while let Some(Ok(message)) = socket.recv().await {
        if socket.send(message).await.is_err() {
            return;
        }
    }
}

/// Logging off is this process ending: gxwi-server sees the socket close and
/// forgets the session. The answer is given a moment to leave first.
async fn logoff() -> impl IntoResponse {
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        std::process::exit(0);
    });
    Html(
        "<!doctype html><title>Logged off</title><p>Logged off. <a href=\"/\">Log on again</a></p>",
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn die(message: &str) -> ! {
    eprintln!("gxwi-hello: {message}");
    std::process::exit(1);
}

const PAGE: &str = include_str!("page.html");
