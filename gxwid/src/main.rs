//! gxwid — the privileged half of GXWI. It owns the listening socket, this
//! machine's key, and the lifetime of gxwi-server, the network-facing half,
//! and parses no HTTP itself.

use std::io;
use std::net::TcpListener;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::{Duration, Instant};

mod certificate;
mod hangup;
mod jobs;
mod logon;
mod overlay;
mod relay;
mod sandbox;
mod session;
mod settings;
mod throttle;
mod tls;

use tls::KeySource;

// Not 8080/8081: on the dev host those are QEMU's forwards into a booted VM.
const DEFAULT_LISTEN: &str = "127.0.0.1:7780";

// Where gxwi-server finds what it is handed. It opens nothing for itself.
const SERVER_LISTENER_FD: RawFd = 3;
const SERVER_CHANNEL_FD: RawFd = 4;
const SERVER_OVERLAY_FD: RawFd = 5;
const SERVER_TLS_FD: RawFd = 6;
// Sources must stay above every inherited descriptor during the dup2 sequence.
const FIRST_DUPLICATE_FD: RawFd = 10;

const RESTART_DELAY_MIN: Duration = Duration::from_secs(1);
const RESTART_DELAY_MAX: Duration = Duration::from_secs(30);
// A server that stayed up this long did not fail on startup; forgive it.
const RESTART_DELAY_RESET: Duration = Duration::from_secs(60);

fn main() {
    // For whatever must grant the server access: a package, or a dev mount.
    if std::env::args().any(|a| a == "--print-capability-sid") {
        let sid =
            sandbox::net_capability_sid().unwrap_or_else(|e| die(&format!("capability SID: {e}")));
        println!("{sid}");
        return;
    }
    // `--unrestricted` skips the token work, for a host without KACS.
    let unrestricted = std::env::args().any(|a| a == "--unrestricted");
    if unrestricted {
        eprintln!("gxwid: --unrestricted: gxwi-server runs as this process's own identity");
    } else {
        eprintln!(
            "gxwid: gxwi-server is restricted to the capability {}",
            sandbox::NET_CAPABILITY
        );
    }

    // A host without KACS has no registry either, and says it here instead.
    let listen = if unrestricted {
        std::env::var("GXWI_LISTEN").unwrap_or_else(|_| DEFAULT_LISTEN.to_string())
    } else {
        settings::listen(DEFAULT_LISTEN.parse().expect("the default is an address")).to_string()
    };
    let server = beside("gxwi-server", Some("GXWI_SERVER"));

    // Made the first time, then kept wherever the directory keeps it (`tls`).
    // A host without KACS keeps it where it is told to, and sets no
    // descriptors on it.
    let keys = if unrestricted {
        let path = std::env::var_os("GXWI_STATE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("gxwi-state"));
        tls::StateDirectory {
            path,
            protect: false,
        }
    } else {
        tls::StateDirectory {
            path: PathBuf::from(tls::DIRECTORY),
            protect: true,
        }
    };
    let credentials = keys
        .credentials()
        .unwrap_or_else(|e| die(&format!("this machine's key: {e}")));
    // Caught before anything else can be asked for: SIGHUP would otherwise
    // end gxwid.
    let hangups = hangup::Hangups::catch().unwrap_or_else(|e| die(&format!("SIGHUP: {e}")));
    // A certificate due for renewal is renewed before any server is handed
    // it, and after that once a day, or when gxwid is reloaded (`certificate`).
    let fingerprint_file = keys.path.join(tls::FINGERPRINT);
    let handover = certificate::Handover::new(certificate::renew_now(&keys, credentials));
    let keeper = Arc::clone(&handover);
    std::thread::Builder::new()
        .name("certificate".into())
        .spawn(move || certificate::keep(Box::new(keys), keeper, hangups))
        .unwrap_or_else(|e| die(&format!("certificate thread: {e}")));

    // Bound once and kept across restarts, so connections made while the
    // server is down queue in the kernel instead of being refused.
    let listener =
        TcpListener::bind(&listen).unwrap_or_else(|e| die(&format!("bind {listen}: {e}")));
    let listener =
        dup_high(listener.as_raw_fd()).unwrap_or_else(|e| die(&format!("dup listener: {e}")));
    eprintln!(
        "gxwid: listening on https://{listen}, server is {}",
        server.display()
    );
    eprintln!(
        "gxwid: the certificate's SHA-256 is {} ({})",
        handover.fingerprint(),
        fingerprint_file.display()
    );

    // Which program a session runs is the registry's to say (`settings`), and
    // nothing in gxwid's environment can: whoever chooses it chooses what runs
    // as everyone who logs on. GXWI's own stand-in runs when nothing is set.
    let sessions = if unrestricted {
        None
    } else {
        let stand_in = beside("gxwi-hello", None);
        eprintln!(
            "gxwid: sessions run {}",
            settings::compositor(&stand_in).display()
        );
        Some(Arc::new(
            session::Sessions::new(stand_in).unwrap_or_else(|e| die(&format!("sessions: {e}"))),
        ))
    };

    // The overlay, if the registry asks for one, is kept on a thread of its
    // own for as long as gxwid runs. Where it stands is known before the
    // first gxwi-server starts, so that server is told before it serves.
    let overlay = overlay::Overlay::new(sessions.clone());
    let keeper = Arc::clone(&overlay);
    std::thread::Builder::new()
        .name("overlay".into())
        .spawn(move || keeper.keep())
        .unwrap_or_else(|e| die(&format!("overlay thread: {e}")));

    // Outlives every gxwi-server: restarting the server must not reset the
    // logon throttle.
    let logons = Arc::new(logon::Logons::new(sessions));

    let mut delay = RESTART_DELAY_MIN;
    loop {
        let started = Instant::now();
        match run_server(
            &server,
            &listener,
            unrestricted,
            &logons,
            &overlay,
            &handover,
        ) {
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
    server: &Path,
    listener: &OwnedFd,
    unrestricted: bool,
    logons: &Arc<logon::Logons>,
    overlay: &overlay::Overlay,
    handover: &certificate::Handover,
) -> io::Result<std::process::ExitStatus> {
    // A fresh pair per server: the old one died with the old server.
    let (ours, theirs_low) = UnixStream::pair()?;
    let theirs = dup_high(theirs_low.as_raw_fd())?;
    drop(theirs_low);
    // And a second pair, on which only gxwid speaks: where the overlay
    // stands. It is written before the server exists, to be read first.
    let (overlay_ours, overlay_theirs_low) = UnixStream::pair()?;
    let overlay_theirs = dup_high(overlay_theirs_low.as_raw_fd())?;
    drop(overlay_theirs_low);
    overlay.serve(overlay_ours);
    // And the key and certificate, which the server cannot open for itself,
    // on a socket gxwid keeps for renewals.
    let keys = dup_high(handover.for_server()?.as_raw_fd())?;
    let token = if unrestricted {
        None
    } else {
        Some(
            sandbox::server_token()
                .map_err(|e| io::Error::other(format!("restricted token: {e}")))?,
        )
    };
    // The server can open nothing, the registry included, so what its pages
    // are to say is read here and told to it as it starts.
    let page = if unrestricted {
        settings::LogonPage::default()
    } else {
        settings::logon_page()
    };
    let child = ServerChild(spawn_server(
        server,
        listener,
        &theirs,
        &overlay_theirs,
        &keys,
        token,
        &page,
    )?);
    // Only the server holds its ends now, so its death reads as EOF on ours,
    // which is what ends the control thread.
    drop(theirs);
    drop(overlay_theirs);
    drop(keys);
    let logons = Arc::clone(logons);
    wait_for_server(child, || {
        std::thread::Builder::new()
            .name("control".into())
            .spawn(move || logon::serve_control(ours, logons))
            .map(drop)
    })
}

/// Owns the worker until it has been reaped, including failed control setup.
struct ServerChild(Child);

impl Drop for ServerChild {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(Some(_))) {
            return;
        }
        if let Err(error) = self.0.kill() {
            eprintln!("gxwid: could not stop gxwi-server during cleanup: {error}");
        }
        if let Err(error) = self.0.wait() {
            eprintln!("gxwid: could not reap gxwi-server during cleanup: {error}");
        }
    }
}

fn wait_for_server(
    mut child: ServerChild,
    start_control: impl FnOnce() -> io::Result<()>,
) -> io::Result<std::process::ExitStatus> {
    start_control()?;
    child.0.wait()
}

fn spawn_server(
    server: &Path,
    listener: &OwnedFd,
    channel: &OwnedFd,
    overlay: &OwnedFd,
    keys: &OwnedFd,
    token: Option<peios::token::Token>,
    page: &settings::LogonPage,
) -> io::Result<Child> {
    let (listener, channel, overlay, keys) = (
        listener.as_raw_fd(),
        channel.as_raw_fd(),
        overlay.as_raw_fd(),
        keys.as_raw_fd(),
    );
    let parent = std::process::id() as libc::pid_t;

    let mut cmd = Command::new(server);
    cmd.arg("--listener-fd").arg(SERVER_LISTENER_FD.to_string());
    cmd.arg("--channel-fd").arg(SERVER_CHANNEL_FD.to_string());
    cmd.arg("--overlay-fd").arg(SERVER_OVERLAY_FD.to_string());
    cmd.arg("--tls-fd").arg(SERVER_TLS_FD.to_string());
    if token.is_none() {
        // Without this the server refuses to run outside the restricted token.
        cmd.arg("--unrestricted");
    }
    if let Some(name) = &page.name {
        cmd.arg("--logon-name").arg(name);
    }
    for paragraph in &page.notice {
        cmd.arg("--logon-notice").arg(paragraph);
    }
    // SAFETY: the closure runs in the forked child before exec and makes only
    // system calls (dup2, the token install ioctl, prctl, getppid). gxwid has
    // other threads, any of which may hold a lock at the fork, so nothing here
    // may allocate or take one.
    unsafe {
        cmd.pre_exec(move || {
            // dup2 clears close-on-exec on the copy. Every source is above
            // the targets (dup_high), so no dup2 can clobber another.
            if libc::dup2(listener, SERVER_LISTENER_FD) == -1
                || libc::dup2(channel, SERVER_CHANNEL_FD) == -1
                || libc::dup2(overlay, SERVER_OVERLAY_FD) == -1
                || libc::dup2(keys, SERVER_TLS_FD) == -1
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
    let new = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, FIRST_DUPLICATE_FD) };
    if new == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `new` is a fresh descriptor nothing else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(new) })
}

/// The program of this name that sits beside gxwid, unless `variable` is set
/// and says where it is instead.
fn beside(name: &str, variable: Option<&str>) -> PathBuf {
    if let Some(path) = variable.and_then(std::env::var_os) {
        return PathBuf::from(path);
    }
    let exe = std::env::current_exe().unwrap_or_else(|e| die(&format!("current_exe: {e}")));
    exe.with_file_name(name)
}

fn die(msg: &str) -> ! {
    eprintln!("gxwid: {msg}");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_is_reaped_when_control_startup_fails() {
        const CHILD: &str = "GXWI_TEST_WORKER_CHILD";
        if std::env::var_os(CHILD).is_some() {
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::a_worker_is_reaped_when_control_startup_fails",
            ])
            .env(CHILD, "1")
            .spawn()
            .unwrap();
        let pid = child.id() as libc::pid_t;
        let error = wait_for_server(ServerChild(child), || {
            Err(io::Error::other("control thread unavailable"))
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "control thread unavailable");
        // SAFETY: waitpid receives a valid local status pointer. The child has
        // already been reaped; this verifies cleanup without signalling any PID.
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }

    #[test]
    fn a_workers_exit_status_is_preserved() {
        let child = Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .spawn()
            .unwrap();
        assert_eq!(
            wait_for_server(ServerChild(child), || Ok(()))
                .unwrap()
                .code(),
            Some(7)
        );
    }
}
