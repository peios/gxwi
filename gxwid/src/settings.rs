//! What an administrator sets, read from the registry at `Machine\Software\GXWI`.
//!
//! Every setting has a compiled default and the registry only overrides it. A
//! value that is absent leaves the default in force. So does one of the wrong
//! type, or one that makes no sense, and that is said aloud: nothing here
//! repairs a value or guesses at what was meant.
//!
//! Whoever can write this key chooses what runs as everyone who logs on, so
//! its descriptor lets administrators write and nobody else.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use peios::registry::{Key, KeyAccess, OpenFlags, RegValue, ValueType};

pub const KEY: &str = "Machine\\Software\\GXWI";
/// The subkey for what the logon pages say.
const LOGON: &str = "Logon";

const ENOENT: i32 = 2;

/// Long enough for any name, short enough to stay a heading.
const MAX_NAME_CHARS: usize = 64;
/// A notice is read before every logon, so it is kept to what will be read.
const MAX_NOTICE_PARAGRAPHS: usize = 8;
const MAX_NOTICE_CHARS: usize = 2000;

/// What the logon pages say beyond the conversation itself.
#[derive(Debug, Default, PartialEq)]
pub struct LogonPage {
    /// What this machine is called, for someone deciding whether it is the
    /// one they meant to log on to.
    pub name: Option<String>,
    /// Shown before anything is asked, a paragraph to each entry.
    pub notice: Vec<String>,
}

/// `Listen` (REG_SZ): the address and port to serve on, as `0.0.0.0:443`.
/// Read once, when gxwid starts.
pub fn listen(default: SocketAddr) -> SocketAddr {
    let standing = default.to_string();
    open(KEY, &standing)
        .and_then(|key| string(&key, KEY, "Listen", &standing))
        .and_then(|text| kept(KEY, "Listen", &text, listen_from(&text), &standing))
        .unwrap_or(default)
}

/// `Compositor` (REG_SZ): the program a session runs, as the person whose
/// session it is. Read as each session starts.
pub fn compositor(default: &Path) -> PathBuf {
    let standing = default.display().to_string();
    open(KEY, &standing)
        .and_then(|key| string(&key, KEY, "Compositor", &standing))
        .and_then(|text| kept(KEY, "Compositor", &text, compositor_from(&text), &standing))
        .unwrap_or_else(|| default.to_path_buf())
}

/// `Logon\Name` (REG_SZ) and `Logon\Notice` (REG_MULTI_SZ). Read as each
/// gxwi-server starts.
pub fn logon_page() -> LogonPage {
    const STANDING: &str = "nothing";
    let path = format!("{KEY}\\{LOGON}");
    let Some(key) = open(&path, STANDING) else { return LogonPage::default() };
    let name = string(&key, &path, "Name", STANDING)
        .and_then(|text| kept(&path, "Name", &text, name_from(&text), STANDING));
    let notice = strings(&key, &path, "Notice", STANDING)
        .and_then(|entries| kept(&path, "Notice", &entries.join(" / "), notice_from(entries.clone()), STANDING))
        .unwrap_or_default();
    LogonPage { name, notice }
}

fn listen_from(text: &str) -> Result<SocketAddr, String> {
    text.parse().map_err(|e| format!("not an address and port: {e}"))
}

fn compositor_from(text: &str) -> Result<PathBuf, String> {
    if !text.starts_with('/') {
        return Err("not an absolute path".into());
    }
    Ok(PathBuf::from(text))
}

fn name_from(text: &str) -> Result<String, String> {
    if text.is_empty() {
        return Err("empty".into());
    }
    if text.chars().count() > MAX_NAME_CHARS {
        return Err(format!("longer than {MAX_NAME_CHARS} characters"));
    }
    if text.chars().any(char::is_control) {
        return Err("has control characters in it".into());
    }
    Ok(text.to_string())
}

fn notice_from(entries: Vec<String>) -> Result<Vec<String>, String> {
    if entries.len() > MAX_NOTICE_PARAGRAPHS {
        return Err(format!("more than {MAX_NOTICE_PARAGRAPHS} paragraphs"));
    }
    if entries.iter().map(|entry| entry.chars().count()).sum::<usize>() > MAX_NOTICE_CHARS {
        return Err(format!("longer than {MAX_NOTICE_CHARS} characters"));
    }
    if entries.iter().any(|entry| entry.chars().any(char::is_control)) {
        return Err("has control characters in it".into());
    }
    Ok(entries)
}

// Whatever is ignored is named along with `standing`, which is what stays in
// force instead: the log, not the registry, says what gxwid is running on.

/// The value if it made sense, and otherwise the reason it is ignored.
fn kept<T>(path: &str, name: &str, shown: &str, read: Result<T, String>, standing: &str) -> Option<T> {
    match read {
        Ok(value) => Some(value),
        Err(why) => {
            eprintln!("gxwid: ignoring {path}\\{name} = {shown:?}: {why}; still using {standing}");
            None
        }
    }
}

/// A key that is not there is the ordinary case and goes unremarked.
fn open(path: &str, standing: &str) -> Option<Key> {
    match Key::open(None, path, KeyAccess::QUERY_VALUE, OpenFlags::empty()) {
        Ok(key) => Some(key),
        Err(e) if e.raw_os_error() == Some(ENOENT) => None,
        Err(e) => {
            eprintln!("gxwid: {path} could not be opened: {e}; still using {standing}");
            None
        }
    }
}

fn value(key: &Key, path: &str, name: &str, standing: &str) -> Option<RegValue> {
    match key.query_value(name.as_bytes(), None) {
        Ok(value) => Some(value),
        Err(e) if e.raw_os_error() == Some(ENOENT) => None,
        Err(e) => {
            eprintln!("gxwid: {path}\\{name} could not be read: {e}; still using {standing}");
            None
        }
    }
}

fn string(key: &Key, path: &str, name: &str, standing: &str) -> Option<String> {
    let value = value(key, path, name, standing)?;
    let text = sz(&value);
    if text.is_none() {
        eprintln!("gxwid: ignoring {path}\\{name}: not a REG_SZ of text (type {:#x}); still using {standing}", value.ty.0);
    }
    text
}

fn strings(key: &Key, path: &str, name: &str, standing: &str) -> Option<Vec<String>> {
    let value = value(key, path, name, standing)?;
    let entries = multi_sz(&value);
    if entries.is_none() {
        eprintln!("gxwid: ignoring {path}\\{name}: not a REG_MULTI_SZ of text (type {:#x}); still using {standing}", value.ty.0);
    }
    entries
}

/// A REG_SZ is text up to its first NUL.
fn sz(value: &RegValue) -> Option<String> {
    if value.ty != ValueType::SZ {
        return None;
    }
    let bytes = value.data.split(|&byte| byte == 0).next()?;
    std::str::from_utf8(bytes).ok().map(|text| text.trim().to_string())
}

/// A REG_MULTI_SZ is strings that each end in a NUL, and one NUL more. Empty
/// entries are dropped, so a writer that left the last NUL off reads the same.
fn multi_sz(value: &RegValue) -> Option<Vec<String>> {
    if value.ty != ValueType::MULTI_SZ {
        return None;
    }
    let mut entries = Vec::new();
    for bytes in value.data.split(|&byte| byte == 0) {
        let text = std::str::from_utf8(bytes).ok()?.trim();
        if !text.is_empty() {
            entries.push(text.to_string());
        }
    }
    Some(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(ty: ValueType, data: &[u8]) -> RegValue {
        RegValue { sequence: 1, ty, data: data.to_vec(), layer: Vec::new() }
    }

    #[test]
    fn a_value_of_the_wrong_type_is_no_value() {
        assert_eq!(sz(&stored(ValueType::SZ, b"/bin/fenestra\0")), Some("/bin/fenestra".into()));
        assert_eq!(sz(&stored(ValueType::MULTI_SZ, b"/bin/fenestra\0\0")), None);
        assert_eq!(sz(&stored(ValueType::SZ, b"\xff\0")), None);
        assert_eq!(multi_sz(&stored(ValueType::MULTI_SZ, b"one\0two\0\0")), Some(vec!["one".into(), "two".into()]));
        assert_eq!(multi_sz(&stored(ValueType::MULTI_SZ, b"one\0two")), Some(vec!["one".into(), "two".into()]));
        assert_eq!(multi_sz(&stored(ValueType::SZ, b"one\0")), None);
    }

    #[test]
    fn what_makes_no_sense_is_refused_rather_than_mended() {
        assert!(listen_from("0.0.0.0:7780").is_ok());
        assert!(listen_from("[::]:443").is_ok());
        assert!(listen_from("7780").is_err());
        assert!(listen_from("localhost:7780").is_err());
        assert!(compositor_from("/bin/fenestra").is_ok());
        assert!(compositor_from("fenestra").is_err());
        assert!(compositor_from("").is_err());
        assert!(name_from("Build server 3").is_ok());
        assert!(name_from("").is_err());
        assert!(name_from(&"x".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert!(name_from("two\nlines").is_err());
        assert!(notice_from(vec!["Authorised use only.".into()]).is_ok());
        assert!(notice_from(vec!["x".repeat(MAX_NOTICE_CHARS + 1)]).is_err());
        assert!(notice_from(vec!["x".into(); MAX_NOTICE_PARAGRAPHS + 1]).is_err());
    }
}
