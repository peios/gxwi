//! SIGHUP, as something a thread can wait for.
//!
//! peinit's `reload` sends a service SIGHUP unless it names another way, so
//! `svctl reload gxwid` reaches gxwid as this: it asks gxwid to look at its
//! certificate now rather than at the next daily look. Without a handler the
//! signal would end gxwid.
//!
//! The handler only writes a byte to a pipe, which is all a signal handler
//! may safely do; [`Hangups::wait`] is a poll on the other end.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

static WAKE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_hangup(_: libc::c_int) {
    let fd = WAKE.load(Ordering::Relaxed);
    if fd >= 0 {
        // SAFETY: write(2) is async-signal-safe; the byte is a static. A full
        // pipe already has a wake-up in it, so a failed write loses nothing.
        unsafe { libc::write(fd, [1u8].as_ptr().cast(), 1) };
    }
}

pub struct Hangups {
    read: OwnedFd,
    _write: OwnedFd,
}

impl Hangups {
    /// Catches SIGHUP from now on. Once per process.
    pub fn catch() -> io::Result<Hangups> {
        let mut fds = [0; 2];
        // SAFETY: `fds` is ours, two descriptors long.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: pipe2 just made both, and nothing else owns them.
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        WAKE.store(write.as_raw_fd(), Ordering::Relaxed);
        // SAFETY: a zeroed sigaction with a handler that only writes to a
        // pipe, and SA_RESTART so that a system call it interrupts carries on.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_hangup as extern "C" fn(libc::c_int) as usize;
            action.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            if libc::sigaction(libc::SIGHUP, &action, std::ptr::null_mut()) == -1 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Hangups { read, _write: write })
    }

    /// Waits for a SIGHUP, or for `longest` to pass, whichever is first.
    pub fn wait(&self, longest: Duration) {
        let mut poll = libc::pollfd { fd: self.read.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        let timeout = longest.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: one pollfd of ours.
        unsafe { libc::poll(&mut poll, 1, timeout) };
        // Every hangup that came while waiting is answered by one look.
        let mut drained = [0u8; 64];
        // SAFETY: the buffer is ours; the pipe is non-blocking.
        while unsafe { libc::read(self.read.as_raw_fd(), drained.as_mut_ptr().cast(), drained.len()) } > 0 {}
    }
}
