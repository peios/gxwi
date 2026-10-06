//! Logon, from the browser's side: a sequence of plain pages, each rendering
//! one round of the PGSS conversation gxwid relays to the authority.
//!
//! gxwi-server never sees a token and decides nothing about who may log on. It
//! asks gxwid for a conversation, speaks PGSS Logon on the socket it is given,
//! and turns each message into a page. A conversation in progress is held here
//! between the browser's requests, found again by a cookie.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, Request, Response, StatusCode, Uri};
use axum::routing::get;
use gxwi_channel::{CONTROL, MSG_CONVERSATION, MSG_OPEN_CONVERSATION};
use libauthd::transport::{recv_message_with_fd, send_message};
use libauthd::wire::{
    self, Answer, CredentialRequest, CredentialResponse, CredentialType, Denial, IdentifierType,
    LogonStart, LogonType,
};

use crate::form::{self, Form};
use crate::origin::{self, Origins};
use crate::overlay::{Overlay, Route};
use crate::pages;
use crate::session::{self, Sessions};

const COOKIE: &str = "gxwi-logon";

/// A person has 120 s to answer before the authority gives up on them. A
/// conversation nobody has touched for longer than that is dead already.
const ABANDONED_AFTER: Duration = Duration::from_secs(130);
/// gxwid answers once the authority has, and holds a denial a moment longer.
const GXWID_TIMEOUT: Duration = Duration::from_secs(60);
/// gxwid keeps its own, stricter count. This one only bounds the table.
const MAX_PENDING: usize = 64;

pub struct Logon {
    control: Mutex<UnixStream>,
    pending: Mutex<HashMap<String, Pending>>,
    sessions: Arc<Sessions>,
    origins: Origins,
    overlay: Arc<Overlay>,
}

/// A conversation waiting on the person at the browser.
struct Pending {
    conversation: UnixStream,
    /// Posted back by the form. A cookie alone would let another site's page
    /// submit this one.
    form_token: String,
    username: String,
    asked: CredentialRequest,
    since: Instant,
}

/// Where a conversation stands after a message from gxwid.
enum Step {
    Ask(CredentialRequest),
    Granted(String),
    Denied(Denial, String),
}

/// GXWI's own files live under `/.gxwi/` and every other path belongs to the
/// session. Logon has no path: whoever has no session is shown it wherever they
/// are, its forms post back to the same place, and so logging on leaves a
/// person where they were going without anything having to carry the address.
///
/// An overlay, while there is one, comes before all of it: every path that is
/// not GXWI's own is the overlay's, whoever asks and whether or not they have
/// a session. The sessions go on running behind it and are there when it goes.
pub fn routes(control: UnixStream, overlay: Arc<Overlay>) -> Router {
    let logon = Arc::new(Logon {
        control: Mutex::new(control),
        pending: Mutex::default(),
        sessions: Arc::default(),
        origins: Origins::default(),
        overlay,
    });
    Router::new()
        .route("/.gxwi/logon.css", get(|| async { asset("text/css; charset=utf-8", pages::STYLESHEET.as_bytes()) }))
        .route("/.gxwi/fonts/manrope.woff2", get(|| async { font(pages::FONT_TEXT) }))
        .route("/.gxwi/fonts/schibsted-grotesk.woff2", get(|| async { font(pages::FONT_DISPLAY) }))
        .route("/.gxwi/fonts/jetbrains-mono.woff2", get(|| async { font(pages::FONT_MONO) }))
        .route("/.gxwi/sw.js", get(|| async { worker() }))
        .route("/.gxwi/away", get(|| async { html(StatusCode::OK, pages::away(), None) }))
        .fallback(anywhere)
        .with_state(logon)
}

/// A request from someone with no session. Only a posted form moves a logon
/// along; anything else is shown the first page, as 401 so that a request a
/// page made for itself can tell it from an answer.
async fn anywhere(
    State(logon): State<Arc<Logon>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request<Body>,
) -> Response<Body> {
    match logon.overlay.route() {
        Route::Overlay(overlay) => return session::forward(overlay, request).await,
        Route::Unavailable => return overlay_unavailable(),
        Route::Behind => {}
    }
    // A page kept apart from the session it belongs to is sent no cookies, and
    // is known by its address. That comes first: the same address means the
    // same thing to a browser that happens to be logged on.
    if origin::inside(request.uri()).is_some() {
        return apart(&logon, request).await;
    }
    if let Some(session) = logon.sessions.of(request.headers()) {
        if let Some((label, path)) = origin::entering(request.uri()) {
            let cookie = cookie_named(request.headers(), session::COOKIE).unwrap_or_default();
            let alive = |cookie: &str| logon.sessions.named(cookie).is_some();
            return match logon.origins.secret(&cookie, label, alive) {
                Ok(secret) if request.method() == Method::GET => origin::way_in(&secret, path, request.uri().query()),
                _ => status(StatusCode::BAD_REQUEST),
            };
        }
        return session::forward(session, request).await;
    }
    if request.method() != Method::POST {
        return html(StatusCode::UNAUTHORIZED, pages::username(None), None);
    }
    let here = here(request.uri());
    let cookie = cookie_named(request.headers(), COOKIE);
    let Some(form) = read_form(request.into_body()).await else {
        return html(StatusCode::BAD_REQUEST, pages::username(Some("That form could not be read.")), None);
    };
    let result = if form.has(pages::FIELD_FORM_TOKEN) {
        answer(logon.clone(), cookie, form).await
    } else {
        start(logon.clone(), peer, form).await
    };
    respond(&logon, result, here).await
}

/// A request under a secret: for the one origin in the one session the secret
/// stands for, or for nothing.
async fn apart(logon: &Logon, mut request: Request<Body>) -> Response<Body> {
    let found = origin::inside(request.uri()).and_then(|(secret, path)| {
        let (cookie, label) = logon.origins.of(secret)?;
        let session = logon.sessions.named(&cookie)?;
        let asked = origin::unwrapped(path, request.uri().query())?;
        Some((session, HeaderValue::from_str(&label).ok()?, asked))
    });
    // Not the logon page: nobody is looking at this, a frame is.
    let Some((session, label, asked)) = found else { return status(StatusCode::NOT_FOUND) };
    if let Some(answer) = origin::asks_first(&request) {
        return answer;
    }
    *request.uri_mut() = asked;
    request.headers_mut().remove(header::COOKIE);
    request.extensions_mut().insert(origin::Label(label));
    let mut response = session::forward(session, request).await;
    origin::keep_apart(response.headers_mut());
    response
}

fn status(status: StatusCode) -> Response<Body> {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = status;
    response
}

/// How long a browser shown that the overlay is not available waits before it
/// asks again, in seconds. gxwid is trying to start it all the while.
const OVERLAY_RETRY: &str = "5";

/// What everyone is shown while there is an overlay that cannot be reached.
/// The page asks again by itself: whoever is looking at it is waiting for a
/// machine, and has nothing to do about it.
fn overlay_unavailable() -> Response<Body> {
    let mut response = html(StatusCode::SERVICE_UNAVAILABLE, pages::overlay_unavailable(), None);
    let headers = response.headers_mut();
    headers.insert(header::RETRY_AFTER, HeaderValue::from_static(OVERLAY_RETRY));
    headers.insert(header::REFRESH, HeaderValue::from_static(OVERLAY_RETRY));
    response
}

/// Where a request was addressed, as somewhere to send the browser back to
/// once it has a session. It is only ever the address the browser asked for,
/// but one that opens `//` would be read as naming another machine.
fn here(uri: &Uri) -> String {
    let asked = uri.path_and_query().map_or("/", |p| p.as_str());
    format!("/{}", asked.trim_start_matches(['/', '\\']))
}

/// The stylesheet and the fonts. The same bytes for everyone, so unlike the
/// pages they may be kept, for an hour: a new build is never stale for longer.
fn asset(content_type: &'static str, bytes: &'static [u8]) -> Response<Body> {
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    harden(headers);
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600"));
    response
}

/// A face, for any page at this address: the logon pages', a desktop's, and
/// an app's in a frame of its own, whose origin is nobody's and to which this
/// is a request from elsewhere. A browser fetches a face as such a request
/// asks to be let, and is let: the files are the same for everyone, and say
/// nothing about anyone.
fn font(bytes: &'static [u8]) -> Response<Body> {
    let mut response = asset("font/woff2", bytes);
    response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    response
}

/// The service worker, for the whole address: the pages it stands in for are
/// everywhere, a session's included. Under a policy of its own, since the
/// pages' lets nothing be fetched and fetching is all it does; and checked
/// for a new one at every load rather than kept.
fn worker() -> Response<Body> {
    let mut response = Response::new(Body::from(pages::WORKER));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/javascript; charset=utf-8"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(HeaderName::from_static("service-worker-allowed"), HeaderValue::from_static("/"));
    response
}

type Stepped = Result<io::Result<Page>, tokio::task::JoinError>;

async fn start(logon: Arc<Logon>, peer: SocketAddr, mut form: Form) -> Stepped {
    let username = form.take_text(pages::FIELD_USERNAME).unwrap_or_default();
    let username = username.trim().to_string();
    if username.is_empty() || username.len() > wire::MAX_IDENTIFIER_BYTES {
        return Ok(Ok(Page {
            status: StatusCode::UNAUTHORIZED,
            html: pages::username(Some("Enter your username.")),
            cookie: None,
            session: None,
        }));
    }
    tokio::task::spawn_blocking(move || {
        let conversation = logon.open(&username, &peer.ip().to_string())?;
        logon.advance(conversation, username)
    })
    .await
}

async fn answer(logon: Arc<Logon>, cookie: Option<String>, mut form: Form) -> Stepped {
    tokio::task::spawn_blocking(move || {
        let Some(cookie) = cookie else {
            return Err(io::Error::other("no conversation"));
        };
        // Taken out of the table, so a second submission of the same page
        // finds nothing rather than racing the first.
        let pending = logon.take(&cookie).ok_or_else(|| io::Error::other("no conversation"))?;
        let token = form.take_text(pages::FIELD_FORM_TOKEN).unwrap_or_default();
        if !same(token.as_bytes(), pending.form_token.as_bytes()) {
            return Err(io::Error::other("wrong form token"));
        }
        let answers = pending
            .asked
            .prompts
            .iter()
            // A prompt left unanswered is a failed logon, which is the
            // authority's to say, not a reason to refuse the form.
            .filter_map(|prompt| {
                let data = form.take(&pages::field_for_prompt(prompt.credential_ref))?;
                Some(Answer { credential_ref: prompt.credential_ref, data })
            })
            .collect();
        let response = wire::encode_credential_response(&CredentialResponse { answers })
            .map_err(|_| io::Error::other("answer too long"))?;
        send_message(&pending.conversation, response.expose())?;
        logon.advance(pending.conversation, pending.username)
    })
    .await
}

/// What a finished step of the conversation looks like to the browser.
struct Page {
    /// 401 until someone is logged on, whatever the page says.
    status: StatusCode,
    html: String,
    /// `Some(None)` clears the cookie; `Some(Some(id))` sets it.
    cookie: Option<Option<String>>,
    /// What came with a grant: a socket to the session's compositor.
    session: Option<UnixStream>,
}

async fn respond(logon: &Logon, result: Stepped, here: String) -> Response<Body> {
    match result {
        Ok(Ok(Page { session: Some(socket), .. })) => match begin(logon, socket, &here).await {
            Ok(response) => response,
            Err(e) => {
                eprintln!("gxwi-server: session: {e}");
                let page = pages::unavailable("You were signed in, but your session could not be reached.");
                html(StatusCode::BAD_GATEWAY, page, Some(None))
            }
        },
        Ok(Ok(page)) => html(page.status, page.html, page.cookie),
        Ok(Err(e)) => {
            eprintln!("gxwi-server: logon: {e}");
            let page = pages::unavailable("That sign-in could not be continued. Start again.");
            html(StatusCode::UNAUTHORIZED, page, Some(None))
        }
        Err(_) => html(StatusCode::INTERNAL_SERVER_ERROR, pages::unavailable("Sign-in failed."), Some(None)),
    }
}

/// Turns a granted logon into a session: a cookie for the socket, and the
/// browser sent back to where it was, which now answers as the session.
async fn begin(logon: &Logon, socket: UnixStream, here: &str) -> io::Result<Response<Body>> {
    let id = random_token()?;
    logon.sessions.adopt(id.clone(), socket).await?;
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    let headers = response.headers_mut();
    harden(headers);
    headers.insert(header::LOCATION, HeaderValue::from_str(here).map_err(io::Error::other)?);
    // Lax, where logon's own cookie is Strict: a link followed from another
    // site should land in the session, not on a logon page. No `Secure` on
    // either until there is TLS to be secure over.
    let session = format!("{}={id}; Path=/; HttpOnly; SameSite=Lax", session::COOKIE);
    headers.append(header::SET_COOKIE, HeaderValue::from_str(&session).map_err(io::Error::other)?);
    let spent = format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    headers.append(header::SET_COOKIE, HeaderValue::from_str(&spent).map_err(io::Error::other)?);
    Ok(response)
}

impl Logon {
    /// Asks gxwid for a conversation and opens it.
    fn open(&self, username: &str, claimed_address: &str) -> io::Result<UnixStream> {
        let conversation = {
            let control = self.control.lock().unwrap_or_else(|e| e.into_inner());
            send_message(&control, &gxwi_channel::control_message(MSG_OPEN_CONVERSATION))?;
            let (reply, descriptor) = recv_message_with_fd(&CONTROL, &control)?;
            match (gxwi_channel::control_message_type(reply.expose()), descriptor) {
                (Ok(MSG_CONVERSATION), Some(descriptor)) => UnixStream::from(descriptor),
                _ => return Err(io::Error::other("gxwid refused a conversation")),
            }
        };
        conversation.set_read_timeout(Some(GXWID_TIMEOUT))?;
        conversation.set_write_timeout(Some(GXWID_TIMEOUT))?;
        let start = LogonStart {
            required_credential_type: None,
            ssh_binding: None,
            // gxwid settles these two itself, whatever is written here.
            logon_type: LogonType::RemoteInteractive,
            supported_credential_types: vec![CredentialType::Password],
            identifier_type: IdentifierType::Username,
            identifier: username.as_bytes().to_vec(),
            tty: None,
            remote_host: Some(claimed_address.to_string()),
        };
        let start = wire::encode_logon_start(&start).map_err(|_| io::Error::other("bad username"))?;
        send_message(&conversation, &start)?;
        Ok(conversation)
    }

    /// Reads gxwid's next message and renders where that leaves the logon.
    fn advance(&self, conversation: UnixStream, username: String) -> io::Result<Page> {
        // A grant brings a descriptor, as PGSS has it. Here gxwid stands where
        // the authority would, and what it attaches is not a token but a
        // socket to the session the token was spent on.
        let (message, descriptor) = recv_message_with_fd(&wire::FRAMING, &conversation)?;
        let bad = |_| io::Error::other("gxwid sent something unreadable");
        let step = match wire::decode_header(message.expose()).map_err(bad)?.0 {
            wire::MSG_CREDENTIAL_REQUEST => {
                Step::Ask(wire::decode_credential_request(message.expose()).map_err(bad)?)
            }
            wire::MSG_ACCESS_GRANTED => {
                let granted = wire::decode_access_granted(message.expose()).map_err(bad)?;
                Step::Granted(granted.profile.display_name)
            }
            wire::MSG_ACCESS_DENIED => {
                let denied = wire::decode_access_denied(message.expose()).map_err(bad)?;
                Step::Denied(denied.denial, denied.reason)
            }
            _ => return Err(io::Error::other("gxwid sent something unexpected")),
        };
        Ok(match step {
            Step::Ask(asked) => {
                let (id, form_token) = (random_token()?, random_token()?);
                let html = pages::ask(&username, &form_token, &asked);
                self.keep(id.clone(), Pending {
                    conversation,
                    form_token,
                    username,
                    asked,
                    since: Instant::now(),
                })?;
                Page { status: StatusCode::UNAUTHORIZED, html, cookie: Some(Some(id)), session: None }
            }
            // A grant with no socket is a logon that led nowhere, and the page
            // says so. With one, the page is never shown.
            Step::Granted(display_name) => {
                let name = if display_name.is_empty() { username } else { display_name };
                Page {
                    status: StatusCode::OK,
                    html: pages::granted(&name),
                    cookie: Some(None),
                    session: descriptor.map(UnixStream::from),
                }
            }
            Step::Denied(denial, reason) => Page {
                status: StatusCode::UNAUTHORIZED,
                html: pages::denied(denial, &reason),
                cookie: Some(None),
                session: None,
            },
        })
    }

    fn keep(&self, id: String, pending: Pending) -> io::Result<()> {
        let mut table = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        // Dropping a conversation closes its socket, which is how gxwid hears.
        table.retain(|_, p| p.since.elapsed() < ABANDONED_AFTER);
        if table.len() >= MAX_PENDING {
            return Err(io::Error::other("too many conversations in progress"));
        }
        table.insert(id, pending);
        Ok(())
    }

    fn take(&self, id: &str) -> Option<Pending> {
        let mut table = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let pending = table.remove(id)?;
        (pending.since.elapsed() < ABANDONED_AFTER).then_some(pending)
    }
}

async fn read_form(body: Body) -> Option<Form> {
    let body = axum::body::to_bytes(body, form::MAX_BODY_BYTES).await.ok()?;
    Form::parse(body)
}

pub fn cookie_named(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(name)?.strip_prefix('='))
        .map(str::to_string)
}

/// 256 bits from the kernel, as hex. The restricted token can open no file, so
/// this is the system call and not /dev/urandom.
pub fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    // SAFETY: the buffer is ours and its length is passed with it.
    let got = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if got != bytes.len() as isize {
        return Err(io::Error::last_os_error());
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Compares without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn html(status: StatusCode, page: String, cookie: Option<Option<String>>) -> Response<Body> {
    let mut response = Response::new(Body::from(page));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    if let Some(cookie) = cookie {
        // No `Secure` until there is TLS to be secure over.
        let value = match cookie {
            Some(id) => format!("{COOKIE}={id}; Path=/; HttpOnly; SameSite=Strict"),
            None => format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
        };
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(header::SET_COOKIE, value);
        }
    }
    harden(headers);
    response
}

/// The one script named is `pages::SCRIPT`, by hash rather than as `'self'`:
/// this origin will come to serve sessions too, and none of that may run here.
/// It may register the service worker, and ask this address whether the
/// machine is there, as the waiting page does.
const POLICY: &str = "default-src 'none'; style-src 'self'; font-src 'self'; \
    script-src 'sha256-HV3Ol8Z8htrv2p7QsSWnLYz0l8OY1TC6riqm00p5iyo='; \
    connect-src 'self'; worker-src 'self'; \
    form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/// One script, no framing, nothing kept: these pages take passwords.
fn harden(headers: &mut HeaderMap) {
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(POLICY));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_logon_cookie_is_found_among_others() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("a=1; gxwi-logon=abc123; b=2"));
        assert_eq!(cookie_named(&headers, COOKIE).as_deref(), Some("abc123"));
    }

    #[test]
    fn a_cookie_that_only_starts_the_same_is_not_ours() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("gxwi-logon-other=abc123"));
        assert_eq!(cookie_named(&headers, COOKIE), None);
    }

    #[test]
    fn the_way_back_is_always_on_this_machine() {
        let back = |uri: &str| here(&uri.parse().unwrap());
        assert_eq!(back("/apps/terminal?tab=2"), "/apps/terminal?tab=2");
        assert_eq!(back("/"), "/");
        assert_eq!(back("//evil.example/x"), "/evil.example/x");
        assert_eq!(back("///evil.example"), "/evil.example");
    }

    /// Pins the hash in the policy to the script, as the browser computes it:
    /// SHA-256 of the bytes between the tags, in base64.
    #[test]
    fn the_policy_names_the_script_the_pages_carry() {
        use sha2::{Digest, Sha256};
        let hash = session::base64(&Sha256::digest(pages::SCRIPT.as_bytes()));
        assert!(POLICY.contains(&format!("script-src 'sha256-{hash}';")), "the script is now sha256-{hash}");
        assert!(!pages::SCRIPT.contains("</"), "the script is inlined, and must not close its own tag");
    }

    #[test]
    fn tokens_are_long_and_differ() {
        let (a, b) = (random_token().unwrap(), random_token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
