//! Icons, as PGSS Icons (§4) has them: an icon is a name, a theme is a
//! directory of SVG files named that way, and a file says what it looks
//! like by carrying a name, in an extended attribute or in a section of its
//! own if it is a program.
//!
//! An app that wants an icon of its own puts one in the base theme and
//! carries the name:
//!
//! ```ignore
//! gxwi::icon!(b"dev.peios.gxwi.hello");
//! ```
//!
//! A consumer, which on a Fenestra desktop is Fenestra for every page there
//! is, works out the name for a file with [`identify`] and the file for a
//! name with [`Themes::find`]. Nothing here is Fenestra's: a program that
//! lists files does the same.

use std::path::{Path, PathBuf};

use peios::registry::{Key, KeyAccess, OpenFlags, ValueType};

/// Where the themes are: `/usr/share/icons/<theme>/<id>.svg`.
pub const THEMES: &str = "/usr/share/icons";
/// The theme every other stands on. It is always the last in the chain,
/// whatever the chain says, and it is where an app's own icon goes.
pub const BASE: &str = "base";
/// Where the chain is set: a REG_MULTI_SZ of theme names, first consulted
/// first. Absent, or unreadable, means the base theme alone.
pub const THEMES_KEY: &str = "Machine\\Generic\\Icons";
pub const THEMES_VALUE: &str = "Themes";
/// The extended attribute a file's owner sets to say what it looks like.
pub const XATTR: &str = "user.pgss.icon";
/// The section a program carries its icon's name in.
pub const SECTION: &str = ".pgss.icon";
/// The last resort, which the base theme has.
pub const GENERIC: &str = "generic";
/// The longest name there is. Longer is no name.
pub const MAX_ID_BYTES: usize = gxwi_abi::MAX_ICON_ID_BYTES;

/// Puts an icon's name in this program, where a consumer looks for it.
/// `$id` is a byte string: `icon!(b"dev.peios.gxwi.hello")`.
#[macro_export]
macro_rules! icon {
    ($id:literal) => {
        #[used]
        #[unsafe(link_section = ".pgss.icon")]
        static PGSS_ICON: [u8; $id.len()] = *$id;
    };
}

/// Whether `text` is a name an icon may have: lowercase ASCII letters,
/// digits, `.`, `_` and `-`, beginning with a letter or digit.
pub fn is_id(text: &str) -> bool {
    gxwi_abi::is_icon_id(text)
}

/// Where a live surface's HTML finds the icon named `id`: the page is at
/// `/.fx/live/<n>`, and the icons are beside it at `/.fx/icon/<id>`.
pub fn href(id: &str) -> String {
    format!("../icon/{id}")
}

/// The theme chain: the directories a name is looked for in, in order.
#[derive(Clone, Debug)]
pub struct Themes {
    directories: Vec<PathBuf>,
}

impl Themes {
    /// The chain the registry names, and the base theme after it.
    pub fn active() -> Themes {
        let mut names = named();
        names.retain(|name| name != BASE);
        names.push(BASE.into());
        Themes::of(
            names
                .iter()
                .map(|name| Path::new(THEMES).join(name))
                .collect(),
        )
    }

    /// A chain of these directories, as given.
    pub fn of(directories: Vec<PathBuf>) -> Themes {
        Themes { directories }
    }

    /// The file for `id`: the first theme's that has one.
    pub fn find(&self, id: &str) -> Option<PathBuf> {
        if !is_id(id) {
            return None;
        }
        self.directories
            .iter()
            .map(|directory| directory.join(format!("{id}.svg")))
            .find(|file| file.is_file())
    }

    pub fn has(&self, id: &str) -> bool {
        self.find(id).is_some()
    }
}

/// The theme names the registry gives, in order. A name that could not be a
/// directory's is left out, and said.
fn named() -> Vec<String> {
    let opened = Key::open(None, THEMES_KEY, KeyAccess::QUERY_VALUE, OpenFlags::empty())
        .and_then(|key| key.query_value(THEMES_VALUE.as_bytes(), None));
    let Ok(value) = opened else { return Vec::new() };
    if value.ty != ValueType::MULTI_SZ {
        eprintln!("{THEMES_KEY}\\{THEMES_VALUE} is not a REG_MULTI_SZ; using the base theme alone");
        return Vec::new();
    }
    value
        .data
        .split(|&byte| byte == 0)
        .filter_map(|bytes| std::str::from_utf8(bytes).ok())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .filter(|name| {
            let fit = is_id(name);
            if !fit {
                eprintln!("{THEMES_KEY}\\{THEMES_VALUE} names {name:?}, which no theme can be called; leaving it out");
            }
            fit
        })
        .map(String::from)
        .collect()
}

/// The name of the icon for the file at `path`, as PGSS Icons §4.5 finds it,
/// among those `themes` has: what the file's owner says, then what the
/// program says of itself, then what its name says, then what its type
/// says, and `generic` when none of those is an icon in the chain. A
/// specification that says more about a kind of file is applied before
/// this, by whoever implements it.
pub fn identify(path: &Path, themes: &Themes) -> String {
    identify_named(
        path,
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
        themes,
    )
}

/// [`identify`] for a file whose name is not the path's last part: a
/// running program, reached through `/proc/<pid>/exe`, which is the program
/// whether or not the path it was started from is still there.
pub fn identify_named(path: &Path, name: &str, themes: &Themes) -> String {
    let Ok(metadata) = std::fs::metadata(path) else {
        return GENERIC.into();
    };
    let mut candidates = Vec::new();
    if let Some(said) = xattr(path) {
        candidates.push(said);
    }
    if metadata.is_file()
        && let Some(carried) = section(path)
    {
        candidates.push(carried);
    }
    let named = format!(
        "{}-{}",
        if metadata.is_dir() {
            "directory"
        } else {
            "file"
        },
        name.to_ascii_lowercase()
    );
    if is_id(&named) {
        candidates.push(named);
    }
    if let Some(media) = media_type(Path::new(name), &metadata) {
        candidates.extend(type_ids(&media));
    }
    candidates
        .into_iter()
        .find(|id| themes.has(id))
        .unwrap_or_else(|| GENERIC.into())
}

/// What the file's owner says it looks like, if that is a name.
fn xattr(path: &Path) -> Option<String> {
    let cpath = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
    let name = std::ffi::CString::new(XATTR).ok()?;
    let mut buf = [0u8; MAX_ID_BYTES + 1];
    // SAFETY: both strings are NUL-terminated and live for the call, and the
    // buffer is as long as it is said to be.
    let got = unsafe {
        libc::getxattr(
            cpath.as_ptr(),
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if got <= 0 {
        return None;
    }
    let text = std::str::from_utf8(&buf[..got as usize])
        .ok()?
        .trim_end_matches('\0');
    is_id(text).then(|| text.to_string())
}

/// What a program says of itself: the `.pgss.icon` section of an ELF file,
/// if it has one and it holds a name.
fn section(path: &Path) -> Option<String> {
    let bytes = elf::section(path, SECTION)?;
    let text = std::str::from_utf8(&bytes).ok()?.trim_end_matches('\0');
    is_id(text).then(|| text.to_string())
}

/// The names a media type gives: the type itself, then its top-level type.
fn type_ids(media: &str) -> Vec<String> {
    let id = |text: &str| -> String {
        text.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect()
    };
    let mut ids = vec![id(media)];
    if let Some((top, _)) = media.split_once('/') {
        ids.push(id(top));
    }
    ids.retain(|candidate| is_id(candidate));
    ids
}

/// The media type of a file, from what can be seen without reading it:
/// whether it is a directory, its extension, and whether it may be run. How
/// a type is found is no part of PGSS Icons; this is what gxwi does, and
/// an app that shows what a file is may show this until there is something
/// that says it better.
pub fn media_type(path: &Path, metadata: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    if metadata.is_dir() {
        return Some("inode/directory".into());
    }
    if !metadata.is_file() {
        return None;
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let by_extension = extension.as_deref().and_then(|extension| {
        BY_EXTENSION
            .iter()
            .find(|(known, _)| *known == extension)
            .map(|(_, media)| media.to_string())
    });
    by_extension.or_else(|| {
        (metadata.permissions().mode() & 0o111 != 0).then(|| "application/x-executable".into())
    })
}

const BY_EXTENSION: &[(&str, &str)] = &[
    ("txt", "text/plain"),
    ("md", "text/markdown"),
    ("html", "text/html"),
    ("htm", "text/html"),
    ("css", "text/css"),
    ("js", "text/javascript"),
    ("mjs", "text/javascript"),
    ("json", "application/json"),
    ("toml", "application/toml"),
    ("xml", "application/xml"),
    ("rs", "text/x-rust"),
    ("py", "text/x-python"),
    ("go", "text/x-go"),
    ("c", "text/x-c"),
    ("h", "text/x-c"),
    ("sh", "application/x-shellscript"),
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("pdf", "application/pdf"),
    ("zip", "application/zip"),
    ("tar", "application/x-tar"),
    ("gz", "application/gzip"),
    ("mp3", "audio/mpeg"),
    ("flac", "audio/flac"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
    ("mp4", "video/mp4"),
    ("mkv", "video/x-matroska"),
    ("webm", "video/webm"),
];

/// Enough of ELF to find one section by name. Nothing is run and nothing
/// but the headers and that section is read; a file that is not ELF, or
/// whose headers point past a bound, has no section.
mod elf {
    use std::io::{Read, Seek, SeekFrom};
    use std::path::Path;

    /// No section is longer than this: a name is short, and a file that
    /// says otherwise is not read.
    const MAX_SECTION_BYTES: u64 = 4096;
    const MAX_SECTIONS: u64 = 4096;
    const MAX_NAMES_BYTES: u64 = 1 << 20;

    pub fn section(path: &Path, wanted: &str) -> Option<Vec<u8>> {
        let mut file = crate::files::open_regular(path).ok()?;
        let mut ident = [0u8; 64];
        file.read_exact(&mut ident[..52]).ok()?;
        if &ident[..4] != b"\x7fELF" {
            return None;
        }
        let wide = match ident[4] {
            1 => false,
            2 => true,
            _ => return None,
        };
        let little = match ident[5] {
            1 => true,
            2 => false,
            _ => return None,
        };
        if wide {
            file.read_exact(&mut ident[52..64]).ok()?;
        }
        let at = |bytes: &[u8]| -> u64 {
            let mut value = [0u8; 8];
            value[..bytes.len()].copy_from_slice(bytes);
            if little {
                u64::from_le_bytes(value)
            } else {
                let mut big = [0u8; 8];
                big[8 - bytes.len()..].copy_from_slice(bytes);
                u64::from_be_bytes(big)
            }
        };
        // The section header table: where, how big an entry, how many, and
        // which entry names the rest.
        let (offset, entry, count, names) = if wide {
            (
                at(&ident[40..48]),
                at(&ident[58..60]),
                at(&ident[60..62]),
                at(&ident[62..64]),
            )
        } else {
            (
                at(&ident[32..36]),
                at(&ident[46..48]),
                at(&ident[48..50]),
                at(&ident[50..52]),
            )
        };
        let needed = if wide { 64 } else { 40 };
        if offset == 0 || entry < needed || count == 0 || count > MAX_SECTIONS || names >= count {
            return None;
        }
        let header = |file: &mut std::fs::File, index: u64| -> Option<(u64, u64, u64)> {
            let mut raw = [0u8; 64];
            file.seek(SeekFrom::Start(
                offset.checked_add(index.checked_mul(entry)?)?,
            ))
            .ok()?;
            file.read_exact(&mut raw[..needed as usize]).ok()?;
            // The name's offset into the names, and the section's offset and size.
            Some(if wide {
                (at(&raw[0..4]), at(&raw[24..32]), at(&raw[32..40]))
            } else {
                (at(&raw[0..4]), at(&raw[16..20]), at(&raw[20..24]))
            })
        };
        let (_, names_at, names_len) = header(&mut file, names)?;
        if names_len > MAX_NAMES_BYTES {
            return None;
        }
        let mut table = vec![0u8; names_len as usize];
        file.seek(SeekFrom::Start(names_at)).ok()?;
        file.read_exact(&mut table).ok()?;
        for index in 0..count {
            let (name_at, at, len) = header(&mut file, index)?;
            let name = table.get(name_at as usize..)?.split(|&b| b == 0).next()?;
            if name != wanted.as_bytes() {
                continue;
            }
            if len > MAX_SECTION_BYTES {
                return None;
            }
            let mut bytes = vec![0u8; len as usize];
            file.seek(SeekFrom::Start(at)).ok()?;
            file.read_exact(&mut bytes).ok()?;
            return Some(bytes);
        }
        None
    }
}

#[cfg(test)]
mod tests;
