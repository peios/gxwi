//! Sessions: what a granted logon is spent on.
//!
//! A person has one session on this machine. Its compositor runs as them, as a
//! peinit job carrying their token, and listens on a socket gxwid made for it;
//! gxwid connects and hands the connected end to gxwi-server, which knows the
//! session as that socket and nothing more. Logging on again while a session
//! is running leads to the same one, and the new token is let go: closing a
//! browser disconnects, and only the compositor ending is a logoff.
//!
//! Nothing here is remembered. A session is its socket, named for whose it is,
//! so gxwid can be restarted under running sessions and find them again.
//!
//! The overlay is started the same way and is not a session. It is one program
//! for the whole machine, which happens to run as somebody: it has a socket of
//! its own, not that person's, so it is never mistaken for their session nor
//! theirs for it. And it is gxwid's to end, which a session never is, so the
//! one thing kept is its job's name, for a gxwid that starts after another
//! left an overlay running.

use std::io;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use libauthd::wire::Profile;
use peios::file::{self, SecInfo};
use peios::security::sddl;
use peios::token::{ImpersonationLevel, Token};
use serde_json::json;

use crate::jobs::{Jobs, Submitted};

const DEFAULT_DIRECTORY: &str = "/run/gxwi";
/// SYSTEM and nobody else, whatever `/run` would have handed down. The
/// compositor never opens its socket by name, so it needs no way in.
const DIRECTORY_SDDL: &str = "D:P(A;OICI;GA;;;SY)";
const SOCKET_SDDL: &str = "D:P(A;;GA;;;SY)";
const DEFAULT_RUNTIME: &str = "/run/gxwi-user";
/// Anyone may pass through to their own directory; only SYSTEM makes one.
const RUNTIME_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GRGX;;;WD)";
/// How long a new compositor has to take up its socket.
const STARTING: Duration = Duration::from_secs(10);
/// The overlay's socket, its runtime directory, and where its job's name is
/// kept. None can be taken for a person's: theirs are named for their SID.
const OVERLAY_SOCKET: &str = "overlay.sock";
const OVERLAY_RUNTIME: &str = "overlay";
const OVERLAY_JOB: &str = "overlay.job";

/// An overlay that has started.
pub struct Running {
    /// Its job, for ending it.
    pub job: String,
    /// A handle on its process, which reads as ready once the process has gone.
    pub process: OwnedFd,
}

pub struct Sessions {
    directory: PathBuf,
    /// Where each person's runtime directory is made: the one place a
    /// compositor has to put sockets of its own, since nothing a person can
    /// write to is theirs alone otherwise.
    runtime: PathBuf,
    /// What a session runs when the registry names no compositor.
    stand_in: PathBuf,
    /// One logon at a time decides whether a session exists, so two logons by
    /// the same person cannot both start one.
    starting: Mutex<()>,
}

impl Sessions {
    pub fn new(stand_in: PathBuf) -> io::Result<Sessions> {
        let directory = PathBuf::from(std::env::var_os("GXWI_RUN").unwrap_or_else(|| DEFAULT_DIRECTORY.into()));
        std::fs::create_dir_all(&directory)?;
        stamp(&directory, DIRECTORY_SDDL)?;
        let runtime = PathBuf::from(std::env::var_os("GXWI_RUNTIME").unwrap_or_else(|| DEFAULT_RUNTIME.into()));
        std::fs::create_dir_all(&runtime)?;
        stamp(&runtime, RUNTIME_SDDL)?;
        Ok(Sessions { directory, runtime, stand_in, starting: Mutex::new(()) })
    }

    /// A connection to the session of whoever `token` names, starting one if
    /// they have none.
    pub fn attach(&self, token: OwnedFd, profile: &Profile) -> io::Result<UnixStream> {
        let token = Token::from(token);
        let user = token.user()?;
        let path = self.directory.join(format!("{user}.sock"));

        let _one_at_a_time = self.starting.lock().unwrap_or_else(|e| e.into_inner());
        match connect(&path) {
            Ok(connection) if answered_by(&connection, &token)? => {
                eprintln!("gxwid: {user} rejoins their session");
                return Ok(connection);
            }
            // Nobody is listening, or somebody else is: either way it is not
            // this person's session, and the name is taken back.
            _ => match std::fs::remove_file(&path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            },
        }

        // Asked as each session starts, so a change needs no restart and
        // reaches nobody who is already logged on.
        let compositor = crate::settings::compositor(&self.stand_in);
        // A new session starts with an empty runtime directory: whatever the
        // last one left there was that session's.
        let runtime = self.runtime.join(user.to_string());
        let job = self.start(&path, &runtime, &compositor, &format!("GXWI session for {user}"), &token, profile)?;
        eprintln!("gxwid: started a session for {user} as job {}", job.id);
        taken_up(&path, &token)
    }

    /// Starts `program` as the overlay, running as whoever `token` names, and
    /// returns once it has taken up its socket. Whatever overlay ran before
    /// has been ended by then: there is one socket, and this takes it.
    pub fn start_overlay(&self, token: OwnedFd, profile: &Profile, program: &Path) -> io::Result<Running> {
        let token = Token::from(token);
        let user = token.user()?;
        let path = self.directory.join(OVERLAY_SOCKET);
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        let runtime = self.runtime.join(OVERLAY_RUNTIME);
        let job = self.start(&path, &runtime, program, &format!("GXWI overlay, as {user}"), &token, profile)?;
        // Kept before anything else can fail, so that whatever follows, this
        // gxwid or the next can end the job.
        let started = std::fs::write(self.directory.join(OVERLAY_JOB), &job.id)
            .and_then(|()| job.process.ok_or_else(|| io::Error::other("peinit gave no handle on the overlay's process")));
        match started.and_then(|process| taken_up(&path, &token).map(|_| process)) {
            Ok(process) => {
                eprintln!("gxwid: started the overlay {} for {user} as job {}", program.display(), job.id);
                Ok(Running { job: job.id, process })
            }
            Err(e) => {
                self.end_overlay(&job.id);
                Err(e)
            }
        }
    }

    /// A connection to the overlay, for a gxwi-server to send requests down.
    pub fn connect_overlay(&self) -> io::Result<UnixStream> {
        connect(&self.directory.join(OVERLAY_SOCKET))
    }

    /// Ends the overlay's job and forgets it. A job that has already gone is
    /// the ordinary case and not a failure; one peinit would not end is said,
    /// and forgotten all the same, since nothing more can be done about it.
    pub fn end_overlay(&self, job: &str) {
        if let Err(e) = Jobs::connect().and_then(|mut jobs| jobs.stop(job)) {
            eprintln!("gxwid: the overlay's job {job} was not ended: {e}");
        }
        let _ = std::fs::remove_file(self.directory.join(OVERLAY_JOB));
        let _ = std::fs::remove_file(self.directory.join(OVERLAY_SOCKET));
    }

    /// Ends an overlay an earlier gxwid left running. gxwid has to be able to
    /// end its overlay and to know when it has gone, and it can do neither
    /// for one it did not start, so it starts its own.
    pub fn end_left_over_overlay(&self) {
        if let Ok(job) = std::fs::read_to_string(self.directory.join(OVERLAY_JOB)) {
            eprintln!("gxwid: ending the overlay an earlier gxwid left running, job {}", job.trim());
            self.end_overlay(job.trim());
        }
    }

    /// Binds `path`, submits `program` to run as `token` holding it, with
    /// `runtime` as a fresh runtime directory, and returns the job once it is
    /// running. The socket is not yet the program's: see [`taken_up`].
    fn start(
        &self,
        path: &Path,
        runtime: &Path,
        program: &Path,
        description: &str,
        token: &Token,
        profile: &Profile,
    ) -> io::Result<Submitted> {
        let user = token.user()?;
        let listener = UnixListener::bind(path)?;
        stamp(path, SOCKET_SDDL)?;
        match std::fs::remove_dir_all(runtime) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        std::fs::create_dir(runtime)?;
        stamp(runtime, &format!("D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;{user})"))?;
        let mut definition = definition(program, description, runtime, profile);
        let environment = definition["environment"].as_object_mut().expect("session environment");
        // Neutralize inherited peinit/service locale variables. Empty locale
        // categories fall back to LANG; neither LC_ALL nor LANGUAGE is policy.
        for name in ["LC_ALL", "LANGUAGE"].into_iter().chain(libsession::locale::CATEGORIES.iter().copied()) {
            environment.insert(name.into(), json!(""));
        }
        for (name, value) in libsession::locale::for_principal(user.as_ref()) {
            environment.insert(name, json!(value));
        }
        let job = Jobs::connect()?.submit(definition, token.as_fd(), &[listener.as_fd()])?;
        drop(listener);
        if job.state != "running" {
            let cause = job.cause.map(|c| format!(" ({c})")).unwrap_or_default();
            return Err(io::Error::other(format!("the job {} for {} is {}{cause}", job.id, program.display(), job.state)));
        }
        Ok(job)
    }
}

fn definition(program: &Path, description: &str, runtime: &Path, profile: &Profile) -> serde_json::Value {
    // As `login` has it: a home that is not there is not a failed logon.
    let home = if profile.home.starts_with('/') && Path::new(&profile.home).is_dir() { &profile.home } else { "/" };
    let shell = if profile.shell.starts_with('/') { &profile.shell } else { "/bin/sh" };
    // What to call the person, for a compositor to greet them by. Only the
    // first logon's: a session joined again keeps the name it started with.
    json!({
        "image_path": program,
        "arguments": [],
        "environment": {
            "HOME": home, "SHELL": shell, "PATH": "/usr/bin:/bin", "GXWI_RUNTIME_DIR": runtime,
            "GXWI_DISPLAY_NAME": profile.display_name,
        },
        "working_directory": home,
        "description": description,
        "descriptors": ["gxwi-session"],
        "stop_timeout": 10,
    })
}

/// A connection to the program that has taken up the socket at `path`, once
/// it has. The socket answers from the moment it was bound, but as gxwid, who
/// bound it. It is the program's once the program has put its own name to it,
/// and not before.
fn taken_up(path: &Path, token: &Token) -> io::Result<UnixStream> {
    let deadline = Instant::now() + STARTING;
    loop {
        let connection = connect(path)?;
        if answered_by(&connection, token)? {
            return Ok(connection);
        }
        if Instant::now() > deadline {
            return Err(io::Error::other("the program never took up its socket"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Connects without lending gxwid's identity. Whoever accepts a connection may
/// act as whoever made it, as far as the connection allows, and this one is
/// SYSTEM calling on a person's process. Identification lets that process see
/// who is calling and do nothing with it.
fn connect(path: &Path) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_encoded_bytes();
    // SAFETY: a zeroed sockaddr_un is a valid one.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    if bytes.len() >= addr.sun_path.len() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "session socket path too long"));
    }
    for (to, from) in addr.sun_path.iter_mut().zip(bytes) {
        *to = *from as libc::c_char;
    }
    // SAFETY: the descriptor is checked before it is owned, and the address is
    // the one filled in above with its true length.
    unsafe {
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let socket = OwnedFd::from_raw_fd(fd);
        ImpersonationLevel::Identification.set_on_socket(socket.as_fd())?;
        let len = (std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1) as libc::socklen_t;
        if libc::connect(socket.as_raw_fd(), (&raw const addr).cast(), len) < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(UnixStream::from(socket))
    }
}

/// Whether the far end is a process of the person `token` names. The kernel
/// says who accepted; nothing the far end sends could.
fn answered_by(connection: &UnixStream, token: &Token) -> io::Result<bool> {
    Ok(Token::open_peer(connection.as_fd())?.user()? == token.user()?)
}

fn stamp(path: &Path, text: &str) -> io::Result<()> {
    let descriptor = sddl::parse(text).map_err(|e| io::Error::other(format!("{text}: {e:?}")))?;
    Ok(file::set_sd(None, path, SecInfo::DACL, &descriptor, 0)?)
}
