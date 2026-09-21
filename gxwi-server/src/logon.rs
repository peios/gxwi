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
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Response, StatusCode};
use axum::routing::get;
use gxwi_channel::{CONTROL, MSG_CONVERSATION, MSG_OPEN_CONVERSATION};
use libauthd::transport::{recv_message, recv_message_with_fd, send_message};
use libauthd::wire::{
    self, Answer, CredentialRequest, CredentialResponse, CredentialType, Denial, IdentifierType,
    LogonStart, LogonType,
};

use crate::form::{self, Form};
use crate::pages;

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

pub fn routes(control: UnixStream) -> Router {
    let logon = Arc::new(Logon { control: Mutex::new(control), pending: Mutex::default() });
    Router::new()
        .route("/", get(|| async { redirect("/logon") }))
        .route("/logon", get(username_page).post(start))
        .route("/logon/answer", axum::routing::post(answer))
        .route("/logon.css", get(stylesheet))
        .with_state(logon)
}

async fn username_page() -> Response<Body> {
    html(StatusCode::OK, pages::username(None), None)
}

async fn stylesheet() -> Response<Body> {
    let mut response = Response::new(Body::from(pages::STYLESHEET));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/css; charset=utf-8"));
    harden(response.headers_mut());
    response
}

async fn start(
    State(logon): State<Arc<Logon>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Body,
) -> Response<Body> {
    let Some(mut form) = read_form(body).await else {
        return html(StatusCode::BAD_REQUEST, pages::username(Some("That form could not be read.")), None);
    };
    let username = form.take_text(pages::FIELD_USERNAME).unwrap_or_default();
    let username = username.trim().to_string();
    if username.is_empty() || username.len() > wire::MAX_IDENTIFIER_BYTES {
        return html(StatusCode::OK, pages::username(Some("Enter your username.")), None);
    }
    let result = tokio::task::spawn_blocking(move || {
        let conversation = logon.open(&username, &peer.ip().to_string())?;
        logon.advance(conversation, username)
    })
    .await;
    respond(result)
}

async fn answer(State(logon): State<Arc<Logon>>, headers: HeaderMap, body: Body) -> Response<Body> {
    let cookie = cookie(&headers);
    let form = read_form(body).await;
    let result = tokio::task::spawn_blocking(move || {
        let (Some(cookie), Some(mut form)) = (cookie, form) else {
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
    .await;
    respond(result)
}

/// What a finished step of the conversation looks like to the browser.
struct Page {
    html: String,
    /// `Some(None)` clears the cookie; `Some(Some(id))` sets it.
    cookie: Option<Option<String>>,
}

fn respond(result: Result<io::Result<Page>, tokio::task::JoinError>) -> Response<Body> {
    match result {
        Ok(Ok(page)) => html(StatusCode::OK, page.html, page.cookie),
        Ok(Err(e)) => {
            eprintln!("gxwi-server: logon: {e}");
            let page = pages::unavailable("That sign-in could not be continued. Start again.");
            html(StatusCode::OK, page, Some(None))
        }
        Err(_) => html(StatusCode::INTERNAL_SERVER_ERROR, pages::unavailable("Sign-in failed."), Some(None)),
    }
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
            // gxwid settles these two itself, whatever is written here.
            logon_type: LogonType::NetworkCleartext,
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
        let message = recv_message(&wire::FRAMING, &conversation)?;
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
                Page { html, cookie: Some(Some(id)) }
            }
            Step::Granted(display_name) => {
                let name = if display_name.is_empty() { username } else { display_name };
                Page { html: pages::granted(&name), cookie: Some(None) }
            }
            Step::Denied(denial, reason) => {
                Page { html: pages::denied(denial, &reason), cookie: Some(None) }
            }
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

fn cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(COOKIE)?.strip_prefix('='))
        .map(str::to_string)
}

/// 256 bits from the kernel, as hex. The restricted token can open no file, so
/// this is the system call and not /dev/urandom.
fn random_token() -> io::Result<String> {
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

fn redirect(to: &'static str) -> Response<Body> {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    response.headers_mut().insert(header::LOCATION, HeaderValue::from_static(to));
    harden(response.headers_mut());
    response
}

fn html(status: StatusCode, page: String, cookie: Option<Option<String>>) -> Response<Body> {
    let mut response = Response::new(Body::from(page));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    if let Some(cookie) = cookie {
        // No `Secure` until there is TLS to be secure over.
        let value = match cookie {
            Some(id) => format!("{COOKIE}={id}; Path=/logon; HttpOnly; SameSite=Strict"),
            None => format!("{COOKIE}=; Path=/logon; HttpOnly; SameSite=Strict; Max-Age=0"),
        };
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(header::SET_COOKIE, value);
        }
    }
    harden(headers);
    response
}

/// No script, no framing, nothing kept: these pages take passwords.
fn harden(headers: &mut HeaderMap) {
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
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
        assert_eq!(cookie(&headers).as_deref(), Some("abc123"));
    }

    #[test]
    fn a_cookie_that_only_starts_the_same_is_not_ours() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("gxwi-logon-other=abc123"));
        assert_eq!(cookie(&headers), None);
    }

    #[test]
    fn tokens_are_long_and_differ() {
        let (a, b) = (random_token().unwrap(), random_token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
