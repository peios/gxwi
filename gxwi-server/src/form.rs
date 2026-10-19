//! A posted form, read without leaving credentials lying about.
//!
//! PGSS binds a client to erase credential material from every buffer it
//! passed through, and gxwi-server is part of GXWI's client. A form extractor
//! would leave each password in ordinary strings, so the body is parsed by
//! hand into `Secret`s, which wipe themselves, and then wiped where it can be.
//!
//! This is best effort and no more. The buffers the HTTP stack read the body
//! through, and TLS's beneath them, are out of reach.

use axum::body::Bytes;

use auth_core::Secret;

/// The largest body a logon form may post: sixteen answers at PGSS's limit
/// would not fit, but no page of ours asks for that, and a body past this is
/// refused rather than truncated.
pub const MAX_BODY_BYTES: usize = 64 * 1024;

pub struct Form(Vec<(String, Secret)>);

impl Form {
    /// Parses `application/x-www-form-urlencoded`, then wipes the body if
    /// nothing else holds it. `None` if it is not well formed.
    pub fn parse(body: Bytes) -> Option<Form> {
        let fields = parse_fields(&body);
        if let Ok(mut body) = body.try_into_mut() {
            body.fill(0);
        }
        fields.map(Form)
    }

    pub fn has(&self, name: &str) -> bool {
        self.0.iter().any(|(n, _)| n == name)
    }

    /// Takes a field's value out of the form. Field names are ours; a name
    /// posted twice yields its first value.
    pub fn take(&mut self, name: &str) -> Option<Secret> {
        let at = self.0.iter().position(|(n, _)| n == name)?;
        Some(self.0.swap_remove(at).1)
    }

    /// A field that is not a credential, as text.
    pub fn take_text(&mut self, name: &str) -> Option<String> {
        let value = self.take(name)?;
        String::from_utf8(value.expose().to_vec()).ok()
    }
}

fn parse_fields(body: &[u8]) -> Option<Vec<(String, Secret)>> {
    let mut fields = Vec::new();
    for pair in body.split(|&b| b == b'&').filter(|p| !p.is_empty()) {
        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(at) => (&pair[..at], &pair[at + 1..]),
            None => (pair, &pair[..0]),
        };
        let name = decode(name)?;
        let name = String::from_utf8(name.expose().to_vec()).ok()?;
        fields.push((name, decode(value)?));
    }
    Some(fields)
}

/// Percent-decodes into a buffer sized before anything is written to it, so
/// no half-filled allocation is abandoned along the way.
fn decode(raw: &[u8]) -> Option<Secret> {
    let escapes = raw.iter().filter(|&&b| b == b'%').count();
    let mut out = Secret::zeroed(raw.len().checked_sub(escapes * 2)?);
    let mut bytes = raw.iter();
    for slot in out.expose_mut() {
        *slot = match *bytes.next()? {
            b'+' => b' ',
            b'%' => hex(*bytes.next()?)? << 4 | hex(*bytes.next()?)?,
            b => b,
        };
    }
    bytes.next().is_none().then_some(out)
}

fn hex(digit: u8) -> Option<u8> {
    (digit as char).to_digit(16).map(|d| d as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(body: &'static str) -> Option<Form> {
        Form::parse(Bytes::from_static(body.as_bytes()))
    }

    #[test]
    fn fields_are_decoded() {
        let mut form = form("username=alice&c1=p%40ss+word%21").unwrap();
        assert_eq!(form.take_text("username").as_deref(), Some("alice"));
        assert_eq!(form.take("c1").unwrap().expose(), b"p@ss word!");
        assert!(form.take("c1").is_none());
    }

    #[test]
    fn an_empty_value_and_a_bare_name_are_both_empty() {
        let mut form = form("a=&b").unwrap();
        assert_eq!(form.take("a").unwrap().expose(), b"");
        assert_eq!(form.take("b").unwrap().expose(), b"");
    }

    #[test]
    fn a_broken_escape_is_refused() {
        assert!(form("c1=%4").is_none());
        assert!(form("c1=%zz").is_none());
        assert!(form("c1=%").is_none());
    }

    #[test]
    fn a_credential_need_not_be_text() {
        let mut form = form("c1=%ff%00").unwrap();
        assert_eq!(form.take("c1").unwrap().expose(), &[0xff, 0x00]);
    }
}
