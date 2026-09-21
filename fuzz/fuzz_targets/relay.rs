//! Drives gxwid's logon relay with arbitrary messages from both sides, in any
//! order, and checks what must hold whatever arrives:
//!
//! - it never panics;
//! - what it sends the authority is a `LogonStart` of gxwid's choosing, or a
//!   credential response it was given;
//! - what it sends the server never carries a session id, a home or a shell;
//! - once finished, it stays finished.
//!
//!     cargo +nightly fuzz run relay
#![no_main]

use libauthd::wire::{self, CredentialType, LogonType};
use libfuzzer_sys::fuzz_target;

// gxwid is a binary, so the relay is taken by path. It needs only libauthd.
#[allow(dead_code)]
#[path = "../../gxwid/src/relay.rs"]
mod relay;
use relay::{Action, Outcome, Relay};

const TYPE: LogonType = LogonType::NetworkCleartext;

const TYPES: [u16; 6] = [
    wire::MSG_LOGON_START,
    wire::MSG_CREDENTIAL_RESPONSE,
    wire::MSG_CREDENTIAL_REQUEST,
    wire::MSG_ACCESS_GRANTED,
    wire::MSG_ACCESS_DENIED,
    0x7777,
];

/// One event per chunk: a flags byte, a length byte, then that many bytes.
/// Flag bit 0 picks the sender, bit 1 says a descriptor came along, and bit 2
/// wraps the bytes in a well-formed header so the decoders' bodies are reached
/// without the fuzzer first having to discover the framing.
fn events(mut data: &[u8]) -> Vec<(bool, bool, Vec<u8>)> {
    let mut out = Vec::new();
    while let [flags, len, rest @ ..] = data {
        let len = (*len as usize).min(rest.len());
        let (body, rest) = rest.split_at(len);
        data = rest;
        let message = if flags & 4 != 0 {
            let msg_type = TYPES[(flags >> 3) as usize % TYPES.len()];
            let mut m = Vec::with_capacity(12 + body.len());
            m.extend_from_slice(&wire::FRAMING.magic);
            m.extend_from_slice(&wire::FRAMING.version.to_le_bytes());
            m.extend_from_slice(&msg_type.to_le_bytes());
            m.extend_from_slice(&((12 + body.len()) as u32).to_le_bytes());
            m.extend_from_slice(body);
            m
        } else {
            body.to_vec()
        };
        out.push((flags & 1 != 0, flags & 2 != 0, message));
    }
    out
}

fuzz_target!(|data: &[u8]| {
    let mut relay = Relay::new(TYPE);
    let mut finished = false;
    for (from_authority, descriptor, message) in events(data) {
        let action = if from_authority {
            relay.on_authority(&message, descriptor)
        } else {
            relay.on_server(&message)
        };
        match action {
            Action::SendAuthority(bytes) => {
                assert!(!finished);
                let start = wire::decode_logon_start(&bytes).expect("a LogonStart");
                assert_eq!(start.logon_type, TYPE);
                assert_eq!(start.tty, None);
                assert_eq!(start.supported_credential_types, vec![CredentialType::Password]);
                assert!(!start.identifier.is_empty());
            }
            Action::ForwardToAuthority => {
                assert!(!finished && !from_authority);
                wire::decode_credential_response(&message).expect("a checked response");
            }
            Action::SendServer(bytes) => {
                assert!(!finished && from_authority);
                wire::decode_credential_request(&bytes).expect("a CredentialRequest");
            }
            Action::Finish { to_server, outcome } => {
                match outcome {
                    Outcome::Granted(_) => {
                        assert!(!finished && from_authority && descriptor);
                        let shown = wire::decode_access_granted(&to_server).expect("a grant");
                        assert_eq!(shown.session_id, 0);
                        assert!(shown.profile.home.is_empty() && shown.profile.shell.is_empty());
                    }
                    Outcome::Denied(_) => {
                        wire::decode_access_denied(&to_server).expect("a denial");
                    }
                }
                finished = true;
            }
        }
    }
});
