//! Serving on the listening socket gxwid hands over: TLS, with this machine's
//! key, and nothing else.
//!
//! A connection that does not open with a TLS handshake is someone who typed
//! `http://`. It is answered once, with the same address under `https://`, and
//! closed: nothing is served over plain HTTP, not even a logon page. The first
//! byte says which it is. A TLS connection always opens with a handshake
//! record, 0x16, and an HTTP request never does.
//!
//! Over TLS the browser is offered HTTP/1.1 alone, as it was spoken before
//! there was TLS. HTTP/2 would carry a websocket another way (RFC 8441), and
//! is not offered until that way has been tried.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{Extension, Router};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::header::{self, HeaderValue};
use axum::http::uri::Authority;
use axum::http::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use rustls::ServerConfig;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

/// How long a connection has to say what it is and finish its handshake. One
/// that takes longer holds nothing but its own task.
const HANDSHAKE: Duration = Duration::from_secs(10);
/// How long a request's headers may take to arrive, once the handshake is done.
const HEADERS: Duration = Duration::from_secs(30);
/// What a TLS connection's first byte always is: a handshake record.
const TLS_HANDSHAKE: u8 = 0x16;

/// What gxwid hands over: the certificate, then the key, each a little-endian
/// u32 length and then its bytes.
pub fn acceptor(handed: &[u8]) -> io::Result<TlsAcceptor> {
    let mut rest = handed;
    let mut take = || -> io::Result<Vec<u8>> {
        let bad = || io::Error::other("gxwid's key and certificate could not be read");
        let (length, after) = rest.split_first_chunk::<4>().ok_or_else(bad)?;
        let length = u32::from_le_bytes(*length) as usize;
        let (part, after) = after.split_at_checked(length).ok_or_else(bad)?;
        rest = after;
        Ok(part.to_vec())
    };
    let (certificate, key) = (take()?, take()?);
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(certificate)],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
        )
        .map_err(io::Error::other)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Serves `app` on every connection `listener` accepts, for as long as there
/// are any.
pub async fn serve(listener: TcpListener, acceptor: TlsAcceptor, app: Router) -> ! {
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                // Out of descriptors, mostly: wait for some to come back
                // rather than spin.
                eprintln!("gxwi-server: accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        tokio::spawn(connection(tcp, peer, acceptor.clone(), app.clone()));
    }
}

async fn connection(tcp: TcpStream, peer: SocketAddr, acceptor: TlsAcceptor, app: Router) {
    let mut first = [0u8; 1];
    match tokio::time::timeout(HANDSHAKE, tcp.peek(&mut first)).await {
        Ok(Ok(1)) => {}
        _ => return,
    }
    if first[0] != TLS_HANDSHAKE {
        let service = hyper::service::service_fn(|request| async move { Ok::<_, std::convert::Infallible>(elsewhere(&request)) });
        let plain = hyper::server::conn::http1::Builder::new()
            .keep_alive(false)
            .timer(TokioTimer::new())
            .header_read_timeout(HANDSHAKE)
            .serve_connection(TokioIo::new(tcp), service);
        let _ = tokio::time::timeout(HANDSHAKE, plain).await;
        return;
    }
    let Ok(Ok(tls)) = tokio::time::timeout(HANDSHAKE, acceptor.accept(tcp)).await else { return };
    // The peer's address rides along with each request: gxwid throttles logons
    // on it.
    let app = app.layer(Extension(ConnectInfo(peer)));
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADERS)
        .serve_connection(TokioIo::new(tls), TowerToHyperService::new(app))
        .with_upgrades()
        .await;
}

/// A request that came over plain HTTP, sent to the same address over HTTPS.
/// 301 rather than 308: what was posted has already crossed in the clear, and
/// is not to be posted again.
fn elsewhere<B>(request: &Request<B>) -> Response<Body> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .and_then(|host| host.parse::<Authority>().ok())
        .filter(|host| host.as_str().find('@').is_none());
    let mut response = Response::new(Body::empty());
    let headers = response.headers_mut();
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let location = host.and_then(|host| {
        let path = crate::logon::here(request.uri());
        HeaderValue::from_str(&format!("https://{host}{path}")).ok()
    });
    match location {
        Some(location) => {
            *response.status_mut() = StatusCode::MOVED_PERMANENTLY;
            response.headers_mut().insert(header::LOCATION, location);
        }
        None => *response.status_mut() = StatusCode::BAD_REQUEST,
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(host: Option<&str>, uri: &str) -> (StatusCode, Option<String>) {
        let mut request = Request::builder().uri(uri);
        if let Some(host) = host {
            request = request.header(header::HOST, host);
        }
        let response = elsewhere(&request.body(()).unwrap());
        let location = response.headers().get(header::LOCATION).map(|v| v.to_str().unwrap().to_string());
        (response.status(), location)
    }

    #[test]
    fn plain_http_is_sent_to_the_same_address_over_https() {
        assert_eq!(
            asked(Some("bedrock.lan:7780"), "/apps/terminal?tab=2"),
            (StatusCode::MOVED_PERMANENTLY, Some("https://bedrock.lan:7780/apps/terminal?tab=2".into()))
        );
        assert_eq!(asked(Some("10.0.2.15:7780"), "/"), (StatusCode::MOVED_PERMANENTLY, Some("https://10.0.2.15:7780/".into())));
        assert_eq!(asked(Some("[fe80::1]:7780"), "/"), (StatusCode::MOVED_PERMANENTLY, Some("https://[fe80::1]:7780/".into())));
    }

    #[test]
    fn the_way_to_https_stays_on_this_machine() {
        // A path that opens `//` names no other machine once moved.
        assert_eq!(asked(Some("box:7780"), "//evil.example/x").1.as_deref(), Some("https://box:7780/evil.example/x"));
        // Nor does a host with someone's name in front of it, or none at all.
        assert_eq!(asked(Some("evil.example@box:7780"), "/").0, StatusCode::BAD_REQUEST);
        assert_eq!(asked(Some("box/evil"), "/").0, StatusCode::BAD_REQUEST);
        assert_eq!(asked(None, "/").0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn a_handover_that_is_cut_short_is_refused() {
        assert!(acceptor(&[]).is_err());
        assert!(acceptor(&[10, 0, 0, 0, 1, 2]).is_err());
    }
}
