//! Keeping gxwi-server's certificate current.
//!
//! gxwid holds the key and certificate (`tls`) and hands them to each
//! gxwi-server on a socket of their own, which it keeps. A certificate is
//! renewed once fewer than 30 days of it remain: gxwid looks as it starts,
//! once a day while it runs, and whenever it is sent SIGHUP (`svctl reload
//! gxwid`). The new certificate goes down the running server's socket, and
//! the server takes it for every connection from then on. Nothing is
//! restarted, and nobody signed in is signed out.
//!
//! On the socket, each message is a little-endian u32 length and then the
//! credentials: the certificate and the key, each a little-endian u32 length
//! and then the bytes.

use std::io::{self, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::hangup::Hangups;
use crate::tls::{self, Credentials, KeySource, Renewed};

/// How often gxwid looks at its certificate while it runs.
const LOOK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// The credentials in force, and the socket to the server running now.
pub struct Handover {
    credentials: Mutex<Credentials>,
    server: Mutex<Option<UnixStream>>,
}

impl Handover {
    pub fn new(credentials: Credentials) -> Arc<Handover> {
        Arc::new(Handover { credentials: Mutex::new(credentials), server: Mutex::new(None) })
    }

    pub fn fingerprint(&self) -> String {
        self.credentials.lock().unwrap_or_else(|e| e.into_inner()).fingerprint.clone()
    }

    /// The server's end of a new socket, with the credentials in force
    /// already written to it. gxwid keeps the other end, for renewals, until
    /// the next server's replaces it.
    pub fn for_server(&self) -> io::Result<OwnedFd> {
        let (mut ours, theirs) = UnixStream::pair()?;
        ours.write_all(&message(&self.credentials.lock().unwrap_or_else(|e| e.into_inner())))?;
        *self.server.lock().unwrap_or_else(|e| e.into_inner()) = Some(ours);
        Ok(OwnedFd::from(theirs))
    }

    /// Puts `credentials` in force, here and in the server running now. A
    /// server that cannot be told is between restarts, and the next one is
    /// handed these.
    fn renewed(&self, credentials: Credentials) {
        let message = message(&credentials);
        *self.credentials.lock().unwrap_or_else(|e| e.into_inner()) = credentials;
        if let Some(server) = self.server.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            if let Err(e) = server.write_all(&message) {
                eprintln!("gxwid: could not give gxwi-server the new certificate ({e}); the next one starts with it");
            }
        }
    }
}

fn message(credentials: &Credentials) -> Vec<u8> {
    let mut body = Vec::new();
    for part in [&credentials.certificate, &credentials.key] {
        body.extend_from_slice(&(part.len() as u32).to_le_bytes());
        body.extend_from_slice(part);
    }
    let mut message = (body.len() as u32).to_le_bytes().to_vec();
    message.extend(body);
    message
}

/// Renews `current` now if it is due, before any server is handed it.
pub fn renew_now(keys: &dyn KeySource, current: Credentials) -> Credentials {
    match keys.renew(&current, tls::now()) {
        Ok(Some(renewed)) => {
            said(&renewed);
            renewed.credentials
        }
        Ok(None) => current,
        Err(e) => {
            eprintln!("gxwid: could not renew the certificate: {e}; serving the one there is");
            current
        }
    }
}

/// Looks at the certificate once a day, and on SIGHUP, for as long as gxwid
/// runs, and renews it when it is due.
pub fn keep(keys: Box<dyn KeySource + Send>, handover: Arc<Handover>, hangups: Hangups) {
    loop {
        hangups.wait(LOOK_EVERY);
        let current = handover.credentials.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match keys.renew(&current, tls::now()) {
            Ok(Some(renewed)) => {
                said(&renewed);
                handover.renewed(renewed.credentials);
            }
            Ok(None) => {}
            Err(e) => eprintln!("gxwid: could not renew the certificate: {e}; trying again tomorrow"),
        }
    }
}

/// A renewal, said in gxwid's log and recorded as `gxwid.certificate.renewed`.
fn said(renewed: &Renewed) {
    eprintln!(
        "gxwid: renewed the certificate, because {}: its SHA-256 was {} and is now {}",
        renewed.because, renewed.previous.fingerprint, renewed.credentials.fingerprint
    );
    let mut writer = peios::msgpack::Writer::new();
    writer.write_map(1).write_str("object");
    writer.write_map(1).write_str("certificate");
    writer.write_map(3);
    writer.write_str("digest").write_bin(&tls::digest(&renewed.credentials.certificate));
    writer.write_str("digest-previous").write_bin(&tls::digest(&renewed.previous.certificate));
    writer.write_str("name").write_str(&renewed.subject);
    // Essential: renewing the certificate changes what everyone who connects
    // is shown, so it is never switched off, and the policy is not asked.
    let recorded = writer.to_bytes().and_then(|payload| peios::event::emit("gxwid.certificate.renewed", &payload));
    if let Err(e) = recorded {
        eprintln!("gxwid: could not record gxwid.certificate.renewed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn credentials(certificate: &[u8]) -> Credentials {
        Credentials { certificate: certificate.to_vec(), key: b"key".to_vec(), fingerprint: String::new() }
    }

    #[test]
    fn a_server_is_handed_what_is_in_force_and_then_each_renewal() {
        let handover = Handover::new(credentials(b"first"));
        let mut theirs = UnixStream::from(handover.for_server().unwrap());
        handover.renewed(credentials(b"second"));
        let mut read = Vec::new();
        theirs.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut buf = [0u8; 256];
        while read.len() < message(&credentials(b"first")).len() + message(&credentials(b"second")).len() {
            let n = theirs.read(&mut buf).unwrap();
            read.extend_from_slice(&buf[..n]);
        }
        let mut expected = message(&credentials(b"first"));
        expected.extend(message(&credentials(b"second")));
        assert_eq!(read, expected);
        // And a server started after a renewal starts with it.
        let mut next = UnixStream::from(handover.for_server().unwrap());
        let mut first = vec![0u8; message(&credentials(b"second")).len()];
        next.read_exact(&mut first).unwrap();
        assert_eq!(first, message(&credentials(b"second")));
    }
}
