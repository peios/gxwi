//! The overlay: one program for the whole machine, which everyone who reaches
//! GXWI is sent to while it is set, in place of the logon pages and of any
//! session. An installer is one, and so is a page saying the machine is not
//! ready yet.
//!
//! Which program, and who it runs as, are the registry's to say (`settings`).
//! gxwid logs that account on itself, through the authority like any other
//! logon, and tells the authority it can collect no credential at all. So the
//! authority grants only an account that needs none, and an overlay is never a
//! way in to an account that has one. gxwi-server has no part in it: it is
//! told where the overlay stands and handed a socket.
//!
//! An overlay that is asked for and cannot run leaves nothing else in its
//! place. Whoever set it meant people to be kept from what is behind it, so
//! they are told it is not available, and gxwid goes on trying.

use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gxwi_channel::{MSG_OVERLAY, MSG_OVERLAY_NONE, MSG_OVERLAY_UNAVAILABLE};
use libauthd::transport::{recv_message_with_fd, send_message, send_message_with_fd};
use libauthd::wire::{self, IdentifierType, LogonStart, Profile};
use peios::registry::{Key, WatchEventType};

use crate::session::{Running, Sessions};
use crate::settings;

/// How soon a failed start is tried again, doubling up to the longest.
const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);
/// An overlay that ran this long did not fail on starting; forgive it.
const RETRY_RESET: Duration = Duration::from_secs(60);
/// How often a key that is not there, or cannot be watched, is looked for.
const LOOK_AGAIN: Duration = Duration::from_secs(5);

/// Where the overlay stands, as gxwi-server is told it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    /// None is asked for. The logon pages and sessions are served.
    None,
    /// One is asked for and cannot be reached. Nothing else is served.
    Unavailable,
    /// It is running, and everything is sent to it.
    Up,
}

pub struct Overlay {
    /// `None` where gxwid is not on Peios: there is nothing to run one as.
    sessions: Option<Arc<Sessions>>,
    told: Mutex<Told>,
}

struct Told {
    standing: Standing,
    /// gxwid's end of the running gxwi-server's overlay channel.
    server: Option<UnixStream>,
}

impl Overlay {
    /// Reads whether an overlay is asked for, so that the first gxwi-server is
    /// told so before it serves anything: from the first request, an overlay
    /// that is not up yet is one that is not available.
    pub fn new(sessions: Option<Arc<Sessions>>) -> Arc<Overlay> {
        let asked = sessions.is_some() && settings::overlay().0.is_some();
        let standing = if asked { Standing::Unavailable } else { Standing::None };
        Arc::new(Overlay { sessions, told: Mutex::new(Told { standing, server: None }) })
    }

    /// Takes gxwid's end of a new gxwi-server's overlay channel, and writes
    /// where the overlay stands into it. Called before that server starts, so
    /// it is the first thing the server reads.
    pub fn serve(&self, channel: UnixStream) {
        let mut told = self.told.lock().unwrap_or_else(|e| e.into_inner());
        told.server = self.tell(&channel, told.standing).is_ok().then_some(channel);
    }

    /// Says where the overlay now stands, to the running gxwi-server and to
    /// whichever follow it.
    fn say(&self, standing: Standing) {
        let mut told = self.told.lock().unwrap_or_else(|e| e.into_inner());
        if told.standing == standing {
            return;
        }
        told.standing = standing;
        // A server that cannot be told has gone. The next is told as it starts.
        if let Some(channel) = told.server.take() {
            told.server = self.tell(&channel, standing).is_ok().then_some(channel);
        }
    }

    fn tell(&self, channel: &UnixStream, standing: Standing) -> io::Result<()> {
        let message = |msg_type| gxwi_channel::control_message(msg_type);
        match standing {
            Standing::None => send_message(channel, &message(MSG_OVERLAY_NONE)),
            Standing::Unavailable => send_message(channel, &message(MSG_OVERLAY_UNAVAILABLE)),
            // Each server gets a connection of its own. An overlay that will
            // not take one is not available, whatever else is true of it.
            Standing::Up => match self.sessions.as_ref().map(|sessions| sessions.connect_overlay()) {
                Some(Ok(connection)) => send_message_with_fd(channel, &message(MSG_OVERLAY), connection.as_fd()),
                _ => send_message(channel, &message(MSG_OVERLAY_UNAVAILABLE)),
            },
        }
    }

    /// Keeps the overlay as the registry asks for it, for as long as gxwid
    /// runs: started when it is set, started again when it goes, ended when
    /// it is changed or taken away.
    pub fn keep(self: Arc<Self>) {
        let Some(sessions) = self.sessions.clone() else { return };
        sessions.end_left_over_overlay();

        let mut watch = settings::watch();
        let mut running: Option<(settings::Overlay, Running, Instant)> = None;
        let mut retry = Retry::default();
        // What was last said about the settings and about a failed start, so
        // that each is said when it changes and not every time round.
        let (mut said_wrong, mut said_failed) = (Vec::new(), String::new());
        loop {
            let (wanted, wrong) = settings::overlay();
            if wrong != said_wrong {
                wrong.iter().for_each(|line| eprintln!("gxwid: {line}"));
                said_wrong = wrong;
            }
            let was = running.as_ref().map(|(was, ..)| was);
            if step(wanted.as_ref(), was) == Step::End {
                // Said first: nobody is sent to an overlay that is being ended.
                self.say(if wanted.is_some() { Standing::Unavailable } else { Standing::None });
                if let Some((was, run, _)) = running.take() {
                    let why = if wanted.is_some() { "asks for another now" } else { "no longer asks for one" };
                    eprintln!("gxwid: ending the overlay {}: the registry {why}", was.session.display());
                    sessions.end_overlay(&run.job);
                }
                (retry, said_failed) = (Retry::default(), String::new());
            }
            match step(wanted.as_ref(), running.as_ref().map(|(was, ..)| was)) {
                Step::Start if retry.due() => match start(&sessions, wanted.as_ref().expect("an overlay to start")) {
                    Ok(run) => {
                        running = Some((wanted.clone().expect("an overlay to start"), run, Instant::now()));
                        said_failed.clear();
                        self.say(Standing::Up);
                    }
                    Err(why) => {
                        self.say(Standing::Unavailable);
                        retry.failed();
                        if why != said_failed {
                            eprintln!("gxwid: the overlay could not be started: {why}; still trying");
                            said_failed = why;
                        }
                    }
                },
                Step::Start => self.say(Standing::Unavailable),
                Step::End | Step::Nothing if wanted.is_none() => self.say(Standing::None),
                Step::End | Step::Nothing => {}
            }

            // Until the registry changes, the overlay goes, or it is time to
            // try again, whichever comes first.
            let starting = wanted.is_some() && running.is_none();
            let wait = match (watch.is_some(), starting) {
                (_, true) => Some(retry.wait().min(LOOK_AGAIN)),
                (false, false) => Some(LOOK_AGAIN),
                (true, false) => None,
            };
            let (changed, gone) = wait_for(watch.as_ref(), running.as_ref().map(|(_, run, _)| &run.process), wait);
            if gone && let Some((was, run, since)) = running.take() {
                eprintln!("gxwid: the overlay {} has gone; starting it again", was.session.display());
                self.say(Standing::Unavailable);
                sessions.end_overlay(&run.job);
                // One that keeps going as it starts is tried less and less often.
                if since.elapsed() >= RETRY_RESET {
                    retry = Retry::default();
                } else {
                    retry.failed();
                }
            }
            // The events say only that something changed, and everything is
            // read again whatever it was. A key that has gone takes its watch
            // with it, and a watch that cannot be read is no watch.
            if changed && !still_watching(watch.as_ref()) {
                watch = None;
            }
            if watch.is_none() {
                watch = settings::watch();
            }
        }
    }
}

/// What is to be done about the overlay.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    Nothing,
    /// What is running is not what is asked for.
    End,
    /// One is asked for and none is running.
    Start,
}

fn step(wanted: Option<&settings::Overlay>, running: Option<&settings::Overlay>) -> Step {
    match (wanted, running) {
        (wanted, Some(running)) if wanted != Some(running) => Step::End,
        (Some(_), None) => Step::Start,
        _ => Step::Nothing,
    }
}

/// When a start that failed is next tried.
struct Retry {
    delay: Duration,
    at: Instant,
}

impl Default for Retry {
    fn default() -> Retry {
        Retry { delay: RETRY_MIN, at: Instant::now() }
    }
}

impl Retry {
    fn due(&self) -> bool {
        Instant::now() >= self.at
    }

    fn wait(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    fn failed(&mut self) {
        self.at = Instant::now() + self.delay;
        self.delay = (self.delay * 2).min(RETRY_MAX);
    }
}

fn start(sessions: &Sessions, wanted: &settings::Overlay) -> Result<Running, String> {
    let username = wanted.username.as_deref().ok_or("OverlayUsername does not say who it runs as")?;
    let (token, profile) = logon(username)?;
    sessions.start_overlay(token, &profile, &wanted.session).map_err(|e| e.to_string())
}

/// Logs `username` on with the authority, as a logon that can collect no
/// credential. What comes back is that account's token, or why there is none.
fn logon(username: &str) -> Result<(OwnedFd, Profile), String> {
    let unreachable = |e: io::Error| format!("the authority could not be reached: {e}");
    let authority = crate::logon::connect_authority().map_err(unreachable)?;
    let start = wire::encode_logon_start(&asking_for(username))
        .map_err(|_| format!("{username:?} is not a name the authority can be asked about"))?;
    send_message(&authority, &start).map_err(unreachable)?;
    let (answer, descriptor) = recv_message_with_fd(&wire::FRAMING, &authority).map_err(unreachable)?;
    let profile = granted(username, answer.expose(), descriptor.is_some())?;
    Ok((descriptor.expect("a grant that was checked for its token"), profile))
}

/// What the authority is asked: the same kind of logon a person at a browser
/// gets, for `username`, with nothing that can be collected.
fn asking_for(username: &str) -> LogonStart {
    LogonStart {
        required_credential_type: None,
        ssh_binding: None,
        logon_type: crate::logon::LOGON_TYPE,
        identifier_type: IdentifierType::Username,
        identifier: username.as_bytes().to_vec(),
        tty: None,
        remote_host: None,
        // There is nobody to collect a credential from. This binds the
        // authority, which grants only an account that needs none, and it is
        // the whole of what keeps an overlay from being a way in to an
        // account that has one.
        supported_credential_types: Vec::new(),
    }
}

/// The authority's answer to a logon that offered no credential: the profile
/// of who was logged on, or why nobody was.
fn granted(username: &str, answer: &[u8], descriptor: bool) -> Result<Profile, String> {
    let unreadable = || "the authority's answer could not be read".to_string();
    match wire::decode_header(answer).map_err(|_| unreadable())?.0 {
        wire::MSG_ACCESS_GRANTED if descriptor => {
            Ok(wire::decode_access_granted(answer).map_err(|_| unreadable())?.profile)
        }
        // PGSS: a grant with no descriptor is a failed logon.
        wire::MSG_ACCESS_GRANTED => Err("the authority granted the logon and sent no token".into()),
        // It was told nothing can be collected, and asked all the same.
        wire::MSG_CREDENTIAL_REQUEST => {
            Err(format!("{username} has a credential, and an overlay runs only as an account that has none"))
        }
        wire::MSG_ACCESS_DENIED => {
            let denied = wire::decode_access_denied(answer).map_err(|_| unreadable())?;
            let reason = if denied.reason.is_empty() { String::new() } else { format!(": {}", denied.reason) };
            Err(format!(
                "the authority would not log {username} on without a credential ({:?}{reason})",
                denied.denial
            ))
        }
        _ => Err(unreadable()),
    }
}

/// Waits until the registry key changes, the overlay's process goes, or
/// `wait` has passed, and says which of the first two happened.
fn wait_for(watch: Option<&Key>, process: Option<&OwnedFd>, wait: Option<Duration>) -> (bool, bool) {
    let entry = |fd: Option<i32>| libc::pollfd { fd: fd.unwrap_or(-1), events: libc::POLLIN, revents: 0 };
    // A negative descriptor is one poll leaves alone.
    let mut fds = [entry(watch.map(|key| key.as_raw_fd())), entry(process.map(|fd| fd.as_raw_fd()))];
    let millis = wait.map_or(-1, |wait| wait.as_millis().min(i32::MAX as u128) as i32);
    // SAFETY: `fds` is ours, and its length is passed with it.
    let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, millis) };
    if ready < 0 {
        // Interrupted, or something poll will not have. Neither is news, and
        // a poll that keeps failing must not spin.
        if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            std::thread::sleep(RETRY_MIN);
        }
        return (false, false);
    }
    (fds[0].revents != 0, fds[1].revents != 0)
}

/// Takes what the watch has to say, and says whether it is still a watch.
fn still_watching(watch: Option<&Key>) -> bool {
    let Some(watch) = watch else { return false };
    let mut buffer = [0u8; 4096];
    loop {
        match watch.read_watch_events(&mut buffer) {
            Ok(events) if events.is_empty() => return true,
            Ok(events) if events.iter().any(|event| event.event_type == WatchEventType::KeyDeleted) => return false,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libauthd::wire::{AccessDenied, AccessGranted, CredentialRequest, CredentialType, Denial, Prompt};
    use std::path::PathBuf;

    fn asked(session: &str, username: Option<&str>) -> settings::Overlay {
        settings::Overlay { session: PathBuf::from(session), username: username.map(str::to_string) }
    }

    #[test]
    fn an_overlay_is_started_when_asked_for_and_ended_when_not() {
        let installer = asked("/usr/bin/installer", Some("peios"));
        assert_eq!(step(None, None), Step::Nothing);
        assert_eq!(step(Some(&installer), None), Step::Start);
        assert_eq!(step(Some(&installer), Some(&installer)), Step::Nothing);
        assert_eq!(step(None, Some(&installer)), Step::End);
    }

    #[test]
    fn a_changed_program_or_account_ends_what_is_running() {
        let installer = asked("/usr/bin/installer", Some("peios"));
        assert_eq!(step(Some(&asked("/usr/bin/other", Some("peios"))), Some(&installer)), Step::End);
        assert_eq!(step(Some(&asked("/usr/bin/installer", Some("alice"))), Some(&installer)), Step::End);
        assert_eq!(step(Some(&asked("/usr/bin/installer", None)), Some(&installer)), Step::End);
    }

    #[test]
    fn an_overlay_with_nobody_to_run_as_is_still_asked_for() {
        // It cannot start, and that is for `start` to say each time it is
        // tried: what matters here is that it is not taken for no overlay.
        assert_eq!(step(Some(&asked("/usr/bin/installer", None)), None), Step::Start);
    }

    #[test]
    fn a_failed_start_waits_longer_each_time_up_to_the_longest() {
        let mut retry = Retry::default();
        assert!(retry.due());
        retry.failed();
        assert!(!retry.due());
        assert!(retry.wait() <= RETRY_MIN);
        for _ in 0..10 {
            retry.failed();
        }
        assert_eq!(retry.delay, RETRY_MAX);
        assert!(retry.wait() <= RETRY_MAX);
    }

    fn grant() -> Vec<u8> {
        wire::encode_access_granted(&AccessGranted {
            session_id: 7,
            profile: Profile { home: "/home/peios".into(), shell: "/bin/sh".into(), display_name: "Peios".into() },
        })
        .unwrap()
    }

    #[test]
    fn a_grant_with_its_token_is_a_logon() {
        assert_eq!(granted("peios", &grant(), true).unwrap().home, "/home/peios");
    }

    #[test]
    fn a_grant_with_no_token_is_not() {
        assert!(granted("peios", &grant(), false).is_err());
    }

    #[test]
    fn an_account_with_a_credential_is_refused() {
        let prompt = wire::encode_credential_request(&CredentialRequest {
            messages: vec![],
            prompts: vec![Prompt {
                parameters: Vec::new(),
                credential_ref: 1,
                credential_type: CredentialType::Password,
                credential_name: "Password".into(),
            }],
        })
        .unwrap();
        assert!(granted("alice", &prompt, false).unwrap_err().contains("has a credential"));
        let denied = wire::encode_access_denied(&AccessDenied {
            denial: Denial::AuthenticationFailed,
            reason: "Authentication failed.".into(),
        })
        .unwrap();
        let why = granted("alice", &denied, false).unwrap_err();
        assert!(why.contains("AuthenticationFailed") && why.contains("Authentication failed."), "{why}");
    }

    #[test]
    fn an_answer_that_is_not_one_is_refused() {
        assert!(granted("peios", b"not a message", true).is_err());
        let start = wire::encode_logon_start(&asking_for("peios")).unwrap();
        assert!(granted("peios", &start, true).is_err());
    }

    #[test]
    fn the_logon_asked_for_offers_nothing_to_collect() {
        let sent = wire::decode_logon_start(&wire::encode_logon_start(&asking_for("peios")).unwrap()).unwrap();
        assert!(sent.supported_credential_types.is_empty());
        assert_eq!(sent.required_credential_type, None);
        assert_eq!(sent.logon_type, wire::LogonType::RemoteInteractive);
        assert_eq!(sent.identifier, b"peios");
        assert_eq!((sent.tty, sent.remote_host), (None, None));
    }
}
