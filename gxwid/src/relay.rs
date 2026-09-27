//! One logon conversation, relayed: the decisions, with no I/O.
//!
//! gxwid stands between gxwi-server, which it does not trust, and the
//! authority, which it does. Towards the server it plays PGSS's authority;
//! towards the authority it is an ordinary client. The protocol is strictly
//! turn-taking, so the relay is a small state machine: hand it the message
//! that arrived, and it says what to send and whom to read next.
//!
//! Everything from the server is a claim. The relay takes two things from its
//! `LogonStart` — who is logging on, and where the server says they are — and
//! settles the rest itself. It never lets a token descriptor pass.

use libauthd::wire::{
    self, AccessDenied, AccessGranted, CredentialType, Denial, IdentifierType, LogonStart,
    LogonType, Profile,
};

/// What the driver does next.
#[derive(Debug)]
pub enum Action {
    /// Send this to the authority, then read from the authority.
    SendAuthority(Vec<u8>),
    /// Send the server's message, exactly as it arrived, to the authority, then
    /// read from the authority. It is a credential response the relay has
    /// checked; forwarding the original spares the credential another copy.
    ForwardToAuthority,
    /// Send this to the server, then read from the server.
    SendServer(Vec<u8>),
    /// Send this to the server and stop. The conversation is over.
    Finish { to_server: Vec<u8>, outcome: Outcome },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The authority granted the logon; the driver holds the token.
    Granted(Profile),
    /// The authority, or the relay, refused it.
    Denied(Denial),
}

#[derive(Debug)]
enum State {
    AwaitStart,
    AwaitAuthority,
    /// The server owes answers to the prompts with these references.
    AwaitAnswer(Vec<u32>),
    Done,
}

#[derive(Debug)]
pub struct Relay {
    state: State,
    logon_type: LogonType,
    claimed_address: Option<String>,
}

impl Relay {
    pub fn new(logon_type: LogonType) -> Self {
        Relay { state: State::AwaitStart, logon_type, claimed_address: None }
    }

    /// Where gxwi-server says the user is, once a `LogonStart` has said so.
    pub fn claimed_address(&self) -> Option<&str> {
        self.claimed_address.as_deref()
    }

    /// A message from gxwi-server.
    pub fn on_server(&mut self, message: &[u8]) -> Action {
        match std::mem::replace(&mut self.state, State::Done) {
            State::AwaitStart => self.start(message),
            State::AwaitAnswer(prompts) => self.answer(message, &prompts),
            // The driver reads from the server only when it is the server's
            // turn, so this is a driver bug rather than a hostile peer.
            State::AwaitAuthority | State::Done => deny(Denial::Internal),
        }
    }

    /// A message from the authority. `descriptor` says whether one came with it.
    pub fn on_authority(&mut self, message: &[u8], descriptor: bool) -> Action {
        match std::mem::replace(&mut self.state, State::Done) {
            State::AwaitAuthority => self.from_authority(message, descriptor),
            _ => deny(Denial::Internal),
        }
    }

    fn start(&mut self, message: &[u8]) -> Action {
        let Ok((wire::MSG_LOGON_START, _)) = wire::decode_header(message) else {
            return deny(Denial::MalformedRequest);
        };
        let Ok(claimed) = wire::decode_logon_start(message) else {
            return deny(Denial::MalformedRequest);
        };
        // With passwords the only credential, a logon for nobody in
        // particular has nothing to authenticate.
        if claimed.identifier.is_empty() {
            return deny(Denial::MalformedRequest);
        }
        self.claimed_address = claimed.remote_host.clone();
        let start = LogonStart {
            logon_type: self.logon_type,
            identifier_type: IdentifierType::Username,
            identifier: claimed.identifier,
            tty: None,
            // Still a claim, and passed on as one: PGSS gives the authority
            // `remote_host` as unverified context.
            remote_host: claimed.remote_host,
            // What gxwi-server's pages can collect. This binds the authority.
            supported_credential_types: vec![CredentialType::Password],
        };
        match wire::encode_logon_start(&start) {
            Ok(bytes) => {
                self.state = State::AwaitAuthority;
                Action::SendAuthority(bytes)
            }
            Err(_) => deny(Denial::MalformedRequest),
        }
    }

    fn answer(&mut self, message: &[u8], prompts: &[u32]) -> Action {
        let Ok((wire::MSG_CREDENTIAL_RESPONSE, _)) = wire::decode_header(message) else {
            return deny(Denial::MalformedRequest);
        };
        // Decoded to be checked, then dropped: its answers wipe themselves.
        let Ok(response) = wire::decode_credential_response(message) else {
            return deny(Denial::MalformedRequest);
        };
        let mut seen = Vec::with_capacity(response.answers.len());
        for answer in &response.answers {
            let asked = prompts.contains(&answer.credential_ref);
            if !asked || seen.contains(&answer.credential_ref) {
                return deny(Denial::MalformedRequest);
            }
            seen.push(answer.credential_ref);
        }
        self.state = State::AwaitAuthority;
        Action::ForwardToAuthority
    }

    fn from_authority(&mut self, message: &[u8], descriptor: bool) -> Action {
        let Ok((msg_type, _)) = wire::decode_header(message) else {
            return deny(Denial::AuthorityUnavailable);
        };
        match msg_type {
            wire::MSG_CREDENTIAL_REQUEST => {
                let Ok(request) = wire::decode_credential_request(message) else {
                    return deny(Denial::AuthorityUnavailable);
                };
                let prompts = request.prompts.iter().map(|p| p.credential_ref).collect();
                match wire::encode_credential_request(&request) {
                    Ok(bytes) => {
                        self.state = State::AwaitAnswer(prompts);
                        Action::SendServer(bytes)
                    }
                    Err(_) => deny(Denial::AuthorityUnavailable),
                }
            }
            wire::MSG_ACCESS_GRANTED => {
                let Ok(granted) = wire::decode_access_granted(message) else {
                    return deny(Denial::AuthorityUnavailable);
                };
                // PGSS: a grant with no descriptor is a failed logon.
                if !descriptor {
                    return deny(Denial::AuthorityUnavailable);
                }
                // The server learns that it worked and what to call the user.
                // Not the session, not the home directory, not the token.
                let shown = AccessGranted {
                    session_id: 0,
                    profile: Profile {
                        display_name: granted.profile.display_name.clone(),
                        ..Profile::default()
                    },
                };
                match wire::encode_access_granted(&shown) {
                    Ok(to_server) => {
                        Action::Finish { to_server, outcome: Outcome::Granted(granted.profile) }
                    }
                    Err(_) => deny(Denial::Internal),
                }
            }
            wire::MSG_ACCESS_DENIED => {
                let Ok(denied) = wire::decode_access_denied(message) else {
                    return deny(Denial::AuthorityUnavailable);
                };
                match wire::encode_access_denied(&denied) {
                    Ok(to_server) => {
                        Action::Finish { to_server, outcome: Outcome::Denied(denied.denial) }
                    }
                    Err(_) => deny(Denial::Internal),
                }
            }
            _ => deny(Denial::AuthorityUnavailable),
        }
    }
}

/// A denial that is the relay's own. It carries no reason: a reason is for the
/// user to read, and these are not the user's doing.
pub fn deny(denial: Denial) -> Action {
    let to_server = wire::encode_access_denied(&AccessDenied { denial, reason: String::new() })
        .expect("an access denial with no reason always encodes");
    Action::Finish { to_server, outcome: Outcome::Denied(denial) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libauthd::Secret;
    use libauthd::wire::{Answer, CredentialRequest, CredentialResponse, Prompt};

    const TYPE: LogonType = LogonType::RemoteInteractive;

    fn start(identifier: &str) -> Vec<u8> {
        wire::encode_logon_start(&LogonStart {
            // Everything but the identifier and the host is there to be ignored.
            logon_type: LogonType::Service,
            identifier_type: IdentifierType::Username,
            identifier: identifier.as_bytes().to_vec(),
            tty: Some("tty9".into()),
            remote_host: Some("203.0.113.7".into()),
            supported_credential_types: vec![],
        })
        .unwrap()
    }

    fn request(refs: &[u32]) -> Vec<u8> {
        wire::encode_credential_request(&CredentialRequest {
            messages: vec![],
            prompts: refs
                .iter()
                .map(|&credential_ref| Prompt {
                    credential_ref,
                    credential_type: CredentialType::Password,
                    credential_name: "Password".into(),
                })
                .collect(),
        })
        .unwrap()
    }

    fn response(refs: &[u32]) -> Secret {
        wire::encode_credential_response(&CredentialResponse {
            answers: refs
                .iter()
                .map(|&credential_ref| Answer { credential_ref, data: Secret::from_slice(b"pw") })
                .collect(),
        })
        .unwrap()
    }

    fn granted() -> Vec<u8> {
        wire::encode_access_granted(&AccessGranted {
            session_id: 1003,
            profile: Profile {
                home: "/home/alice".into(),
                shell: "/bin/sh".into(),
                display_name: "Alice".into(),
            },
        })
        .unwrap()
    }

    fn denied_with(action: Action) -> Denial {
        match action {
            Action::Finish { outcome: Outcome::Denied(d), .. } => d,
            other => panic!("expected a denial, got {other:?}"),
        }
    }

    #[test]
    fn the_relay_settles_everything_the_server_may_not_choose() {
        let mut relay = Relay::new(TYPE);
        let Action::SendAuthority(bytes) = relay.on_server(&start("alice")) else { panic!() };
        let sent = wire::decode_logon_start(&bytes).unwrap();
        assert_eq!(sent.logon_type, TYPE);
        assert_eq!(sent.tty, None);
        assert_eq!(sent.supported_credential_types, vec![CredentialType::Password]);
        assert_eq!(sent.identifier, b"alice");
        assert_eq!(sent.remote_host.as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn a_grant_reaches_the_server_stripped() {
        let mut relay = Relay::new(TYPE);
        relay.on_server(&start("alice"));
        let Action::SendServer(_) = relay.on_authority(&request(&[1]), false) else { panic!() };
        let Action::ForwardToAuthority = relay.on_server(response(&[1]).expose()) else { panic!() };
        let Action::Finish { to_server, outcome } = relay.on_authority(&granted(), true) else {
            panic!()
        };
        let shown = wire::decode_access_granted(&to_server).unwrap();
        assert_eq!(shown.session_id, 0);
        assert_eq!(shown.profile.display_name, "Alice");
        assert_eq!(shown.profile.home, "");
        assert_eq!(shown.profile.shell, "");
        assert!(matches!(outcome, Outcome::Granted(p) if p.home == "/home/alice"));
    }

    #[test]
    fn a_passwordless_logon_needs_no_round() {
        let mut relay = Relay::new(TYPE);
        relay.on_server(&start("peios"));
        assert!(matches!(
            relay.on_authority(&granted(), true),
            Action::Finish { outcome: Outcome::Granted(_), .. }
        ));
    }

    #[test]
    fn a_grant_with_no_descriptor_is_a_failed_logon() {
        let mut relay = Relay::new(TYPE);
        relay.on_server(&start("alice"));
        assert_eq!(denied_with(relay.on_authority(&granted(), false)), Denial::AuthorityUnavailable);
    }

    #[test]
    fn an_answer_to_a_prompt_nobody_asked_is_refused() {
        let mut relay = Relay::new(TYPE);
        relay.on_server(&start("alice"));
        relay.on_authority(&request(&[1]), false);
        assert_eq!(denied_with(relay.on_server(response(&[2]).expose())), Denial::MalformedRequest);
    }

    #[test]
    fn the_same_prompt_answered_twice_is_refused() {
        let mut relay = Relay::new(TYPE);
        relay.on_server(&start("alice"));
        relay.on_authority(&request(&[1]), false);
        assert_eq!(denied_with(relay.on_server(response(&[1, 1]).expose())), Denial::MalformedRequest);
    }

    #[test]
    fn the_server_cannot_open_with_anything_but_a_start() {
        let mut relay = Relay::new(TYPE);
        assert_eq!(denied_with(relay.on_server(response(&[1]).expose())), Denial::MalformedRequest);
    }

    #[test]
    fn a_logon_for_nobody_is_refused() {
        let mut relay = Relay::new(TYPE);
        assert_eq!(denied_with(relay.on_server(&start(""))), Denial::MalformedRequest);
    }

    #[test]
    fn a_finished_relay_refuses_everything() {
        let mut relay = Relay::new(TYPE);
        relay.on_server(&start(""));
        assert_eq!(denied_with(relay.on_server(&start("alice"))), Denial::Internal);
        assert_eq!(denied_with(relay.on_authority(&granted(), true)), Denial::Internal);
    }

    #[test]
    fn the_authoritys_denial_passes_through() {
        let mut relay = Relay::new(TYPE);
        relay.on_server(&start("alice"));
        let denial = wire::encode_access_denied(&AccessDenied {
            denial: Denial::AuthenticationFailed,
            reason: "Authentication failed.".into(),
        })
        .unwrap();
        let Action::Finish { to_server, outcome } = relay.on_authority(&denial, false) else {
            panic!()
        };
        assert_eq!(outcome, Outcome::Denied(Denial::AuthenticationFailed));
        assert_eq!(wire::decode_access_denied(&to_server).unwrap().reason, "Authentication failed.");
    }
}
