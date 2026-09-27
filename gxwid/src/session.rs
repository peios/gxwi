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

use crate::jobs::Jobs;

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

        let listener = UnixListener::bind(&path)?;
        stamp(&path, SOCKET_SDDL)?;
        // A new session starts with an empty runtime directory: whatever the
        // last one left there was that session's.
        let runtime = self.runtime.join(user.to_string());
        match std::fs::remove_dir_all(&runtime) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        std::fs::create_dir(&runtime)?;
        stamp(&runtime, &format!("D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;{user})"))?;
        let mut definition = self.definition(&user.to_string(), &runtime, profile);
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
            return Err(io::Error::other(format!("the compositor's job {} is {}{cause}", job.id, job.state)));
        }
        eprintln!("gxwid: started a session for {user} as job {}", job.id);

        // The socket answers from the moment it was bound, but as gxwid, who
        // bound it. It is the session's once the compositor has put its own
        // name to it, and not before.
        let deadline = Instant::now() + STARTING;
        loop {
            let connection = connect(&path)?;
            if answered_by(&connection, &token)? {
                return Ok(connection);
            }
            if Instant::now() > deadline {
                return Err(io::Error::other("the compositor never took up its socket"));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn definition(&self, user: &str, runtime: &Path, profile: &Profile) -> serde_json::Value {
        // As `login` has it: a home that is not there is not a failed logon.
        let home = if profile.home.starts_with('/') && Path::new(&profile.home).is_dir() { &profile.home } else { "/" };
        let shell = if profile.shell.starts_with('/') { &profile.shell } else { "/bin/sh" };
        // Asked as each session starts, so a change needs no restart and
        // reaches nobody who is already logged on.
        let compositor = crate::settings::compositor(&self.stand_in);
        json!({
            "image_path": compositor,
            "arguments": [],
            "environment": { "HOME": home, "SHELL": shell, "PATH": "/usr/bin:/bin", "GXWI_RUNTIME_DIR": runtime },
            "working_directory": home,
            "description": format!("GXWI session for {user}"),
            "descriptors": ["gxwi-session"],
            "stop_timeout": 10,
        })
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
