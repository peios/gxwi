//! Sessions, from gxwi-server's side: a cookie and a socket.
//!
//! When a logon is granted, gxwid hands over a socket connected to that
//! session's compositor, and nothing else: no name, no token, no path. The
//! socket *is* the session. Every request bearing the session's cookie is sent
//! down it as HTTP/2, re-framed rather than copied, so that nothing about how
//! a request was written on the wire survives to confuse the far side.

use std::collections::HashMap;
use std::io;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, Request, Response, StatusCode, Uri, Version};
use hyper::client::conn::http2::SendRequest;
use hyper::ext::Protocol;
use hyper_util::rt::{TokioExecutor, TokioIo};
use sha1::{Digest, Sha1};

pub const COOKIE: &str = "gxwi-session";

/// Bounds the table. gxwid decides who gets a session; this only keeps a
/// flood of cookies from growing without limit.
const MAX_SESSIONS: usize = 256;

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, SendRequest<Body>>>);

impl Sessions {
    /// Takes a socket to a compositor and opens HTTP/2 on it. The session is
    /// forgotten when the connection ends, which is how a logoff arrives.
    pub async fn adopt(self: &Arc<Self>, cookie: String, socket: UnixStream) -> io::Result<()> {
        socket.set_nonblocking(true)?;
        let socket = tokio::net::UnixStream::from_std(socket)?;
        let (sender, connection) = hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(socket))
            .await
            .map_err(io::Error::other)?;
        {
            let mut table = self.0.lock().unwrap_or_else(|e| e.into_inner());
            table.retain(|_, s| !s.is_closed());
            if table.len() >= MAX_SESSIONS {
                return Err(io::Error::other("too many sessions"));
            }
            table.insert(cookie.clone(), sender);
        }
        let sessions = self.clone();
        tokio::spawn(async move {
            // A compositor that exits takes the connection down with it, so an
            // error here is how most sessions end and not a fault.
            let how = connection.await.err().map(|e| format!(" ({e})")).unwrap_or_default();
            sessions.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&cookie);
            eprintln!("gxwi-server: a session's connection closed{how}");
        });
        Ok(())
    }

    /// The session a request belongs to, if its cookie names a live one.
    pub fn of(&self, headers: &HeaderMap) -> Option<SendRequest<Body>> {
        let cookie = crate::logon::cookie_named(headers, COOKIE)?;
        let table = self.0.lock().unwrap_or_else(|e| e.into_inner());
        table.get(&cookie).filter(|s| !s.is_closed()).cloned()
    }
}

/// Sends one request into a session and returns what comes back.
pub async fn forward(mut session: SendRequest<Body>, request: Request<Body>) -> Response<Body> {
    let websocket = request.version() < Version::HTTP_2 && wants_websocket(request.headers());
    let result = if websocket { upgrade(&mut session, request).await } else { plain(&mut session, request).await };
    result.unwrap_or_else(|status| {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = status;
        response
    })
}

async fn plain(session: &mut SendRequest<Body>, request: Request<Body>) -> Result<Response<Body>, StatusCode> {
    let (parts, body) = request.into_parts();
    let mut out = Request::new(body);
    *out.method_mut() = parts.method;
    *out.uri_mut() = target(&parts.uri, &parts.headers)?;
    // An HTTP/2 websocket from the browser names its protocol here.
    if let Some(protocol) = parts.extensions.get::<Protocol>() {
        out.extensions_mut().insert(protocol.clone());
    }
    copy_headers(&parts.headers, out.headers_mut());
    let response = session.send_request(out).await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(returned(response))
}

/// A session's answer on its way to the browser. The names under `gxwi-` are
/// GXWI's, so nothing inside a session can set or replace the session cookie.
fn returned(response: Response<hyper::body::Incoming>) -> Response<Body> {
    let (mut parts, body) = response.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    let kept: Vec<HeaderValue> = parts
        .headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter(|v| !v.as_bytes().trim_ascii_start().to_ascii_lowercase().starts_with(b"gxwi-"))
        .cloned()
        .collect();
    parts.headers.remove(header::SET_COOKIE);
    for value in kept {
        parts.headers.append(header::SET_COOKIE, value);
    }
    Response::from_parts(parts, Body::new(body))
}

/// A websocket opened the HTTP/1.1 way, carried into the session the HTTP/2
/// way (RFC 8441). Only the opening differs: the frames that follow are the
/// same bytes on both sides, and are passed through untouched.
async fn upgrade(session: &mut SendRequest<Body>, mut request: Request<Body>) -> Result<Response<Body>, StatusCode> {
    let headers = request.headers();
    let key = headers.get("sec-websocket-key").ok_or(StatusCode::BAD_REQUEST)?;
    if request.method() != Method::GET || headers.get("sec-websocket-version").is_none_or(|v| v != "13") {
        return Err(StatusCode::BAD_REQUEST);
    }
    let accept = websocket_accept(key.as_bytes());

    let mut out = Request::new(Body::empty());
    *out.method_mut() = Method::CONNECT;
    *out.uri_mut() = target(request.uri(), headers)?;
    out.extensions_mut().insert(Protocol::from_static("websocket"));
    copy_headers(headers, out.headers_mut());
    out.headers_mut().remove("sec-websocket-key");

    let mut response = session.send_request(out).await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if response.status() != StatusCode::OK {
        return Ok(returned(response));
    }

    let mut reply = Response::new(Body::empty());
    *reply.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let h = reply.headers_mut();
    h.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    h.insert("sec-websocket-accept", HeaderValue::from_str(&accept).map_err(|_| StatusCode::BAD_GATEWAY)?);
    for name in ["sec-websocket-protocol", "sec-websocket-extensions"] {
        if let Some(value) = response.headers().get(name) {
            h.insert(HeaderName::from_static(name), value.clone());
        }
    }

    let browser = hyper::upgrade::on(&mut request);
    let compositor = hyper::upgrade::on(&mut response);
    tokio::spawn(async move {
        let (Ok(browser), Ok(compositor)) = (browser.await, compositor.await) else { return };
        let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(browser), &mut TokioIo::new(compositor)).await;
    });
    Ok(reply)
}

fn wants_websocket(headers: &HeaderMap) -> bool {
    headers.get(header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// HTTP/2 wants a whole address. The session is the socket, so the host is
/// only what the browser called this machine, passed along as it came.
fn target(uri: &Uri, headers: &HeaderMap) -> Result<Uri, StatusCode> {
    let host = uri
        .authority()
        .map(|a| a.as_str())
        .or_else(|| headers.get(header::HOST)?.to_str().ok())
        .unwrap_or("gxwi");
    let path = uri.path_and_query().map_or("/", |p| p.as_str());
    Uri::builder().scheme("http").authority(host).path_and_query(path).build().map_err(|_| StatusCode::BAD_REQUEST)
}

/// Everything the browser sent, less what belongs to this hop and less GXWI's
/// own cookies: a session has no use for the key to itself, and whatever runs
/// inside it should never be able to read that key out of a request.
fn copy_headers(from: &HeaderMap, to: &mut HeaderMap) {
    for (name, value) in from {
        if name == header::COOKIE || name == header::HOST {
            continue;
        }
        to.append(name.clone(), value.clone());
    }
    strip_hop_by_hop(to);
    let cookies: Vec<&str> = from
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim)
        .filter(|pair| !pair.is_empty() && !pair.split('=').next().is_some_and(|n| n.starts_with("gxwi-")))
        .collect();
    if let Ok(value) = HeaderValue::from_str(&cookies.join("; ")) {
        if !cookies.is_empty() {
            to.insert(header::COOKIE, value);
        }
    }
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|n| HeaderName::from_bytes(n.trim().as_bytes()).ok())
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"] {
        headers.remove(name);
    }
}

/// RFC 6455's proof that the opening was understood: SHA-1 of the browser's
/// key and a fixed string, in base64.
fn websocket_accept(key: &[u8]) -> String {
    let mut hash = Sha1::new();
    hash.update(key);
    hash.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64(&hash.finalize())
}

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |n, b| n << 8 | *b as u32) << (8 * (3 - chunk.len()));
        for i in 0..4 {
            out.push(if i <= chunk.len() { ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_accept_value_is_the_one_the_standard_works_through() {
        assert_eq!(websocket_accept(b"dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn base64_pads() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn a_session_never_sees_gxwis_cookies_or_this_hops_headers() {
        let mut from = HeaderMap::new();
        from.append(header::COOKIE, HeaderValue::from_static("a=1; gxwi-session=secret"));
        from.append(header::COOKIE, HeaderValue::from_static("gxwi-logon=other; b=2"));
        from.insert(header::CONNECTION, HeaderValue::from_static("keep-alive, x-private"));
        from.insert("x-private", HeaderValue::from_static("1"));
        from.insert("x-kept", HeaderValue::from_static("1"));
        from.insert(header::HOST, HeaderValue::from_static("box"));
        let mut to = HeaderMap::new();
        copy_headers(&from, &mut to);
        assert_eq!(to.get(header::COOKIE).unwrap(), "a=1; b=2");
        assert!(to.get("x-private").is_none() && to.get(header::CONNECTION).is_none());
        assert!(to.get(header::HOST).is_none());
        assert_eq!(to.get("x-kept").unwrap(), "1");
    }

    #[test]
    fn only_gxwis_cookies_means_no_cookie_header() {
        let mut from = HeaderMap::new();
        from.insert(header::COOKIE, HeaderValue::from_static("gxwi-session=secret"));
        let mut to = HeaderMap::new();
        copy_headers(&from, &mut to);
        assert!(to.get(header::COOKIE).is_none());
    }
}
