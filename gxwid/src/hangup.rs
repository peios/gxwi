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

// Initialized once at startup. The certificate keeper owns both pipe ends until
// process exit, so a signal never sees a descriptor reused for another resource.
static WAKE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_hangup(_: libc::c_int) {
    wake(WAKE.load(Ordering::Relaxed));
}

/// Wake the keeper without changing the interrupted operation's error state.
fn wake(fd: libc::c_int) {
    if fd < 0 {
        return;
    }
    // SAFETY: Linux exposes this thread's live errno slot. write is
    // async-signal-safe, the byte lives through the call, and errno is restored
    // before returning to the interrupted code. A full nonblocking pipe already
    // contains a wakeup, so a failed write needs no additional action.
    unsafe {
        let errno = libc::__errno_location();
        let saved = *errno;
        libc::write(fd, [1u8].as_ptr().cast(), 1);
        *errno = saved;
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
        Ok(Hangups {
            read,
            _write: write,
        })
    }

    /// Waits for a SIGHUP, or for `longest` to pass, whichever is first.
    pub fn wait(&self, longest: Duration) {
        let mut poll = libc::pollfd {
            fd: self.read.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let timeout = longest.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: one pollfd of ours.
        unsafe { libc::poll(&mut poll, 1, timeout) };
        // Every hangup that came while waiting is answered by one look.
        let mut drained = [0u8; 64];
        // SAFETY: the buffer is ours; the pipe is non-blocking.
        while unsafe {
            libc::read(
                self.read.as_raw_fd(),
                drained.as_mut_ptr().cast(),
                drained.len(),
            )
        } > 0
        {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signal_wakeup_preserves_errno_even_when_the_pipe_is_full() {
        let mut fds = [0; 2];
        // SAFETY: pipe2 writes exactly two descriptors into our initialized array.
        assert_eq!(
            unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) },
            0
        );
        // SAFETY: pipe2 created these descriptors and no other owner exists.
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        // SAFETY: errno belongs to this thread and remains live throughout the test.
        unsafe { *libc::__errno_location() = libc::ERANGE };
        wake(write.as_raw_fd());
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ERANGE)
        );
        let mut byte = [0];
        // SAFETY: read owns the descriptor and byte is a writable one-byte buffer.
        assert_eq!(
            unsafe { libc::read(read.as_raw_fd(), byte.as_mut_ptr().cast(), 1) },
            1
        );
        assert_eq!(byte, [1]);

        let bytes = [0u8; 4096];
        // SAFETY: the descriptor and complete input buffer remain live; writes
        // are nonblocking and stop when this private pipe is full.
        while unsafe { libc::write(write.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) } > 0 {}
        assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
        // SAFETY: set this thread's errno to distinguish it from write's EAGAIN.
        unsafe { *libc::__errno_location() = libc::ERANGE };
        wake(write.as_raw_fd());
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ERANGE)
        );
    }
}
