//! Logon conversations: the control channel gxwi-server asks for them on, and
//! the thread that carries each one between the server and the authority.
//!
//! The decisions are `relay`'s. This is the I/O around them, and the three
//! things that are properly gxwid's own: how many conversations may be open,
//! how often one may start, and what becomes of a token.

use std::io;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use gxwi_channel::{CONTROL, MSG_CONVERSATION, MSG_OPEN_CONVERSATION, MSG_REFUSED};
use libauthd::Secret;
use libauthd::transport::{recv_message, recv_message_with_fd, send_message, send_message_with_fd};
use libauthd::wire::{self, Denial, LogonType};

use crate::relay::{self, Action, Outcome, Relay};
use crate::session::Sessions;
use crate::throttle::Throttle;

/// A GXWI session is an interactive desktop reached over a network. authd
/// derives Interactive and Remote Interactive groups, without Network.
const LOGON_TYPE: LogonType = LogonType::RemoteInteractive;

/// The authority serves 64 conversations for the whole machine. GXWI never
/// takes more than a quarter of them, so it cannot crowd out the console.
const MAX_CONVERSATIONS: usize = 16;

/// A person has 120 s to answer before the authority gives up on them. Wait a
/// little longer than that for the server, so the authority's refusal, which
/// says why, is what ends an abandoned conversation.
const SERVER_READ_TIMEOUT: Duration = Duration::from_secs(125);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// The authority allows its own sources 30 s.
const AUTHORITY_READ_TIMEOUT: Duration = Duration::from_secs(45);

/// Every denial waits this long before it is relayed, whatever its cause.
const DENIAL_DELAY: Duration = Duration::from_secs(1);

/// What outlives any one gxwi-server: restarting the server resets neither.
pub struct Logons {
    throttle: Throttle,
    open: AtomicUsize,
    /// `None` where gxwid is not on Peios, and a grant leads nowhere.
    sessions: Option<Sessions>,
}

impl Logons {
    pub fn new(sessions: Option<Sessions>) -> Logons {
        Logons { throttle: Throttle::default(), open: AtomicUsize::new(0), sessions }
    }
}

/// Serves one gxwi-server's control channel until that server is gone.
pub fn serve_control(control: UnixStream, logons: Arc<Logons>) {
    loop {
        // Blocks until the server asks for something or dies.
        let Ok(message) = recv_message(&CONTROL, &control) else { return };
        let reply = match gxwi_channel::control_message_type(message.expose()) {
            Ok(MSG_OPEN_CONVERSATION) => open_conversation(&control, &logons),
            _ => {
                eprintln!("gxwid: gxwi-server sent something that is not a control request");
                send_message(&control, &gxwi_channel::control_message(MSG_REFUSED))
            }
        };
        if reply.is_err() {
            return;
        }
    }
}

fn open_conversation(control: &UnixStream, logons: &Arc<Logons>) -> io::Result<()> {
    let Some(slot) = Slot::take(logons) else {
        return send_message(control, &gxwi_channel::control_message(MSG_REFUSED));
    };
    let (ours, theirs) = UnixStream::pair()?;
    let logons = Arc::clone(logons);
    std::thread::Builder::new().name("conversation".into()).spawn(move || {
        let _slot = slot;
        converse(ours, &logons);
    })?;
    send_message_with_fd(control, &gxwi_channel::control_message(MSG_CONVERSATION), theirs.as_fd())
}

/// One of the `MAX_CONVERSATIONS`, given back when it is dropped.
struct Slot(Arc<Logons>);

impl Slot {
    fn take(logons: &Arc<Logons>) -> Option<Slot> {
        logons
            .open
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < MAX_CONVERSATIONS).then_some(n + 1))
            .ok()
            .map(|_| Slot(Arc::clone(logons)))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Carries one conversation to its end.
fn converse(server: UnixStream, logons: &Logons) {
    if server.set_read_timeout(Some(SERVER_READ_TIMEOUT)).is_err()
        || server.set_write_timeout(Some(WRITE_TIMEOUT)).is_err()
    {
        return;
    }
    let mut relay = Relay::new(LOGON_TYPE);
    let mut authority: Option<UnixStream> = None;
    // The token, from the moment the authority hands it over. It goes nowhere
    // near the server's socket.
    let mut token: Option<OwnedFd> = None;

    let Ok(mut from_server) = recv_message(&wire::FRAMING, &server) else { return };
    let mut action = relay.on_server(from_server.expose());
    loop {
        action = match action {
            Action::SendAuthority(bytes) => {
                if authority.is_none() {
                    if !logons.throttle.admit(relay.claimed_address(), Instant::now()) {
                        action = relay::deny(Denial::ConversationLimit);
                        continue;
                    }
                    authority = connect_authority().ok();
                }
                exchange(authority.as_ref(), &bytes, &mut relay, &mut token)
            }
            Action::ForwardToAuthority => {
                exchange(authority.as_ref(), from_server.expose(), &mut relay, &mut token)
            }
            Action::SendServer(bytes) => {
                if send_message(&server, &bytes).is_err() {
                    return;
                }
                match recv_message(&wire::FRAMING, &server) {
                    Ok(message) => from_server = message,
                    Err(_) => return,
                }
                relay.on_server(from_server.expose())
            }
            Action::Finish { to_server, outcome } => {
                finish(logons, &server, &to_server, outcome, relay.claimed_address(), token.take());
                return;
            }
        };
    }
}

/// Sends to the authority and hands its answer to the relay. An authority that
/// cannot be reached, or does not answer, is a denial like any other.
fn exchange(
    authority: Option<&UnixStream>,
    message: &[u8],
    relay: &mut Relay,
    token: &mut Option<OwnedFd>,
) -> Action {
    let Some(authority) = authority else {
        return relay::deny(Denial::AuthorityUnavailable);
    };
    if send_message(authority, message).is_err() {
        return relay::deny(Denial::AuthorityUnavailable);
    }
    let Ok((answer, descriptor)): io::Result<(Secret, Option<OwnedFd>)> =
        recv_message_with_fd(&wire::FRAMING, authority)
    else {
        return relay::deny(Denial::AuthorityUnavailable);
    };
    if descriptor.is_some() {
        *token = descriptor;
    }
    relay.on_authority(answer.expose(), token.is_some())
}

fn connect_authority() -> io::Result<UnixStream> {
    let path = std::env::var_os("GXWI_LOGON_SOCKET")
        .unwrap_or_else(|| libauthd::LOGON_SOCKET_PATH.into());
    let authority = UnixStream::connect(path)?;
    authority.set_read_timeout(Some(AUTHORITY_READ_TIMEOUT))?;
    authority.set_write_timeout(Some(WRITE_TIMEOUT))?;
    Ok(authority)
}

fn finish(
    logons: &Logons,
    server: &UnixStream,
    to_server: &[u8],
    outcome: Outcome,
    claimed_address: Option<&str>,
    token: Option<OwnedFd>,
) {
    let from = claimed_address.unwrap_or("an unstated address");
    let profile = match outcome {
        Outcome::Granted(profile) => profile,
        Outcome::Denied(denial) => {
            eprintln!("gxwid: logon denied ({denial:?}), claimed from {from}");
            std::thread::sleep(DENIAL_DELAY);
            let _ = send_message(server, to_server);
            return;
        }
    };
    eprintln!("gxwid: logon granted, claimed from {from}");
    // The token is spent on a session, and what the server gets with its
    // grant is a connection to that session. Where that cannot be had the
    // person is told so: they proved who they are, so it is no denial, but
    // there is nowhere to put them.
    let session = match (&logons.sessions, token) {
        (Some(sessions), Some(token)) => sessions.attach(token, &profile),
        _ => Err(io::Error::other("sessions are not available")),
    };
    let _ = match session {
        Ok(session) => send_message_with_fd(server, to_server, session.as_fd()),
        Err(e) => {
            eprintln!("gxwid: no session: {e}");
            send_message(server, to_server)
        }
    };
}
