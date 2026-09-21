//! Origins: how what runs inside a session is kept apart in the browser.
//!
//! A compositor shows pages that are not its own, an app's for one, and a
//! browser keeps two pages apart only if they have different origins. GXWI has
//! one name and one port, and cannot count on more: a machine reached by its
//! address has no names to spare, and one reached through a tunnel has one
//! port. So such a page gets an origin that needs neither. It is served
//! sandboxed, which gives it an origin of its own that matches nothing, not
//! even another page from the same place.
//!
//! A page like that is sent no cookies, so its requests cannot be known by the
//! session's cookie. They are known by their address instead:
//!
//!   /.gxwi/enter/<label>/<path>   asked for with the session's cookie, by a
//!                                 frame the compositor's page made. Answers
//!                                 with the way to:
//!   /.gxwi/a/<secret>/<path>      which needs no cookie. The secret stands
//!                                 for one label in one session and nothing
//!                                 else, and lasts as long as the session.
//!
//! The label is the compositor's word for whatever it keeps apart, and means
//! nothing here. Every request under a secret reaches the compositor with its
//! path as the page wrote it and the label in `gxwi-origin`, which a browser
//! cannot set: it is taken off everything else that goes into a session.
//!
//! What is served under `/.gxwi/a/` is sandboxed whatever the compositor says,
//! because it is on GXWI's own name, where the logon page is. The sandbox is
//! also why it is safe to let any page read these answers: that protects what
//! a browser sends on its own say-so, and here it sends nothing.

use std::collections::HashMap;
use std::io;
use std::sync::Mutex;

use axum::body::Body;
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, Request, Response, StatusCode, Uri};

pub const ENTER: &str = "/.gxwi/enter/";
pub const INSIDE: &str = "/.gxwi/a/";
pub const LABEL_HEADER: HeaderName = HeaderName::from_static("gxwi-origin");

/// The most a page under a secret may be allowed: scripts and what pages
/// ordinarily do, never the origin it was served from, and never the power to
/// send the whole tab somewhere else. A compositor may allow less.
const SANDBOX: &str = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock";

/// Bounds the table. A session's labels are as many as it has apps.
const MAX_SECRETS: usize = 4096;

/// Which label a request going into a session is for.
#[derive(Clone)]
pub struct Label(pub HeaderValue);

#[derive(Default)]
pub struct Origins(Mutex<Table>);

#[derive(Default)]
struct Table {
    /// secret → (the session's cookie, label)
    by_secret: HashMap<String, (String, String)>,
    by_owner: HashMap<(String, String), String>,
}

impl Origins {
    /// The secret for `label` in the session `cookie` names, made if this is
    /// the first time. `alive` says whether a cookie still names a session.
    pub fn secret(&self, cookie: &str, label: &str, alive: impl Fn(&str) -> bool) -> io::Result<String> {
        let mut table = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let owner = (cookie.to_string(), label.to_string());
        if let Some(secret) = table.by_owner.get(&owner) {
            return Ok(secret.clone());
        }
        if table.by_secret.len() >= MAX_SECRETS {
            table.by_secret.retain(|_, (cookie, _)| alive(cookie));
            table.by_owner.retain(|(cookie, _), _| alive(cookie));
            if table.by_secret.len() >= MAX_SECRETS {
                return Err(io::Error::other("too many origins"));
            }
        }
        let secret = crate::logon::random_token()?;
        table.by_secret.insert(secret.clone(), owner.clone());
        table.by_owner.insert(owner, secret.clone());
        Ok(secret)
    }

    /// The session's cookie and the label a secret stands for.
    pub fn of(&self, secret: &str) -> Option<(String, String)> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).by_secret.get(secret).cloned()
    }
}

/// `/.gxwi/enter/<label>/<path>` as (label, path), if it is one.
pub fn entering(uri: &Uri) -> Option<(&str, &str)> {
    let (label, path) = split(uri.path().strip_prefix(ENTER)?)?;
    let plain = (8..=64).contains(&label.len()) && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    (plain && !path.starts_with("//")).then_some((label, path))
}

/// `/.gxwi/a/<secret>/<path>` as (secret, path), if it is one.
pub fn inside(uri: &Uri) -> Option<(&str, &str)> {
    split(uri.path().strip_prefix(INSIDE)?)
}

/// "name/rest" as ("name", "/rest"). A page's own addresses are written
/// relative to where it is, so where it is has to end in a path.
fn split(after: &str) -> Option<(&str, &str)> {
    let at = after.find('/')?;
    (at > 0).then(|| (&after[..at], &after[at..]))
}

/// Where a frame is sent once it may come in.
pub fn way_in(secret: &str, path: &str, query: Option<&str>) -> Response<Body> {
    let query = query.map(|q| format!("?{q}")).unwrap_or_default();
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    let headers = response.headers_mut();
    if let Ok(to) = HeaderValue::from_str(&format!("{INSIDE}{secret}{path}{query}")) {
        headers.insert(header::LOCATION, to);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

/// A sandboxed page asking its own server for something is, to the browser,
/// one site asking another, and the browser asks first whether it may. It
/// may: the address is the permission.
pub fn asks_first(request: &Request<Body>) -> Option<Response<Body>> {
    let headers = request.headers();
    let wanted = headers.get(header::ACCESS_CONTROL_REQUEST_METHOD)?;
    if request.method() != Method::OPTIONS {
        return None;
    }
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let out = response.headers_mut();
    out.insert(header::ACCESS_CONTROL_ALLOW_METHODS, wanted.clone());
    if let Some(named) = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
        out.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, named.clone());
    }
    out.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    keep_apart(out);
    Some(response)
}

/// Put on every answer from under a secret, after the compositor has had its
/// say. Policies add up, so whatever the compositor sent still holds too.
pub fn keep_apart(headers: &mut HeaderMap) {
    headers.append(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(SANDBOX));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
}

/// The address a compositor is asked for: the page's own, with nothing of
/// how it was reached.
pub fn unwrapped(path: &str, query: Option<&str>) -> Option<Uri> {
    match query {
        Some(query) => format!("{path}?{query}").parse().ok(),
        None => path.parse().ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_way_in_names_a_label_and_a_path() {
        let of = |uri: &'static str| uri.parse::<Uri>().ok().and_then(|u| entering(&u).map(|(l, p)| (l.to_string(), p.to_string())));
        assert_eq!(of("/.gxwi/enter/abcdef0123/editor/live?x=1"), Some(("abcdef0123".into(), "/editor/live".into())));
        assert_eq!(of("/.gxwi/enter/abcdef0123/"), Some(("abcdef0123".into(), "/".into())));
        assert_eq!(of("/.gxwi/enter/abcdef0123"), None, "nowhere for the page's own addresses to be relative to");
        assert_eq!(of("/.gxwi/enter/short/"), None);
        assert_eq!(of("/.gxwi/enter/Not-Plain-Enough/"), None);
        assert_eq!(of("/.gxwi/enter/abcdef0123//elsewhere"), None);
        assert_eq!(of("/elsewhere/.gxwi/enter/abcdef0123/"), None);
    }

    #[test]
    fn a_secret_is_one_label_in_one_session() {
        let origins = Origins::default();
        let a = origins.secret("cookie-1", "label-a", |_| true).unwrap();
        assert_eq!(origins.secret("cookie-1", "label-a", |_| true).unwrap(), a, "the same place every time");
        assert_ne!(origins.secret("cookie-1", "label-b", |_| true).unwrap(), a);
        assert_ne!(origins.secret("cookie-2", "label-a", |_| true).unwrap(), a);
        assert_eq!(origins.of(&a), Some(("cookie-1".into(), "label-a".into())));
        assert_eq!(origins.of("anything else"), None);
    }

    #[test]
    fn what_is_served_under_a_secret_is_always_sandboxed() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'"));
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("https://elsewhere.example"));
        keep_apart(&mut headers);
        let policies: Vec<_> = headers.get_all(header::CONTENT_SECURITY_POLICY).iter().collect();
        assert_eq!(policies.len(), 2, "the compositor's policy is kept, and GXWI's added");
        assert!(policies[1].to_str().unwrap().starts_with("sandbox "));
        assert!(!SANDBOX.contains("allow-same-origin") && !SANDBOX.contains("allow-top-navigation"));
        assert_eq!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(), "*");
    }
}
