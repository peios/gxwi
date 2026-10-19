//! This machine's key and certificate, for the TLS gxwi-server speaks.
//!
//! The key is made once and kept. The certificate is self-signed for it, and
//! lasts a year: [`due`] says when it is to be made again, which is a month
//! before it runs out, and a new one is for the same key, so the machine's
//! identity stays put though the certificate's fingerprint changes. Where the
//! key comes from is behind [`KeySource`], so something that keeps keys for
//! the whole machine can take over from [`StateDirectory`] without anything
//! else here changing.
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

use rcgen::{
    CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose, SanType,
};
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

const DAY_SECONDS: i64 = 24 * 60 * 60;
/// How long a certificate is made for.
const LIFETIME_SECONDS: i64 = 365 * DAY_SECONDS;
/// How long before it runs out a certificate is made again.
const RENEW_BEFORE_SECONDS: i64 = 30 * DAY_SECONDS;
/// How far back a certificate's validity starts: a day, so that a machine
/// whose clock is a little behind another's, as a live medium's can be when
/// it starts, does not serve that one a certificate that is not valid yet.
const BACKDATE_SECONDS: i64 = DAY_SECONDS;

/// What gxwi-server is handed to speak TLS with.
#[derive(Clone)]
pub struct Credentials {
    /// The certificate, DER.
    pub certificate: Vec<u8>,
    /// The private key, PKCS#8 DER.
    pub key: Vec<u8>,
    /// The certificate's SHA-256, as [`fingerprint`] writes it.
    pub fingerprint: String,
}

impl Credentials {
    /// When the certificate is valid from and until, in seconds since the
    /// epoch.
    pub fn validity(&self) -> Option<(i64, i64)> {
        validity(&self.certificate)
    }
}

/// What a renewal made, and what it replaced.
pub struct Renewed {
    pub credentials: Credentials,
    pub previous: Credentials,
    /// The new certificate's subject, as `CN=<name>,O=Peios`.
    pub subject: String,
    /// Why it was made again.
    pub because: &'static str,
}

/// Where this machine's key and certificate come from.
pub trait KeySource {
    /// The key and certificate, made if there are none.
    fn credentials(&self) -> io::Result<Credentials>;
    /// A new certificate for the same key, if [`due`] says `current` is to be
    /// made again at `now`.
    fn renew(&self, current: &Credentials, now: i64) -> io::Result<Option<Renewed>>;
}

/// Whether a certificate valid from `not_before` until `not_after` is to be
/// made again at `now`, and why.
pub fn due(not_before: i64, not_after: i64, now: i64) -> Option<&'static str> {
    if not_after - now < RENEW_BEFORE_SECONDS {
        Some("it runs out within 30 days")
    } else if not_before > now {
        // The clock was ahead when it was made: no browser takes it yet.
        Some("it is not valid yet")
    } else if not_after - not_before > LIFETIME_SECONDS + BACKDATE_SECONDS {
        // Made by a gxwid before certificates lasted a year.
        Some("it lasts longer than a year")
    } else {
        None
    }
}

/// Seconds since the epoch, now.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() as i64)
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
            let key =
                KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(io::Error::other)?;
            self.publish(KEY, key.serialize_pem().as_bytes(), PRIVATE_SD)?;
            eprintln!(
                "gxwid: made a key for this machine in {}",
                key_path.display()
            );
            key
        };

        let certificate_path = self.path.join(CERTIFICATE);
        refuse_links(&certificate_path)?;
        let certificate = if certificate_path.exists() {
            CertificateDer::from_pem_file(&certificate_path)
                .map_err(|e| unreadable(&certificate_path, &e.to_string()))?
                .to_vec()
        } else {
            let (made, _) = certify(&key, &host_name(), now())?;
            self.publish(CERTIFICATE, made.pem().as_bytes(), PUBLIC_SD)?;
            eprintln!(
                "gxwid: made a certificate for this machine's key in {}",
                certificate_path.display()
            );
            made.der().to_vec()
        };
        if validity(&certificate).is_none() {
            return Err(unreadable(&certificate_path, "its validity cannot be read"));
        }
        self.fingerprint_file(&certificate)?;
        Ok(Credentials {
            fingerprint: fingerprint(&certificate),
            certificate,
            key: key.serialize_der(),
        })
    }

    fn renew(&self, current: &Credentials, now: i64) -> io::Result<Option<Renewed>> {
        let (not_before, not_after) = current
            .validity()
            .ok_or_else(|| io::Error::other("the certificate's validity cannot be read"))?;
        let Some(because) = due(not_before, not_after, now) else {
            return Ok(None);
        };
        let key = KeyPair::try_from(current.key.as_slice()).map_err(io::Error::other)?;
        let (made, subject) = certify(&key, &host_name(), now)?;
        // The certificate first: the fingerprint file only ever says what
        // the certificate in place is.
        self.publish(CERTIFICATE, made.pem().as_bytes(), PUBLIC_SD)?;
        let certificate = made.der().to_vec();
        self.fingerprint_file(&certificate)?;
        let credentials = Credentials {
            fingerprint: fingerprint(&certificate),
            certificate,
            key: current.key.clone(),
        };
        Ok(Some(Renewed {
            credentials,
            previous: current.clone(),
            subject,
            because,
        }))
    }
}

impl StateDirectory {
    /// The fingerprint file, written from the certificate whenever it does
    /// not already say the same.
    fn fingerprint_file(&self, certificate: &[u8]) -> io::Result<()> {
        let line = format!("{}\n", fingerprint(certificate));
        let path = self.path.join(FINGERPRINT);
        refuse_links(&path)?;
        if fs::read_to_string(&path).ok().as_deref() != Some(line.as_str()) {
            self.publish(FINGERPRINT, line.as_bytes(), PUBLIC_SD)?;
        }
        Ok(())
    }

    /// Writes `name` beside a staged copy and renames it into place, so that
    /// nothing ever finds half of one.
    fn publish(&self, name: &str, bytes: &[u8], sd: &str) -> io::Result<()> {
        let stage = self.path.join(format!(".{name}.{}", std::process::id()));
        // Failure is checked by create_new: never open an existing staging file.
        let _ = fs::remove_file(&stage);
        let written = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&stage)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            self.protect(&stage, sd)?;
            fs::rename(&stage, self.path.join(name))
        })();
        if written.is_err() {
            // Preserve the original publication error if best-effort cleanup also fails.
            let _ = fs::remove_file(&stage);
        }
        written
    }

    fn protect(&self, path: &Path, sddl: &str) -> io::Result<()> {
        if !self.protect {
            return Ok(());
        }
        use peios::file::SecInfo;
        let sd = peios::security::sddl::parse(sddl)
            .map_err(|e| io::Error::other(format!("{sddl}: {e}")))?;
        peios::file::set_sd(
            None,
            path,
            SecInfo::OWNER | SecInfo::GROUP | SecInfo::DACL,
            &sd,
            libc::AT_SYMLINK_NOFOLLOW,
        )
        .map_err(|e| io::Error::other(format!("{}: descriptor: {e}", path.display())))
    }
}

/// A certificate for `key`, for a server called `name`, valid for a year from
/// `now` (less a day: [`BACKDATE_SECONDS`]), and its subject. Not an authority:
/// trusting it trusts this machine and nothing it might sign.
fn certify(key: &KeyPair, name: &str, now: i64) -> io::Result<(rcgen::Certificate, String)> {
    let time = |at: i64| time::OffsetDateTime::from_unix_timestamp(at).map_err(io::Error::other);
    let mut params = CertificateParams::default();
    params.distinguished_name.push(DnType::CommonName, name);
    params
        .distinguished_name
        .push(DnType::OrganizationName, "Peios");
    // The name the machine had when it was made, and the names that are
    // always this machine. Not its addresses: they are not known yet when
    // gxwid starts, and they change.
    let mut names = vec![name.to_string()];
    if name != "localhost" {
        names.push("localhost".to_string());
    }
    for name in names {
        params
            .subject_alt_names
            .push(SanType::DnsName(name.try_into().map_err(io::Error::other)?));
    }
    params
        .subject_alt_names
        .push(SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    params
        .subject_alt_names
        .push(SanType::IpAddress(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = time(now - BACKDATE_SECONDS)?;
    params.not_after = time(now + LIFETIME_SECONDS)?;
    let made = params.self_signed(key).map_err(io::Error::other)?;
    Ok((made, format!("CN={name},O=Peios")))
}

/// When a certificate is valid from and until, in seconds since the epoch:
/// its `validity`, the fifth field of its `tbsCertificate` (RFC 5280 4.1).
pub fn validity(certificate: &[u8]) -> Option<(i64, i64)> {
    let (_, certificate, _) = der(certificate)?;
    let (tag, tbs, _) = der(certificate)?;
    if tag != 0x30 {
        return None;
    }
    let mut rest = tbs;
    // An explicit version first, in all but the oldest certificates.
    if rest.first() == Some(&0xa0) {
        rest = der(rest)?.2;
    }
    // The serial number, the signature algorithm and the issuer.
    for _ in 0..3 {
        rest = der(rest)?.2;
    }
    let (tag, validity, _) = der(rest)?;
    if tag != 0x30 {
        return None;
    }
    let (from_tag, from, rest) = der(validity)?;
    let (until_tag, until, _) = der(rest)?;
    Some((asn1_time(from_tag, from)?, asn1_time(until_tag, until)?))
}

/// One DER element at the start of `bytes`: its tag, its contents, and what
/// follows it.
fn der(bytes: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = bytes.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (length, rest) = if first & 0x80 == 0 {
        (first as usize, rest)
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let length = rest[..count]
            .iter()
            .fold(0usize, |n, &b| n << 8 | b as usize);
        (length, &rest[count..])
    };
    let (contents, after) = rest.split_at_checked(length)?;
    Some((tag, contents, after))
}

/// A UTCTime (`YYMMDDHHMMSSZ`, 0x17) or GeneralizedTime (`YYYYMMDDHHMMSSZ`,
/// 0x18), in seconds since the epoch.
fn asn1_time(tag: u8, text: &[u8]) -> Option<i64> {
    let digits = text.strip_suffix(b"Z")?;
    if !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    // ASCII validation makes every field boundary a UTF-8 boundary as well.
    let text = std::str::from_utf8(digits).ok()?;
    let (year, rest) = match (tag, text.len()) {
        (0x17, 12) => {
            let year: i32 = text[..2].parse().ok()?;
            (
                if year < 50 { 2000 + year } else { 1900 + year },
                &text[2..],
            )
        }
        (0x18, 14) => (text[..4].parse().ok()?, &text[4..]),
        _ => return None,
    };
    let field = |at: usize| rest.get(at..at + 2)?.parse::<u8>().ok();
    let month = time::Month::try_from(field(0)?).ok()?;
    let date = time::Date::from_calendar_date(year, month, field(2)?).ok()?;
    Some(
        date.with_hms(field(4)?, field(6)?, field(8)?)
            .ok()?
            .assume_utc()
            .unix_timestamp(),
    )
}

/// SHA-256 of the certificate as a browser shows it: uppercase hex, a colon
/// between each byte.
pub fn fingerprint(certificate: &[u8]) -> String {
    digest(certificate)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// SHA-256 of the certificate, as bytes: `object.certificate.digest`.
pub fn digest(certificate: &[u8]) -> Vec<u8> {
    ring::digest::digest(&ring::digest::SHA256, certificate)
        .as_ref()
        .to_vec()
}

/// This machine's name, for its certificate, or `localhost` if it has none
/// that a certificate can carry.
fn host_name() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is ours and its length is passed with it.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let end = buf.iter().position(|&b| b == 0).unwrap_or(0);
    let name = if ok {
        String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase()
    } else {
        String::new()
    };
    let plain = !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        });
    if plain { name } else { "localhost".to_string() }
}

/// A link here could send a key, or the descriptor meant for it, somewhere
/// else.
fn refuse_links(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(io::Error::other(format!(
            "{} is a symbolic link; refusing it",
            path.display()
        ))),
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
        StateDirectory {
            path,
            protect: false,
        }
    }

    #[test]
    fn a_key_is_made_once_and_kept() {
        let dir = scratch("kept");
        let first = dir.credentials().unwrap();
        let again = dir.credentials().unwrap();
        assert_eq!(first.fingerprint, again.fingerprint);
        assert_eq!(first.key, again.key);
        assert_eq!(
            fs::read_to_string(dir.path.join(FINGERPRINT)).unwrap(),
            format!("{}\n", first.fingerprint)
        );
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
        let (certificate, _) = certify(&key, "bedrock", now()).unwrap();
        let der = certificate.der().to_vec();
        // serverAuth, and the name, in the DER.
        assert!(
            der.windows(8)
                .any(|w| w == [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07])
        );
        assert!(der.windows(7).any(|w| w == b"bedrock"));
        assert!(der.windows(9).any(|w| w == b"localhost"));
        assert_eq!(fingerprint(&der).len(), 32 * 3 - 1);
    }

    #[test]
    fn a_certificate_lasts_a_year_from_a_day_ago() {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let now = 1_791_331_200; // 2026-10-07 00:00:00Z
        let (made, subject) = certify(&key, "bedrock", now).unwrap();
        assert_eq!(
            validity(made.der()),
            Some((now - DAY_SECONDS, now + LIFETIME_SECONDS))
        );
        assert_eq!(subject, "CN=bedrock,O=Peios");
        // And past 2049, where a certificate's time is written another way.
        let later = 2_556_144_000; // 2051-01-01
        let (made, _) = certify(&key, "bedrock", later).unwrap();
        assert_eq!(
            validity(made.der()),
            Some((later - DAY_SECONDS, later + LIFETIME_SECONDS))
        );
    }

    #[test]
    fn a_certificate_is_made_again_a_month_before_it_runs_out() {
        let made = 1_791_331_200;
        let (from, until) = (made - DAY_SECONDS, made + LIFETIME_SECONDS);
        assert_eq!(due(from, until, made), None);
        assert_eq!(due(from, until, until - RENEW_BEFORE_SECONDS - 1), None);
        assert!(due(from, until, until - RENEW_BEFORE_SECONDS + 1).is_some());
        assert!(
            due(from, until, until + DAY_SECONDS).is_some(),
            "and one already run out"
        );
        assert!(
            due(made + DAY_SECONDS, made + LIFETIME_SECONDS, made).is_some(),
            "one not valid yet"
        );
        // gxwid 0.0.6's, valid from 2025 until 4096.
        assert!(due(1_735_689_600, 66_334_809_600, made).is_some());
    }

    #[test]
    fn a_renewal_keeps_the_key_and_changes_the_certificate() {
        let dir = scratch("renew");
        let first = dir.credentials().unwrap();
        let (_, until) = first.validity().unwrap();
        assert!(
            dir.renew(&first, now()).unwrap().is_none(),
            "a new certificate is not due"
        );
        let renewed = dir
            .renew(&first, until - DAY_SECONDS)
            .unwrap()
            .expect("due a month before");
        assert_eq!(renewed.credentials.key, first.key);
        assert_ne!(renewed.credentials.fingerprint, first.fingerprint);
        assert_eq!(renewed.previous.fingerprint, first.fingerprint);
        // What is on disk is the new one, and is what gxwid starts with next.
        let again = dir.credentials().unwrap();
        assert_eq!(again.fingerprint, renewed.credentials.fingerprint);
        assert_eq!(
            fs::read_to_string(dir.path.join(FINGERPRINT)).unwrap(),
            format!("{}\n", again.fingerprint)
        );
        fs::remove_dir_all(&dir.path).unwrap();
    }

    #[test]
    fn dates_are_counted_from_1970() {
        assert_eq!(asn1_time(0x17, b"700101000000Z"), Some(0));
        assert_eq!(asn1_time(0x17, b"000301000000Z"), Some(11017 * DAY_SECONDS));
        assert_eq!(asn1_time(0x17, b"261007000000Z"), Some(1_791_331_200));
        assert_eq!(asn1_time(0x18, b"20261007000000Z"), Some(1_791_331_200));
        assert_eq!(asn1_time(0x17, b"2610070000Z"), None);
    }

    #[test]
    fn certificate_times_reject_non_ascii_and_invalid_calendar_fields() {
        for (tag, value) in [
            (0x17, "€000000000Z"),
            (0x18, "20€000000000Z"),
            (0x17, "269999999999Z"),
            (0x17, "260229000000Z"),
            (0x17, "260100000000Z"),
            (0x17, "260101240000Z"),
            (0x17, "260101006000Z"),
            (0x17, "260101000060Z"),
            (0x17, "+10101000000Z"),
        ] {
            assert_eq!(asn1_time(tag, value.as_bytes()), None, "{value:?}");
        }
        assert!(asn1_time(0x17, b"000229000000Z").is_some());
        assert_eq!(asn1_time(0x17, b"500101000000Z"), Some(-631_152_000));
    }

    #[test]
    fn the_fingerprint_reads_as_a_browser_shows_it() {
        assert_eq!(
            fingerprint(b"abc"),
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"
        );
    }
}
