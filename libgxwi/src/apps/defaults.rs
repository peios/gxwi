//! Defaults: which application opens a type of file when several could, as
//! PGSS Applications §5.7 has it.
//!
//! A person may choose an application for a media type, and so may whoever
//! administers the machine, for everyone on it. Each choice is a REG_SZ
//! value, named for a media type pattern (`image/png`, or `image/*`) and
//! holding the application's id, in one of two keys:
//!
//! - the person's, [`PERSON`], which the kernel routes to their own
//!   `Users\<SID>\Generic\Applications\Defaults`;
//! - the machine's, [`MACHINE`], which as shipped everyone may read and
//!   only administrators may write.
//!
//! The default for a file's type is the first of the person's choice for
//! the type, the person's for its top-level type and `*`, the machine's for
//! the type and the machine's for its top-level type and `*` that names an
//! application the catalogue has and that opens the type. One that does not
//! is passed over, never an error: a choice selects among the candidates
//! and never adds one.
//!
//! A consumer that picks reads them with [`Defaults::read`] and finds the
//! default with [`Defaults::among`] or [`Defaults::from`], or [`for_type`]
//! for both at once. A settings application sets them with [`set_person`]
//! and [`set_machine`], having asked the registry whether it may with
//! [`may_set_person`] and [`may_set_machine`].
//!
//! Everything here reads and writes the registry as the process's own
//! token, so the person's choices are the caller's.

use std::collections::BTreeMap;

use peios::registry::{CreateFlags, EnumValue, Key, KeyAccess, OpenFlags, ValueType};

use super::{Application, Catalogue, is_media_pattern};
use crate::icons;

/// Where the person's choices are: their own, by the kernel's routing of
/// `CurrentUser\`.
pub const PERSON: &str = "CurrentUser\\Generic\\Applications\\Defaults";
/// Where the machine's choices are: everyone's, for what they have not
/// chosen.
pub const MACHINE: &str = "Machine\\Generic\\Applications\\Defaults";

const PERSON_PATH: [&str; 4] = ["CurrentUser", "Generic", "Applications", "Defaults"];
const MACHINE_PATH: [&str; 4] = ["Machine", "Generic", "Applications", "Defaults"];
const ENOENT: i32 = 2;

/// One place's choices: an application's id by the media type pattern it
/// was chosen for, the pattern in lowercase.
pub type Choices = BTreeMap<String, String>;

/// The choices in force for whoever this process runs as: theirs, and the
/// machine's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Defaults {
    pub person: Choices,
    pub machine: Choices,
}

impl Defaults {
    /// The person's and the machine's, as the registry has them now.
    pub fn read() -> Defaults {
        Defaults { person: read_person(), machine: read_machine() }
    }

    /// The ids chosen for `media_type`, in the order they are tried: the
    /// person's for the type and then for `type/*`, then the machine's the
    /// same way. Whether each is usable is not looked at.
    pub fn tried(&self, media_type: &str) -> Vec<&str> {
        let media = media_type.trim().to_ascii_lowercase();
        let top = media.split_once('/').map(|(top, _)| format!("{top}/*"));
        let mut ids = Vec::new();
        for choices in [&self.person, &self.machine] {
            ids.extend(choices.get(&media).map(String::as_str));
            if let Some(top) = &top {
                ids.extend(choices.get(top).map(String::as_str));
            }
        }
        ids
    }

    /// The default for `media_type` among `applications`, which are the
    /// catalogue's as read: the first chosen that is among them and opens
    /// the type. None when no choice is usable.
    pub fn among<'a>(&self, applications: &'a [Application], media_type: &str) -> Option<&'a Application> {
        self.tried(media_type).into_iter().find_map(|id| applications.iter().find(|application| application.id == id && application.opens(media_type)))
    }

    /// The default for `media_type`, each choice looked up in `catalogue`
    /// as it is now.
    pub fn from(&self, catalogue: &Catalogue, media_type: &str) -> Option<Application> {
        self.tried(media_type).into_iter().find_map(|id| catalogue.get(id).filter(|application| application.opens(media_type)))
    }

    /// `candidates` with the default for `media_type` first, if one of them
    /// is it, and the rest in the order they were given.
    pub fn first<'a>(&self, media_type: &str, mut candidates: Vec<&'a Application>) -> Vec<&'a Application> {
        let chosen = self.tried(media_type).into_iter().find_map(|id| candidates.iter().position(|application| application.id == id && application.opens(media_type)));
        if let Some(at) = chosen {
            let default = candidates.remove(at);
            candidates.insert(0, default);
        }
        candidates
    }
}

/// The default for `media_type`: the choices read now, each looked up in
/// `catalogue` now.
pub fn for_type(catalogue: &Catalogue, media_type: &str) -> Option<Application> {
    Defaults::read().from(catalogue, media_type)
}

/// The person's choices, at [`PERSON`].
pub fn read_person() -> Choices {
    read(PERSON)
}

/// The machine's choices, at [`MACHINE`].
pub fn read_machine() -> Choices {
    read(MACHINE)
}

/// Every media type pattern any of `applications` says it opens, once
/// each, in order: the types a choice can usefully be made for.
pub fn declared_types(applications: &[Application]) -> Vec<String> {
    let mut types: Vec<String> = applications.iter().flat_map(|application| application.opens.iter().cloned()).collect();
    types.sort();
    types.dedup();
    types
}

/// Chooses `id` for `media_type` as the person's, or clears their choice
/// for it with `None`. Their key is made if this is their first.
pub fn set_person(media_type: &str, id: Option<&str>) -> Result<(), String> {
    set(&PERSON_PATH, media_type, id)
}

/// Chooses `id` for `media_type` as the machine's, or clears its choice
/// for it with `None`. Whether this process may is the key's descriptor's
/// to say: ask [`may_set_machine`] first.
pub fn set_machine(media_type: &str, id: Option<&str>) -> Result<(), String> {
    set(&MACHINE_PATH, media_type, id)
}

/// Whether this process may set the person's choices, as the registry
/// answers it.
pub fn may_set_person() -> Result<(), String> {
    may_set(&PERSON_PATH)
}

/// Whether this process may set the machine's choices, as the registry
/// answers it: the key opened for writing values, or, where it is not there
/// yet, the nearest key above it that is, for making keys in. Nothing is
/// inferred from the groups the caller is in.
pub fn may_set_machine() -> Result<(), String> {
    may_set(&MACHINE_PATH)
}

/// The choices in `values`, which are the values of the key at `place`. A
/// value that is no choice is said, and left out: one whose name is not a
/// media type pattern, whose type is not REG_SZ, or whose data is not an
/// id.
pub fn choices(place: &str, values: impl IntoIterator<Item = EnumValue>) -> Choices {
    let mut choices = Choices::new();
    for value in values {
        let name = String::from_utf8_lossy(&value.name).to_ascii_lowercase();
        if !is_media_pattern(&name) {
            eprintln!("libgxwi: ignoring {place}\\{name}: its name is not a media type");
            continue;
        }
        if value.ty != ValueType::SZ {
            eprintln!("libgxwi: ignoring {place}\\{name}: not a REG_SZ (type {:#x})", value.ty.0);
            continue;
        }
        let data = value.data.strip_suffix(&[0]).unwrap_or(&value.data);
        match std::str::from_utf8(data).map(str::trim) {
            Ok(id) if icons::is_id(id) => {
                choices.insert(name, id.to_string());
            }
            _ => eprintln!("libgxwi: ignoring {place}\\{name}: it does not name an application"),
        }
    }
    choices
}

/// The choices at `place`. A key that is not there has none, and goes
/// unremarked; one that cannot be read has none, and is said.
fn read(place: &str) -> Choices {
    let key = match Key::open(None, place, KeyAccess::QUERY_VALUE, OpenFlags::empty()) {
        Ok(key) => key,
        Err(e) if e.raw_os_error() == Some(ENOENT) => return Choices::new(),
        Err(e) => {
            eprintln!("libgxwi: {place} could not be opened: {e}");
            return Choices::new();
        }
    };
    let values = key.values(None).filter_map(|value| value.map_err(|e| eprintln!("libgxwi: {place} could not be read through: {e}")).ok());
    choices(place, values)
}

/// The value name and data a choice is written as: the pattern in
/// lowercase, and the id as a REG_SZ ending in a NUL.
fn written(media_type: &str, id: Option<&str>) -> Result<(String, Option<Vec<u8>>), String> {
    let media = media_type.trim().to_ascii_lowercase();
    if !is_media_pattern(&media) {
        return Err(format!("{media_type:?} is not a media type"));
    }
    let data = match id {
        Some(id) if icons::is_id(id) => Some([id.as_bytes(), &[0]].concat()),
        Some(id) => return Err(format!("{id:?} is not an application's id")),
        None => None,
    };
    Ok((media, data))
}

fn set(path: &[&str], media_type: &str, id: Option<&str>) -> Result<(), String> {
    let (name, data) = written(media_type, id)?;
    let place = path.join("\\");
    let Some(data) = data else {
        // Clearing: what is not there is already clear.
        let key = match Key::open(None, &place, KeyAccess::SET_VALUE, OpenFlags::empty()) {
            Ok(key) => key,
            Err(e) if e.raw_os_error() == Some(ENOENT) => return Ok(()),
            Err(e) => return Err(format!("{place} cannot be written: {e}")),
        };
        return match key.delete_value(name.as_bytes(), None, None) {
            Err(e) if e.raw_os_error() != Some(ENOENT) => Err(format!("{place}\\{name} could not be cleared: {e}")),
            _ => Ok(()),
        };
    };
    // The registry makes no key on the way to another, so each is made in
    // the one before it.
    let mut key: Option<Key> = None;
    for (depth, part) in path.iter().enumerate().skip(1) {
        let last = depth == path.len() - 1;
        let access = if last { KeyAccess::SET_VALUE } else { KeyAccess::CREATE_SUB_KEY };
        let (parent, child) = match &key {
            Some(parent) => (Some(parent), part.to_string()),
            None => (None, path[..=depth].join("\\")),
        };
        let (made, _) = Key::create(parent, &child, access, CreateFlags::empty(), None, None).map_err(|e| format!("{} cannot be written: {e}", path[..=depth].join("\\")))?;
        key = Some(made);
    }
    let key = key.ok_or_else(|| format!("{place} is not a key that can be written"))?;
    key.set_value(name.as_bytes(), ValueType::SZ, &data).call().map_err(|e| format!("{place}\\{name} could not be written: {e}"))
}

fn may_set(path: &[&str]) -> Result<(), String> {
    for depth in (0..path.len()).rev() {
        let place = path[..=depth].join("\\");
        let access = if depth == path.len() - 1 { KeyAccess::SET_VALUE } else { KeyAccess::CREATE_SUB_KEY };
        match Key::open(None, &place, access, OpenFlags::empty()) {
            Ok(_) => return Ok(()),
            Err(e) if e.raw_os_error() == Some(ENOENT) => continue,
            Err(e) => return Err(format!("{place} cannot be written: {e}")),
        }
    }
    Err(format!("{} cannot be written: none of the keys on the way to it is there", path.join("\\")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(name: &str, ty: ValueType, data: &[u8]) -> EnumValue {
        EnumValue { name: name.as_bytes().to_vec(), ty, data: data.to_vec() }
    }

    fn app(id: &str, opens: &[&str]) -> Application {
        let opens = opens.iter().map(|media| format!("{media:?}")).collect::<Vec<_>>().join(", ");
        Application::parse(id, &format!("title = {id:?}\nprogram = \"/usr/bin/x\"\nopens = [{opens}]\n")).unwrap()
    }

    fn of(pairs: &[(&str, &str)]) -> Choices {
        pairs.iter().map(|(media, id)| (media.to_string(), id.to_string())).collect()
    }

    // Verifies PGSS *applications.defaults.malformed-value-is-no-choice
    #[test]
    fn a_choice_is_a_media_type_named_for_an_id_and_anything_else_is_left_out() {
        let read = choices(
            MACHINE,
            [
                value("image/png", ValueType::SZ, b"org.example.viewer\0"),
                value("Text/*", ValueType::SZ, b" org.example.editor "),
                value("audio/flac", ValueType::SZ, b"org.example.player"),
                value("not a type", ValueType::SZ, b"org.example.viewer\0"),
                value("video/mp4", ValueType::DWORD, &[1, 0, 0, 0]),
                value("video/webm", ValueType::SZ, b"Not An Id\0"),
                value("image/*", ValueType::MULTI_SZ, b"org.example.viewer\0\0"),
            ],
        );
        assert_eq!(read, of(&[("audio/flac", "org.example.player"), ("image/png", "org.example.viewer"), ("text/*", "org.example.editor")]));
    }

    // Verifies PGSS *applications.defaults.order.person-exact,
    // *applications.defaults.order.person-pattern,
    // *applications.defaults.order.machine-exact and
    // *applications.defaults.order.machine-pattern
    #[test]
    fn the_person_comes_before_the_machine_and_the_type_before_its_pattern() {
        let defaults = Defaults {
            person: of(&[("image/png", "p.exact"), ("image/*", "p.pattern")]),
            machine: of(&[("image/png", "m.exact"), ("image/*", "m.pattern"), ("text/plain", "m.text")]),
        };
        assert_eq!(defaults.tried("IMAGE/PNG"), ["p.exact", "p.pattern", "m.exact", "m.pattern"]);
        assert_eq!(defaults.tried("image/jpeg"), ["p.pattern", "m.pattern"]);
        assert_eq!(defaults.tried("text/plain"), ["m.text"]);
        assert!(defaults.tried("audio/flac").is_empty());
        // The person's pattern is before the machine's exact type.
        let apps = [app("p.pattern", &["image/*"]), app("m.exact", &["image/png"])];
        assert_eq!(defaults.among(&apps, "image/png").map(|a| a.id.as_str()), Some("p.pattern"));
    }

    // Verifies PGSS *applications.defaults.unusable-choice-is-passed-over and
    // *applications.defaults.a-choice-adds-no-candidate
    #[test]
    fn a_choice_that_is_not_usable_is_passed_over_and_adds_nothing() {
        let defaults = Defaults {
            // Not installed, then installed but only for PNGs.
            person: of(&[("image/jpeg", "org.example.gone"), ("image/*", "org.example.png-only")]),
            machine: of(&[("image/*", "org.example.viewer"), ("audio/flac", "org.example.viewer")]),
        };
        let apps = [app("org.example.png-only", &["image/png"]), app("org.example.viewer", &["image/*"]), app("org.example.alpha", &["image/*", "audio/*"])];
        assert_eq!(defaults.among(&apps, "image/jpeg").map(|a| a.id.as_str()), Some("org.example.viewer"));
        assert_eq!(defaults.among(&apps, "image/png").map(|a| a.id.as_str()), Some("org.example.png-only"));
        // The viewer does not open audio, whatever the machine says.
        assert!(defaults.among(&apps, "audio/flac").is_none());
        let candidates: Vec<&Application> = apps.iter().filter(|a| a.opens("audio/flac")).collect();
        let ordered = defaults.first("audio/flac", candidates);
        assert_eq!(ordered.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["org.example.alpha"]);
    }

    #[test]
    fn the_default_goes_first_and_the_rest_keep_their_order() {
        let defaults = Defaults { person: Choices::new(), machine: of(&[("text/plain", "c")]) };
        let apps = [app("a", &["text/*"]), app("b", &["text/plain"]), app("c", &["text/plain"])];
        let ordered = defaults.first("text/plain", apps.iter().collect());
        assert_eq!(ordered.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["c", "a", "b"]);
        let unchanged = Defaults::default().first("text/plain", apps.iter().collect());
        assert_eq!(unchanged.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    }

    #[test]
    fn the_default_is_looked_up_in_the_catalogue_as_it_is() {
        let dir = std::env::temp_dir().join(format!("libgxwi-defaults-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("program");
        std::fs::write(&program, b"#!/bin/sh\n").unwrap();
        std::fs::write(dir.join("org.example.viewer.toml"), format!("title = \"Viewer\"\nprogram = {:?}\nopens = [\"image/*\"]\n", program.display())).unwrap();
        std::fs::write(dir.join("org.example.gone.toml"), "title = \"Gone\"\nprogram = \"/nowhere/at/all\"\nopens = [\"image/*\"]\n").unwrap();
        let catalogue = Catalogue::at(&dir);
        let defaults = Defaults { person: of(&[("image/png", "org.example.gone")]), machine: of(&[("image/*", "org.example.viewer")]) };
        assert_eq!(defaults.from(&catalogue, "image/png").map(|a| a.id), Some("org.example.viewer".into()));
        assert!(defaults.from(&catalogue, "text/plain").is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn what_is_written_is_a_lowercase_type_and_an_id_ending_in_a_nul() {
        assert_eq!(written(" Image/PNG ", Some("org.example.viewer")), Ok(("image/png".to_string(), Some(b"org.example.viewer\0".to_vec()))));
        assert_eq!(written("image/*", None), Ok(("image/*".to_string(), None)));
        assert!(written("image", Some("org.example.viewer")).is_err());
        assert!(written("image/png", Some("../viewer")).is_err());
    }

    #[test]
    fn the_types_a_choice_can_be_made_for_are_those_declared() {
        let apps = [app("a", &["text/*", "image/png"]), app("b", &["image/png"]), app("c", &[])];
        assert_eq!(declared_types(&apps), ["image/png", "text/*"]);
    }
}
