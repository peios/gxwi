//! This machine's key and certificate, for the TLS gxwi-server speaks.
//!
//! The certificate is self-signed and made once for its key: what an
//! administrator compares, the certificate's SHA-256 fingerprint, stays the
//! same for as long as the key does. Where the key comes from is behind
//! [`KeySource`], so something that keeps keys for the whole machine can take
//! over from [`StateDirectory`] without anything else here changing.
//!
//! Whether the key lasts is the directory's to say, not this module's. On a
//! live medium `/var/state` is in memory, so each boot makes a new key; on an
//! installed system it is on disk and the key is kept. The installer carries
//! a live medium's key into the system it installs, so a browser that set the
//! machine up goes on trusting it.

use std::fs;
use std::io::{self, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

use rcgen::{CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose, SanType};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

/// Where the key and certificate are kept.
pub const DIRECTORY: &str = "/var/state/gxwi";
/// The private key, PKCS#8 in PEM. Readable by SYSTEM alone.
pub const KEY: &str = "key.pem";
/// The certificate, in PEM: what a browser or a machine imports to trust this
/// one. Readable by everyone.
pub const CERTIFICATE: &str = "certificate.pem";
/// The certificate's SHA-256 fingerprint, as colon-separated hex on one line:
/// what a browser shows for it. Readable by everyone.
pub const FINGERPRINT: &str = "certificate.sha256";

/// SYSTEM alone, and everything made inside inherits it. gxwid and the
/// installer, which carries the key into an installed system, both run as
/// SYSTEM.
const DIRECTORY_SD: &str = "O:SYG:SYD:P(A;OICI;GA;;;SY)";
/// What anyone may read: the certificate and its fingerprint.
const PUBLIC_SD: &str = "O:SYG:SYD:P(A;;GA;;;SY)(A;;GR;;;WD)";
const PRIVATE_SD: &str = "O:SYG:SYD:P(A;;GA;;;SY)";

/// A certificate made now is valid from this date, whatever the clock says: a
/// machine whose clock is wrong when it first starts must not make one that
/// is not valid yet. And for as long as anything will read it.
const VALID_FROM: (i32, u8, u8) = (2025, 1, 1);
const VALID_UNTIL: (i32, u8, u8) = (4096, 1, 1);

/// What gxwi-server is handed to speak TLS with.
pub struct Credentials {
    /// The certificate, DER.
    pub certificate: Vec<u8>,
    /// The private key, PKCS#8 DER.
    pub key: Vec<u8>,
    /// The certificate's SHA-256, as [`fingerprint`] writes it.
    pub fingerprint: String,
}

/// Where this machine's key and certificate come from.
pub trait KeySource {
    fn credentials(&self) -> io::Result<Credentials>;
}

/// A directory gxwid keeps them in, making them the first time.
pub struct StateDirectory {
    pub path: PathBuf,
    /// Whether to set descriptors: not on a host without KACS.
    pub protect: bool,
}

impl KeySource for StateDirectory {
    fn credentials(&self) -> io::Result<Credentials> {
        fs::create_dir_all(&self.path)?;
        refuse_links(&self.path)?;
        // Before anything is made in it, so that the key is SYSTEM's alone
        // from the moment it exists.
        self.protect(&self.path, DIRECTORY_SD)?;
        let key_path = self.path.join(KEY);
        refuse_links(&key_path)?;
        let key = if key_path.exists() {
            // A key that cannot be read is said aloud, never replaced: a new
            // one would quietly change what everyone has learnt to trust.
            let pem = fs::read(&key_path)?;
            let der = match PrivateKeyDer::from_pem_slice(&pem) {
                Ok(PrivateKeyDer::Pkcs8(der)) => der.secret_pkcs8_der().to_vec(),
                _ => return Err(unreadable(&key_path, "not a PKCS#8 private key in PEM")),
            };
            KeyPair::try_from(der.as_slice()).map_err(|e| unreadable(&key_path, &e.to_string()))?
        } else {
            let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(io::Error::other)?;
            self.publish(KEY, key.serialize_pem().as_bytes(), PRIVATE_SD)?;
            eprintln!("gxwid: made a key for this machine in {}", key_path.display());
            key
        };

        let certificate_path = self.path.join(CERTIFICATE);
        refuse_links(&certificate_path)?;
        let certificate = if certificate_path.exists() {
            CertificateDer::from_pem_file(&certificate_path)
                .map_err(|e| unreadable(&certificate_path, &e.to_string()))?
                .to_vec()
        } else {
            let made = certify(&key, &host_name())?;
            self.publish(CERTIFICATE, made.pem().as_bytes(), PUBLIC_SD)?;
            eprintln!("gxwid: made a certificate for this machine's key in {}", certificate_path.display());
            made.der().to_vec()
        };

        let fingerprint = fingerprint(&certificate);
        // Written every time, from the certificate: it is only ever what the
        // certificate says.
        let fingerprint_path = self.path.join(FINGERPRINT);
        refuse_links(&fingerprint_path)?;
        if fs::read_to_string(&fingerprint_path).ok().as_deref() != Some(&format!("{fingerprint}\n")) {
            self.publish(FINGERPRINT, format!("{fingerprint}\n").as_bytes(), PUBLIC_SD)?;
        }
        Ok(Credentials { certificate, key: key.serialize_der(), fingerprint })
    }
}

impl StateDirectory {
    /// Writes `name` beside a staged copy and renames it into place, so that
    /// nothing ever finds half of one.
    fn publish(&self, name: &str, bytes: &[u8], sd: &str) -> io::Result<()> {
        let stage = self.path.join(format!(".{name}.{}", std::process::id()));
        let _ = fs::remove_file(&stage);
        let written = (|| {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&stage)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            self.protect(&stage, sd)?;
            fs::rename(&stage, self.path.join(name))
        })();
        if written.is_err() {
            let _ = fs::remove_file(&stage);
        }
        written
    }

    fn protect(&self, path: &Path, sddl: &str) -> io::Result<()> {
        if !self.protect {
            return Ok(());
        }
        use peios::file::SecInfo;
        let sd = peios::security::sddl::parse(sddl).map_err(|e| io::Error::other(format!("{sddl}: {e}")))?;
        peios::file::set_sd(None, path, SecInfo::OWNER | SecInfo::GROUP | SecInfo::DACL, &sd, libc::AT_SYMLINK_NOFOLLOW)
            .map_err(|e| io::Error::other(format!("{}: descriptor: {e}", path.display())))
    }
}

/// A certificate for `key`, for a server called `name`. Not an authority:
/// trusting it trusts this machine and nothing it might sign.
fn certify(key: &KeyPair, name: &str) -> io::Result<rcgen::Certificate> {
    let mut params = CertificateParams::default();
    params.distinguished_name.push(DnType::CommonName, name);
    params.distinguished_name.push(DnType::OrganizationName, "Peios");
    // The name the machine had when it was made, and the names that are
    // always this machine. Not its addresses: they are not known yet when
    // gxwid starts, and they change.
    let mut names = vec![name.to_string()];
    if name != "localhost" {
        names.push("localhost".to_string());
    }
    for name in names {
        params.subject_alt_names.push(SanType::DnsName(name.try_into().map_err(io::Error::other)?));
    }
    params.subject_alt_names.push(SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    params.subject_alt_names.push(SanType::IpAddress(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = rcgen::date_time_ymd(VALID_FROM.0, VALID_FROM.1, VALID_FROM.2);
    params.not_after = rcgen::date_time_ymd(VALID_UNTIL.0, VALID_UNTIL.1, VALID_UNTIL.2);
    params.self_signed(key).map_err(io::Error::other)
}

/// SHA-256 of the certificate as a browser shows it: uppercase hex, a colon
/// between each byte.
pub fn fingerprint(certificate: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, certificate);
    digest.as_ref().iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// This machine's name, for its certificate, or `localhost` if it has none
/// that a certificate can carry.
fn host_name() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is ours and its length is passed with it.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let end = buf.iter().position(|&b| b == 0).unwrap_or(0);
    let name = if ok { String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase() } else { String::new() };
    let plain = !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        });
    if plain { name } else { "localhost".to_string() }
}

/// A link here could send a key, or the descriptor meant for it, somewhere
/// else.
fn refuse_links(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(io::Error::other(format!("{} is a symbolic link; refusing it", path.display())))
        }
        _ => Ok(()),
    }
}

fn unreadable(path: &Path, why: &str) -> io::Error {
    io::Error::other(format!(
        "{} cannot be used ({why}). It is not replaced by itself: move it aside to have gxwid make a new key, \
         and expect browsers to warn about the new certificate.",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> StateDirectory {
        let path = std::env::temp_dir().join(format!("gxwid-tls-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        StateDirectory { path, protect: false }
    }

    #[test]
    fn a_key_is_made_once_and_kept() {
        let dir = scratch("kept");
        let first = dir.credentials().unwrap();
        let again = dir.credentials().unwrap();
        assert_eq!(first.fingerprint, again.fingerprint);
        assert_eq!(first.key, again.key);
        assert_eq!(fs::read_to_string(dir.path.join(FINGERPRINT)).unwrap(), format!("{}\n", first.fingerprint));
        fs::remove_dir_all(&dir.path).unwrap();
    }

    #[test]
    fn a_key_that_cannot_be_read_is_not_replaced() {
        let dir = scratch("unreadable");
        fs::create_dir_all(&dir.path).unwrap();
        fs::write(dir.path.join(KEY), "not a key").unwrap();
        assert!(dir.credentials().is_err());
        assert_eq!(fs::read_to_string(dir.path.join(KEY)).unwrap(), "not a key");
        fs::remove_dir_all(&dir.path).unwrap();
    }

    #[test]
    fn a_missing_certificate_is_made_again_for_the_same_key() {
        let dir = scratch("certificate");
        let first = dir.credentials().unwrap();
        fs::remove_file(dir.path.join(CERTIFICATE)).unwrap();
        let again = dir.credentials().unwrap();
        assert_eq!(first.key, again.key);
        fs::remove_dir_all(&dir.path).unwrap();
    }

    #[test]
    fn the_certificate_is_for_a_server_and_is_no_authority() {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let certificate = certify(&key, "bedrock").unwrap();
        let der = certificate.der().to_vec();
        // serverAuth, and the name, in the DER.
        assert!(der.windows(8).any(|w| w == [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07]));
        assert!(der.windows(7).any(|w| w == b"bedrock"));
        assert!(der.windows(9).any(|w| w == b"localhost"));
        assert_eq!(fingerprint(&der).len(), 32 * 3 - 1);
    }

    #[test]
    fn the_fingerprint_reads_as_a_browser_shows_it() {
        assert_eq!(
            fingerprint(b"abc"),
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"
        );
    }
}
