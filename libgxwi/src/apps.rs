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
//! # /usr/share/apps/dev.peios.gexora.toml
//! title = "Gexora"
//! description = "Browse the files on this system"
//! program = "/usr/bin/gexora"
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
const MOST_BYTES: u64 = 64 * 1024;

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
            return Err(format!("the program {:?} is not an absolute path", declared.program));
        }
        let description = declared.description.as_deref().map(str::trim).filter(|line| !line.is_empty()).map(|line| line.lines().next().unwrap_or_default().to_string());
        let icon = match declared.icon.as_deref().map(str::trim) {
            Some(icon) if icons::is_id(icon) => icon.to_string(),
            Some(icon) => {
                eprintln!("libgxwi: the declaration of {id} names an icon {icon:?} that is not an identifier; using {id}");
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
                    eprintln!("libgxwi: the declaration of {id} says it opens {media:?}, which is not a media type; leaving it out");
                }
                fit
            })
            .collect();
        Ok(Application { id: id.to_string(), title: title.to_string(), description, program: declared.program, arguments: declared.arguments, icon, opens, listed: declared.listed })
    }

    /// Whether it opens a file of `media_type`: declared as that type, or as
    /// `type/*` for its top-level type.
    pub fn opens(&self, media_type: &str) -> bool {
        let media_type = media_type.to_ascii_lowercase();
        let top = media_type.split_once('/').map(|(top, _)| top).unwrap_or(&media_type);
        self.opens.iter().any(|pattern| pattern == &media_type || pattern.strip_suffix("/*") == Some(top))
    }

    /// What to run to open `file` with it, or to start it bare: the program
    /// and its arguments, with the file's path last.
    pub fn command(&self, file: Option<&Path>) -> (PathBuf, Vec<String>) {
        let mut arguments = self.arguments.clone();
        if let Some(file) = file {
            arguments.push(file.to_string_lossy().into_owned());
        }
        (self.program.clone(), arguments)
    }
}

/// Whether `text` is `type/subtype` or `type/*`, in the characters a media
/// type may have.
pub fn is_media_pattern(text: &str) -> bool {
    let Some((top, sub)) = text.split_once('/') else { return false };
    let token = |part: &str| !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&c));
    token(top) && (sub == "*" || token(sub))
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
        Catalogue { directory: directory.into() }
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
        let file = std::fs::File::open(&path).ok()?;
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(file, MOST_BYTES), &mut text).ok()?;
        match Application::parse(id, &text) {
            Ok(application) => application.program.is_file().then_some(application),
            Err(why) => {
                eprintln!("libgxwi: {} is no declaration: {why}", path.display());
                None
            }
        }
    }

    /// The declaration whose program is the file at `exe`, if any is. For
    /// a running process that is `/proc/<pid>/exe`, whatever path it was
    /// started by.
    pub fn for_program(&self, exe: &Path) -> Option<Application> {
        self.read().into_iter().find(|application| same_file(&application.program, exe))
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
        .filter(|application| application.title.to_lowercase().contains(&query) || application.id.contains(&query))
        .collect();
    found.sort_by_key(|application| (!application.title.to_lowercase().starts_with(&query), application.title.to_lowercase(), application.id.clone()));
    found
}

/// Whether two paths are one file: the same path once resolved, or the same
/// inode on the same device, for a file a view presents at more than one
/// path.
pub fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        if a == b {
            return true;
        }
    }
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GEXORA: &str = "title = \"Gexora\"\ndescription = \"Browse the files on this system\"\nprogram = \"/usr/bin/gexora\"\nopens = [\"inode/directory\", \"Text/*\"]\n";

    #[test]
    fn a_declaration_says_what_it_says_and_the_rest_is_defaulted() {
        let app = Application::parse("dev.peios.gexora", GEXORA).unwrap();
        assert_eq!(app.title, "Gexora");
        assert_eq!(app.description.as_deref(), Some("Browse the files on this system"));
        assert_eq!(app.program, Path::new("/usr/bin/gexora"));
        assert_eq!(app.icon, "dev.peios.gexora");
        assert!(app.arguments.is_empty());
        assert!(app.listed);
        assert!(app.opens("inode/directory"));
        assert!(app.opens("text/x-python"));
        assert!(!app.opens("image/png"));
        assert_eq!(app.command(Some(Path::new("/home/alice"))), (PathBuf::from("/usr/bin/gexora"), vec!["/home/alice".to_string()]));
    }

    #[test]
    fn what_is_declared_is_taken_and_what_is_unknown_is_ignored() {
        let text = "title = \"Hello\"\nprogram = \"/usr/bin/hello\"\narguments = [\"--wave\"]\nicon = \"dev.peios.gxwi.hello-alt\"\nlisted = false\ncolour = \"blue\"\n";
        let app = Application::parse("dev.peios.gxwi.hello", text).unwrap();
        assert_eq!(app.arguments, ["--wave"]);
        assert_eq!(app.icon, "dev.peios.gxwi.hello-alt");
        assert!(!app.listed);
        assert_eq!(app.command(None), (PathBuf::from("/usr/bin/hello"), vec!["--wave".to_string()]));
    }

    #[test]
    fn what_makes_a_declaration_unusable() {
        assert!(Application::parse("Not An Id", GEXORA).is_err());
        assert!(Application::parse("dev.peios.gexora", "program = \"/usr/bin/gexora\"\n").is_err());
        assert!(Application::parse("dev.peios.gexora", "title = \" \"\nprogram = \"/usr/bin/gexora\"\n").is_err());
        assert!(Application::parse("dev.peios.gexora", "title = \"Two\\nlines\"\nprogram = \"/usr/bin/gexora\"\n").is_err());
        assert!(Application::parse("dev.peios.gexora", "title = \"Gexora\"\nprogram = \"gexora\"\n").is_err());
        assert!(Application::parse("dev.peios.gexora", "title = \"Gexora\"\nprogram = \"/usr/bin/gexora\"\nbroken\n").is_err());
        // What is merely odd is set right instead.
        let odd = Application::parse("dev.peios.gexora", "title = \"Gexora\"\nprogram = \"/usr/bin/gexora\"\nicon = \"Not/An/Id\"\nopens = [\"directory\", \"inode/*\"]\n").unwrap();
        assert_eq!(odd.icon, "dev.peios.gexora");
        assert_eq!(odd.opens, ["inode/*"]);
    }

    #[test]
    fn a_launcher_lists_by_title_and_id_and_leaves_out_the_unlisted() {
        let declare = |id: &str, title: &str, listed: bool| Application::parse(id, &format!("title = {title:?}\nprogram = \"/usr/bin/x\"\nlisted = {listed}\n")).unwrap();
        let apps = [declare("dev.peios.gexora", "Gexora", true), declare("dev.peios.gxwi.hello", "Hello", true), declare("dev.peios.viewer", "Image viewer", false), declare("org.example.hex", "Hex editor", true)];
        let titles = |query: &str| matching(&apps, query).iter().map(|app| app.title.as_str()).collect::<Vec<_>>();
        assert_eq!(titles(""), ["Gexora", "Hello", "Hex editor"]);
        assert_eq!(titles("he"), ["Hello", "Hex editor"]);
        assert_eq!(titles("EX"), ["Gexora", "Hex editor"]);
        assert_eq!(titles("gxwi"), ["Hello"]);
        assert!(titles("viewer").is_empty());
    }

    #[test]
    fn the_catalogue_is_the_directory() {
        let dir = std::env::temp_dir().join(format!("libgxwi-apps-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("program");
        std::fs::write(&program, b"#!/bin/sh\n").unwrap();
        let declare = |id: &str, text: String| std::fs::write(dir.join(format!("{id}.toml")), text).unwrap();
        declare("dev.peios.b", format!("title = \"B\"\nprogram = {:?}\n", program.display()));
        declare("dev.peios.a", format!("title = \"A\"\nprogram = {:?}\nlisted = false\n", program.display()));
        declare("dev.peios.gone", "title = \"Gone\"\nprogram = \"/nowhere/at/all\"\n".into());
        declare("dev.peios.broken", "title = 3\n".into());
        std::fs::write(dir.join("notes.txt"), "not a declaration").unwrap();
        let catalogue = Catalogue::at(&dir);
        let read = catalogue.read();
        assert_eq!(read.iter().map(|app| app.id.as_str()).collect::<Vec<_>>(), ["dev.peios.a", "dev.peios.b"]);
        assert_eq!(catalogue.get("dev.peios.b").map(|app| app.title), Some("B".into()));
        assert!(catalogue.get("dev.peios.gone").is_none());
        assert!(catalogue.get("../notes").is_none());
        assert_eq!(catalogue.for_program(&program).map(|app| app.id), Some("dev.peios.a".into()));
        assert!(catalogue.for_program(&dir.join("notes.txt")).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
