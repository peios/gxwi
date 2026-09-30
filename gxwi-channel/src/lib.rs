//! What gxwid and gxwi-server say to each other.
//!
//! There are three kinds of socket between them, and gxwid made them all.
//!
//! The **control channel** is the socket pair gxwi-server is started with. It
//! carries one request: open a logon conversation. gxwid answers with a fresh
//! socket dedicated to that conversation, or a refusal.
//!
//! The **overlay channel** is a second socket pair gxwi-server is started
//! with, and only gxwid speaks on it. It says where the overlay stands: that
//! there is none, that there is one and it cannot be reached, or that there is
//! one, with a socket to it. The first of these is written before gxwi-server
//! starts, so the server knows where the overlay stands before it serves
//! anything, and another follows whenever that changes. gxwi-server asks
//! nothing here and decides nothing: an overlay is the administrator's, read
//! from the registry by gxwid.
//!
//! A **conversation socket** carries exactly one logon, and speaks PGSS Logon
//! unchanged (`libauthd::wire`), with gxwid in the authority's role. No message
//! anywhere names a conversation: as in PGSS, the connection is the
//! conversation's identity, so there is no identifier to forge or confuse.
//!
//! Two things differ from a real authority, both because gxwid is a relay that
//! does not trust gxwi-server:
//!
//! - gxwid reads only `identifier` and `remote_host` from `LogonStart`. It
//!   chooses the logon type and the supported credential types itself, whatever
//!   the message says.
//! - `AccessGranted` arrives with no descriptor. The token stays in gxwid. Its
//!   `session_id` is zero and its profile carries a display name and nothing
//!   else.

use libauthd::frame::{self, Framing, WireError};

/// The control channel's framing: PGSS's header layout under its own magic, so
/// a control message can never be mistaken for a logon message or the reverse.
pub const CONTROL: Framing = Framing {
    magic: *b"GXWC",
    version: 1,
    header_bytes: frame::COMMON_HEADER_BYTES,
    max_message_bytes: 64,
};

/// gxwi-server → gxwid: open a logon conversation. No body.
pub const MSG_OPEN_CONVERSATION: u16 = 0x0001;
/// gxwid → gxwi-server: here it is. No body; the conversation socket rides
/// along as the message's descriptor.
pub const MSG_CONVERSATION: u16 = 0x8001;
/// gxwid → gxwi-server: not now, too many conversations are open. No body.
pub const MSG_REFUSED: u16 = 0x8002;

/// gxwid → gxwi-server, on the overlay channel: there is no overlay. No body.
pub const MSG_OVERLAY_NONE: u16 = 0x8011;
/// gxwid → gxwi-server, on the overlay channel: there is an overlay and it
/// cannot be reached, so nobody is to be shown anything else. No body.
pub const MSG_OVERLAY_UNAVAILABLE: u16 = 0x8012;
/// gxwid → gxwi-server, on the overlay channel: here is the overlay. No body;
/// a socket to it rides along as the message's descriptor.
pub const MSG_OVERLAY: u16 = 0x8013;

/// Encodes a control message. None of them has a body.
pub fn control_message(msg_type: u16) -> [u8; frame::COMMON_HEADER_BYTES] {
    let mut buf = [0u8; frame::COMMON_HEADER_BYTES];
    buf[0..4].copy_from_slice(&CONTROL.magic);
    buf[4..6].copy_from_slice(&CONTROL.version.to_le_bytes());
    buf[6..8].copy_from_slice(&msg_type.to_le_bytes());
    buf[8..12].copy_from_slice(&(frame::COMMON_HEADER_BYTES as u32).to_le_bytes());
    buf
}

/// The type of a received control message. A message with a body is refused:
/// no control message has one.
pub fn control_message_type(buf: &[u8]) -> Result<u16, WireError> {
    let (msg_type, total_len) = frame::decode_header(&CONTROL, buf)?;
    if total_len != frame::COMMON_HEADER_BYTES || buf.len() != total_len {
        return Err(WireError::TooLong);
    }
    Ok(msg_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_control_message_round_trips() {
        let buf = control_message(MSG_CONVERSATION);
        assert_eq!(control_message_type(&buf), Ok(MSG_CONVERSATION));
    }

    #[test]
    fn where_the_overlay_stands_round_trips() {
        for standing in [MSG_OVERLAY_NONE, MSG_OVERLAY_UNAVAILABLE, MSG_OVERLAY] {
            assert_eq!(control_message_type(&control_message(standing)), Ok(standing));
        }
    }

    #[test]
    fn a_logon_message_is_not_a_control_message() {
        let denied = libauthd::wire::encode_access_denied(&libauthd::wire::AccessDenied {
            denial: libauthd::wire::Denial::Internal,
            reason: String::new(),
        })
        .unwrap();
        assert_eq!(control_message_type(&denied), Err(WireError::BadMagic));
    }

    #[test]
    fn a_control_message_with_a_body_is_refused() {
        let mut buf = control_message(MSG_OPEN_CONVERSATION).to_vec();
        buf.push(0);
        buf[8..12].copy_from_slice(&13u32.to_le_bytes());
        assert!(control_message_type(&buf).is_err());
    }
}
