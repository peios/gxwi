//! Applications: what a program is to a desktop, as PGSS Applications has
//! it. A package that ships an application installs one *declaration* for
//! it, a TOML file named for the application's id in [`CATALOGUE`], saying
//! its title, the program to run, the icon it has and the kinds of file it
//! opens. Presence is the catalogue: nothing registers, and whoever wants
//! the list reads the directory.
//!
//! A launcher lists the declarations and starts what one names
//! ([`Catalogue::read`], [`Catalogue::get`]). A dock or taskbar that meets a
//! running process finds the declaration for it by the program it runs
//! ([`Catalogue::for_program`]), and so its title and icon. A file explorer
//! finds what opens a file by [`Application::opens`], and which of those
//! opens it when it is not asked by [`defaults`]: the application the
//! person, or else the machine, chose for its type.
//!
//! ```toml
//! # /usr/share/apps/dev.peios.gxwi-file-explorer.toml
//! title = "File Explorer"
//! description = "Browse the files on this system"
//! program = "/usr/bin/gxwi-file-explorer"
//! opens = ["inode/directory"]
//! ```

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::icons;

pub mod defaults;

/// Where declarations are, one file per application.
pub const CATALOGUE: &str = "/usr/share/apps";
/// The extension of a declaration's file. What is before it is the id.
pub const EXTENSION: &str = "toml";
/// The most of a declaration that is read. One is a few lines.
const MAX_DECLARATION_BYTES: u64 = 64 * 1024;

/// A declaration, as read: what one application is to the desktop.
#[derive(Clone, Debug, PartialEq)]
pub struct Application {
    /// The reverse-DNS name the declaration's file is named for, in the
    /// form of an icon identifier.
    pub id: String,
    /// What it is called where it is listed.
    pub title: String,
    /// One line on what it is for, if the declaration has one.
    pub description: Option<String>,
    /// The program to run: an absolute path.
    pub program: PathBuf,
    /// What the program is always started with, before anything else.
    pub arguments: Vec<String>,
    /// The identifier of its icon (PGSS Icons). The id, unless declared.
    pub icon: String,
    /// The media types it opens, each `type/subtype` or `type/*`.
    pub opens: Vec<String>,
    /// Whether a launcher lists it. One that only opens files need not be.
    pub listed: bool,
}

/// A declaration as its file has it. Anything else in the file is ignored,
/// so that a later version of the standard can add to it.
#[derive(Deserialize)]
struct Declared {
    title: String,
    description: Option<String>,
    program: PathBuf,
    #[serde(default)]
    arguments: Vec<String>,
    icon: Option<String>,
    #[serde(default)]
    opens: Vec<String>,
    #[serde(default = "yes")]
    listed: bool,
}

fn yes() -> bool {
    true
}

impl Application {
    /// The declaration in `text`, which is the file for `id`. What makes one
    /// unusable is said: an id that is not in the form of an identifier, a
    /// title that is empty or has a line break in it, a program that is not
    /// an absolute path, or text that is not TOML with those in it. An icon
    /// that is not an identifier is treated as not declared, and a media
    /// type that is not one is left out.
    pub fn parse(id: &str, text: &str) -> Result<Application, String> {
        if !icons::is_id(id) {
            return Err(format!("{id:?} is not in the form of an id"));
        }
        let declared: Declared = toml::from_str(text).map_err(|e| e.to_string())?;
        let title = declared.title.trim();
        if title.is_empty() || title.chars().any(char::is_control) {
            return Err("the title is empty or is not one line".into());
        }
        if !declared.program.is_absolute() {
            return Err(format!(
                "the program {:?} is not an absolute path",
                declared.program
            ));
        }
        let description = declared
            .description
            .as_deref()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| line.lines().next().unwrap_or_default().to_string());
        let icon = match declared.icon.as_deref().map(str::trim) {
            Some(icon) if icons::is_id(icon) => icon.to_string(),
            Some(icon) => {
                eprintln!(
                    "gxwi: the declaration of {id} names an icon {icon:?} that is not an identifier; using {id}"
                );
                id.to_string()
            }
            None => id.to_string(),
        };
        let opens = declared
            .opens
            .into_iter()
            .map(|media| media.trim().to_ascii_lowercase())
            .filter(|media| {
                let fit = is_media_pattern(media);
                if !fit {
                    eprintln!("gxwi: the declaration of {id} says it opens {media:?}, which is not a media type; leaving it out");
                }
                fit
            })
            .collect();
        Ok(Application {
            id: id.to_string(),
            title: title.to_string(),
            description,
            program: declared.program,
            arguments: declared.arguments,
            icon,
            opens,
            listed: declared.listed,
        })
    }

    /// Whether it opens a file of `media_type`: declared as that type, or as
    /// `type/*` for its top-level type.
    pub fn opens(&self, media_type: &str) -> bool {
        let media_type = media_type.to_ascii_lowercase();
        let top = media_type
            .split_once('/')
            .map(|(top, _)| top)
            .unwrap_or(&media_type);
        self.opens
            .iter()
            .any(|pattern| pattern == &media_type || pattern.strip_suffix("/*") == Some(top))
    }

    /// What to run to open `file` with it, or to start it bare: the program
    /// and its arguments, with the file's path last. A path that is not UTF-8
    /// is rejected: the desktop start protocol cannot represent native byte paths.
    pub fn command(&self, file: Option<&Path>) -> Result<(PathBuf, Vec<String>), String> {
        let mut arguments = self.arguments.clone();
        if let Some(file) = file {
            let path = file.to_str().ok_or_else(|| {
                "This file path cannot be represented as UTF-8, so it cannot be sent to an application.".to_string()
            })?;
            arguments.push(path.to_owned());
        }
        Ok((self.program.clone(), arguments))
    }
}

/// Whether `text` is `type/subtype` or `type/*`, in the characters a media
/// type may have.
pub fn is_media_pattern(text: &str) -> bool {
    let Some((top, sub)) = text.split_once('/') else {
        return false;
    };
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&c))
    };
    token(top) && (sub == "*" || token(sub))
}

/// A media type or pattern as a person reads it: `application/x-shellscript`
/// is "Shell script", `image/*` is "Every image". The machine has no MIME
/// database to ask, so the common ones are named here; any other is named
/// from its parts ("Markdown file" for `text/markdown`), never left as it is.
pub fn type_name(media_type: &str) -> String {
    let known = match media_type.to_ascii_lowercase().as_str() {
        "inode/directory" => "Folder",
        "text/plain" => "Plain text",
        "text/markdown" | "text/x-markdown" => "Markdown",
        "text/html" => "Web page",
        "text/css" => "Stylesheet",
        "text/csv" => "CSV table",
        "text/x-log" => "Log",
        "text/x-rust" => "Rust source",
        "text/x-python" | "text/x-script.python" => "Python source",
        "text/x-c" | "text/x-csrc" => "C source",
        "text/x-chdr" => "C header",
        "text/javascript" | "application/javascript" => "JavaScript",
        "application/json" => "JSON",
        "application/toml" => "TOML",
        "application/xml" | "text/xml" => "XML",
        "application/yaml" | "application/x-yaml" | "text/yaml" => "YAML",
        "application/x-shellscript" | "text/x-shellscript" => "Shell script",
        "application/pdf" => "PDF document",
        "application/zip" => "Zip archive",
        "application/gzip" | "application/x-gzip" => "Gzip archive",
        "application/x-tar" => "Tar archive",
        "application/octet-stream" => "Binary file",
        "image/png" => "PNG image",
        "image/jpeg" => "JPEG image",
        "image/gif" => "GIF image",
        "image/webp" => "WebP image",
        "image/avif" => "AVIF image",
        "image/svg+xml" => "SVG image",
        "audio/mpeg" => "MP3 audio",
        "video/mp4" => "MP4 video",
        _ => "",
    };
    if !known.is_empty() {
        return known.into();
    }
    let Some((top, sub)) = media_type.split_once('/') else {
        return media_type.into();
    };
    let family = match top {
        "text" => "text file",
        "image" => "image",
        "audio" => "sound",
        "video" => "video",
        "font" => "font",
        _ => "file",
    };
    if sub == "*" {
        return format!("Every {family}");
    }
    // `x-foo+xml` reads as Foo.
    let name = sub
        .trim_start_matches("x-")
        .split(['+', '.'])
        .next()
        .unwrap_or(sub);
    let mut letters = name.chars();
    match letters.next() {
        Some(first) => format!("{}{} {family}", first.to_uppercase(), letters.as_str()),
        None => media_type.into(),
    }
}

/// The catalogue: the directory of declarations, read whenever it is asked.
#[derive(Clone, Debug)]
pub struct Catalogue {
    directory: PathBuf,
}

impl Catalogue {
    /// The system's, at [`CATALOGUE`].
    pub fn system() -> Catalogue {
        Catalogue::at(CATALOGUE)
    }

    /// The one in `directory`.
    pub fn at(directory: impl Into<PathBuf>) -> Catalogue {
        Catalogue {
            directory: directory.into(),
        }
    }

    /// Every usable declaration, by id. A file that is no declaration is
    /// said on stderr and left out, and one whose program is not a file is
    /// left out silently: it is not there to be started.
    pub fn read(&self) -> Vec<Application> {
        let mut applications: Vec<Application> = std::fs::read_dir(&self.directory)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let id = path.file_stem()?.to_str()?.to_string();
                (path.extension()?.to_str()? == EXTENSION).then_some(id)
            })
            .filter_map(|id| self.get(&id))
            .collect();
        applications.sort_by(|a, b| a.id.cmp(&b.id));
        applications
    }

    /// The declaration for `id`, if there is a usable one whose program is
    /// a file. The id is checked before it is made a path, so that nothing
    /// outside the directory can be asked for.
    pub fn get(&self, id: &str) -> Option<Application> {
        if !icons::is_id(id) {
            return None;
        }
        let path = self.directory.join(format!("{id}.{EXTENSION}"));
        let file = crate::files::open_regular(&path).ok()?;
        let mut text = String::new();
        std::io::Read::read_to_string(
            &mut std::io::Read::take(file, MAX_DECLARATION_BYTES + 1),
            &mut text,
        )
        .ok()?;
        if text.len() as u64 > MAX_DECLARATION_BYTES {
            eprintln!(
                "gxwi: {} is larger than {MAX_DECLARATION_BYTES} bytes",
                path.display()
            );
            return None;
        }
        match Application::parse(id, &text) {
            Ok(application) => application.program.is_file().then_some(application),
            Err(why) => {
                eprintln!("gxwi: {} is no declaration: {why}", path.display());
                None
            }
        }
    }

    /// The declaration whose program is the file at `exe`, if any is. For
    /// a running process that is `/proc/<pid>/exe`, whatever path it was
    /// started by.
    pub fn for_program(&self, exe: &Path) -> Option<Application> {
        self.read()
            .into_iter()
            .find(|application| same_file(&application.program, exe))
    }
}

/// What a launcher lists for `query`: the listed applications whose title or
/// id has it in, ignoring case, those whose title begins with it first and
/// the rest by title. Nothing typed lists everything listed.
pub fn matching<'a>(applications: &'a [Application], query: &str) -> Vec<&'a Application> {
    let query = query.trim().to_lowercase();
    let mut found: Vec<&Application> = applications
        .iter()
        .filter(|application| application.listed)
        .filter(|application| {
            application.title.to_lowercase().contains(&query) || application.id.contains(&query)
        })
        .collect();
    found.sort_by_key(|application| {
        (
            !application.title.to_lowercase().starts_with(&query),
            application.title.to_lowercase(),
            application.id.clone(),
        )
    });
    found
}

/// Whether two paths are one file: the same path once resolved, or the same
/// inode on the same device, for a file a view presents at more than one
/// path.
pub fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b))
        && a == b
    {
        return true;
    }
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(test)]
mod tests;
