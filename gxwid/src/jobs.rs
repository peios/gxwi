//! A client for peinit's jobs channel (PSPU §7), as much of it as gxwid needs.
//!
//! One `SOCK_SEQPACKET` connection to peinit, one JSON object per message. A
//! `submit` carries the job's identity as a `KACS_SCM_TOKEN`: the kernel gates
//! the attach and peinit makes the job's primary token from it, so gxwid never
//! installs a user's token and is never the parent of a user's process.
//! Descriptors ride along as `SCM_RIGHTS` and the job finds them from fd 3.

use std::io;
use std::os::fd::{AsFd, BorrowedFd, FromRawFd, OwnedFd};

use serde_json::{Value, json};

const JOBS_SOCKET_PATH: &str = "/run/services/peinit/jobs.sock";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

pub struct Jobs(OwnedFd);

pub struct Submitted {
    pub id: String,
    pub state: String,
    pub cause: Option<String>,
    /// A handle on the job's process, which comes with a job that is running
    /// and reads as ready once that process has gone.
    pub process: Option<OwnedFd>,
}

impl Jobs {
    pub fn connect() -> io::Result<Jobs> {
        let path = std::env::var("GXWI_JOBS_SOCKET").unwrap_or_else(|_| JOBS_SOCKET_PATH.into());
        // SAFETY: a zeroed sockaddr_un is a valid one.
        let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        if path.len() >= addr.sun_path.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "jobs socket path too long",
            ));
        }
        for (to, from) in addr.sun_path.iter_mut().zip(path.bytes()) {
            *to = from as libc::c_char;
        }
        // SAFETY: the descriptor is checked before it is owned, and the
        // address is the one filled in above with its true length.
        unsafe {
            let fd = libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0);
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let sock = OwnedFd::from_raw_fd(fd);
            let len =
                (std::mem::size_of::<libc::sa_family_t>() + path.len() + 1) as libc::socklen_t;
            if libc::connect(fd, (&raw const addr).cast(), len) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Jobs(sock))
        }
    }

    /// Submits a job to run as `token`, holding `descriptors`, which the
    /// definition names in the same order.
    pub fn submit(
        &mut self,
        mut definition: Value,
        token: BorrowedFd<'_>,
        descriptors: &[BorrowedFd<'_>],
    ) -> io::Result<Submitted> {
        definition["command"] = json!("submit");
        let request = serde_json::to_vec(&definition)?;
        peios::socket::send_message(self.0.as_fd(), &request, Some(token), descriptors, 0)?;

        // The answer to a running job brings a handle on its process. A
        // session is watched by its socket instead and lets the handle go; the
        // overlay, which gxwid has to start again, keeps it.
        let (job, mut descriptors) = self.answer("refused the job")?;
        Ok(Submitted {
            id: job["id"].as_str().unwrap_or_default().into(),
            state: job["state"].as_str().unwrap_or("?").into(),
            cause: job["cause"].as_str().map(str::to_string),
            process: descriptors.pop(),
        })
    }

    /// Ends the job `id` and returns once it has ended: peinit asks the
    /// process to go, and kills what is left when the job's own stop timeout
    /// has passed. Ending a job that has ended already is no error.
    pub fn stop(&mut self, id: &str) -> io::Result<()> {
        let request = serde_json::to_vec(&json!({ "command": "stop", "job_id": id }))?;
        peios::socket::send_message(self.0.as_fd(), &request, None, &[], 0)?;
        self.answer("would not stop the job").map(drop)
    }

    /// peinit's answer to the request just sent: the job as it now stands,
    /// and whatever descriptors came with it.
    fn answer(&mut self, refused: &str) -> io::Result<(Value, Vec<OwnedFd>)> {
        let mut buf = vec![0u8; MAX_RESPONSE_BYTES];
        let got = peios::socket::recv_message(self.0.as_fd(), &mut buf, 1, 0)?;
        if got.len == 0 || got.truncated {
            return Err(io::Error::other("peinit's answer could not be read"));
        }
        let mut answer: Value =
            serde_json::from_slice(&buf[..got.len]).map_err(io::Error::other)?;
        if answer["status"] != "ok" {
            let (code, message) = (
                answer["code"].as_str().unwrap_or("?"),
                answer["message"].as_str().unwrap_or(""),
            );
            return Err(io::Error::other(format!(
                "peinit {refused}: {code}: {message}"
            )));
        }
        Ok((answer["job"].take(), got.fds))
    }
}
