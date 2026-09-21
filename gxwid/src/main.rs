//! gxwid — the privileged half of GXWI. It owns the listening socket and the
//! lifetime of gxwi-server, the network-facing half, and parses no HTTP itself.

use std::io;
use std::net::TcpListener;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::{Duration, Instant};

mod logon;
mod relay;
mod sandbox;
mod throttle;

// Not 8080/8081: on the dev host those are QEMU's forwards into a booted VM.
const DEFAULT_LISTEN: &str = "127.0.0.1:7780";

// Where gxwi-server finds what it is handed. It opens nothing for itself.
const SERVER_LISTENER_FD: RawFd = 3;
const SERVER_CHANNEL_FD: RawFd = 4;

const RESTART_DELAY_MIN: Duration = Duration::from_secs(1);
const RESTART_DELAY_MAX: Duration = Duration::from_secs(30);
// A server that stayed up this long did not fail on startup; forgive it.
const RESTART_DELAY_RESET: Duration = Duration::from_secs(60);

fn main() {
    // For whatever must grant the server access: a package, or a dev mount.
    if std::env::args().any(|a| a == "--print-capability-sid") {
        let sid = sandbox::net_capability_sid().unwrap_or_else(|e| die(&format!("capability SID: {e}")));
        println!("{sid}");
        return;
    }
    // `--unrestricted` skips the token work, for a host without KACS.
    let unrestricted = std::env::args().any(|a| a == "--unrestricted");
    if unrestricted {
        eprintln!("gxwid: --unrestricted: gxwi-server runs as this process's own identity");
    } else {
        eprintln!("gxwid: gxwi-server is restricted to the capability {}", sandbox::NET_CAPABILITY);
    }

    let listen = std::env::var("GXWI_LISTEN").unwrap_or_else(|_| DEFAULT_LISTEN.to_string());
    let server = server_path();

    // Bound once and kept across restarts, so connections made while the
    // server is down queue in the kernel instead of being refused.
    let listener = TcpListener::bind(&listen).unwrap_or_else(|e| die(&format!("bind {listen}: {e}")));
    let listener = dup_high(listener.as_raw_fd()).unwrap_or_else(|e| die(&format!("dup listener: {e}")));
    eprintln!("gxwid: listening on http://{listen}, server is {}", server.display());

    // Outlives every gxwi-server: restarting the server must not reset the
    // logon throttle.
    let logons = Arc::new(logon::Logons::default());

    let mut delay = RESTART_DELAY_MIN;
    loop {
        let started = Instant::now();
        match run_server(&server, &listener, unrestricted, &logons) {
            Ok(status) => eprintln!("gxwid: gxwi-server exited: {status}"),
            Err(e) => eprintln!("gxwid: gxwi-server did not start: {e}"),
        }
        if started.elapsed() >= RESTART_DELAY_RESET {
            delay = RESTART_DELAY_MIN;
        }
        eprintln!("gxwid: restarting gxwi-server in {}s", delay.as_secs());
        std::thread::sleep(delay);
        delay = (delay * 2).min(RESTART_DELAY_MAX);
    }
}

/// Runs one gxwi-server to completion.
fn run_server(
    server: &PathBuf,
    listener: &OwnedFd,
    unrestricted: bool,
    logons: &Arc<logon::Logons>,
) -> io::Result<std::process::ExitStatus> {
    // A fresh pair per server: the old one died with the old server.
    let (ours, theirs_low) = UnixStream::pair()?;
    let theirs = dup_high(theirs_low.as_raw_fd())?;
    drop(theirs_low);
    let token = if unrestricted {
        None
    } else {
        Some(sandbox::server_token().map_err(|e| io::Error::other(format!("restricted token: {e}")))?)
    };
    let mut child = spawn_server(server, listener, &theirs, token)?;
    // Only the server holds its end now, so its death reads as EOF on ours,
    // which is what ends the control thread.
    drop(theirs);
    let logons = Arc::clone(logons);
    std::thread::Builder::new()
        .name("control".into())
        .spawn(move || logon::serve_control(ours, logons))?;
    child.wait()
}

fn spawn_server(
    server: &PathBuf,
    listener: &OwnedFd,
    channel: &OwnedFd,
    token: Option<peios::token::Token>,
) -> io::Result<Child> {
    let (listener, channel) = (listener.as_raw_fd(), channel.as_raw_fd());
    let parent = std::process::id() as libc::pid_t;

    let mut cmd = Command::new(server);
    cmd.arg("--listener-fd").arg(SERVER_LISTENER_FD.to_string());
    cmd.arg("--channel-fd").arg(SERVER_CHANNEL_FD.to_string());
    if token.is_none() {
        // Without this the server refuses to run outside the restricted token.
        cmd.arg("--unrestricted");
    }
    // SAFETY: the closure runs in the forked child before exec and makes only
    // system calls (dup2, the token install ioctl, prctl, getppid). gxwid has
    // other threads, any of which may hold a lock at the fork, so nothing here
    // may allocate or take one.
    unsafe {
        cmd.pre_exec(move || {
            // dup2 clears close-on-exec on the copy. Both sources are above
            // the targets (dup_high), so neither dup2 can clobber the other.
            if libc::dup2(listener, SERVER_LISTENER_FD) == -1
                || libc::dup2(channel, SERVER_CHANNEL_FD) == -1
            {
                return Err(io::Error::last_os_error());
            }
            // From here the process is the restricted server, and the exec
            // that follows is checked against that identity.
            if let Some(token) = &token {
                token.install().map_err(|e| {
                    io::Error::from_raw_os_error(e.raw_os_error().unwrap_or(libc::EPERM))
                })?;
            }
            // The server must never outlive gxwid. Set after the install: a
            // change of credentials can clear the parent-death signal.
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(io::Error::last_os_error());
            }
            // gxwid may have died before the prctl took effect.
            if libc::getppid() != parent {
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
    cmd.spawn()
}

/// Duplicates `fd` to a close-on-exec descriptor numbered 10 or above, clear of
/// the numbers the server is handed.
fn dup_high(fd: RawFd) -> io::Result<OwnedFd> {
    // SAFETY: F_DUPFD_CLOEXEC returns a new descriptor we own, or -1.
    let new = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if new == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `new` is a fresh descriptor nothing else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(new) })
}

/// gxwi-server sits beside gxwid unless GXWI_SERVER says otherwise.
fn server_path() -> PathBuf {
    if let Some(path) = std::env::var_os("GXWI_SERVER") {
        return PathBuf::from(path);
    }
    let exe = std::env::current_exe().unwrap_or_else(|e| die(&format!("current_exe: {e}")));
    exe.with_file_name("gxwi-server")
}

fn die(msg: &str) -> ! {
    eprintln!("gxwid: {msg}");
    std::process::exit(1);
}
