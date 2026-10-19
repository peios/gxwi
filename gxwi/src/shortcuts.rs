//! The desktop's keyboard shortcuts: which chords do what wherever the
//! keyboard is, as the person and the machine have chosen them.
//!
//! An action is something the desktop does from the keyboard, such as
//! moving to the next workspace or sending for the launcher, and has a
//! stable id ([`ACTIONS`]). What it is bound to is kept in the registry, one
//! `REG_SZ` value per action, named by its id:
//!
//! - `CurrentUser\Software\Fenestra\Shortcuts`, the person's own;
//! - `Machine\Software\Fenestra\Shortcuts`, the machine's, for everyone who
//!   has not chosen.
//!
//! The person's value is used if there is one, else the machine's, else the
//! built-in default. A value is chords written as Fenestra's page writes them
//! (`chord.js`), with spaces between alternatives: `Ctrl+Alt+ArrowLeft
//! Ctrl+Alt+J`. An empty value is an action with no shortcut, which is not
//! the same as the value being absent. A value that is not a `REG_SZ`, or that
//! has one word in it that is not a chord the desktop may claim, is ignored
//! as a whole and the next one down is used: nothing here mends a value or
//! guesses what was meant.
//!
//! A chord the desktop claims has Ctrl, Alt or Meta in it, since it is taken
//! from every page, a field included, and anything else is met while typing.
//!
//! [`Form::Modifiers`] actions are bound to modifiers and not chords: `Alt`
//! for `DockItem` is Alt+1 to Alt+9, one for each of the first nine entries.
//!
//! Who carries an action out is said by [`Part`]: Fenestra's window manager,
//! or the shell. A chord bound to two actions is a conflict ([`Shortcuts::conflicts`]),
//! which a program that writes here should refuse to make. Where one is made
//! anyway, the window manager's action is the one done, and of two of the
//! shell's, whichever surface claimed it first.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use peios::registry::{CreateFlags, Key, KeyAccess, NotifyFilter, OpenFlags, RegValue, ValueType};

/// The person's own shortcuts.
pub const PERSON: &str = "CurrentUser\\Software\\Fenestra\\Shortcuts";
/// The machine's, for everyone who has not chosen.
pub const MACHINE: &str = "Machine\\Software\\Fenestra\\Shortcuts";

/// What the keys above are in, nearest first: what is made, or watched while
/// the key is not there yet.
const PERSON_CHAIN: &[&str] = &[
    PERSON,
    "CurrentUser\\Software\\Fenestra",
    "CurrentUser\\Software",
    "CurrentUser",
];
const MACHINE_CHAIN: &[&str] = &[MACHINE, "Machine\\Software\\Fenestra", "Machine\\Software"];

const ENOENT: i32 = 2;

/// The longest value read or written. A few chords each, so this is far more
/// than any sensible one.
pub const MAX_VALUE_BYTES: usize = 256;
const WATCH_BUFFER_BYTES: usize = 16 * 1024;
const WATCH_DEBOUNCE_MS: u64 = 100;
/// The most alternatives one action may have.
pub const MAX_WORDS: usize = 8;
/// How many entries a [`Form::Modifiers`] action reaches: 1 to 9.
pub const NUMBERED: usize = 9;

/// Who carries an action out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    /// Fenestra's window manager, in its page.
    WindowManager,
    /// The shell: fenesh, or Fenestra's own taskbar and launcher.
    Shell,
}

/// What an action's value holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    /// Chords, such as `Ctrl+Space Alt+P`.
    Chords,
    /// Modifiers, such as `Alt` or `Ctrl+Alt`, held with the digits 1 to 9.
    Modifiers,
}

/// Something the desktop does from the keyboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Action {
    /// The stable id, which is the name of its value in the registry.
    pub id: &'static str,
    /// What it does, in words, for a settings page to list it by.
    pub label: &'static str,
    /// Its built-in default, in canonical form.
    pub default: &'static str,
    pub form: Form,
    pub part: Part,
}

/// Every action, in the order a settings page lists them.
pub const ACTIONS: &[Action] = &[
    Action {
        id: "Launcher",
        label: "Toggle Launcher",
        default: "Ctrl+Space Alt+P",
        form: Form::Chords,
        part: Part::Shell,
    },
    Action {
        id: "DockItem",
        label: "Open Dock Item",
        default: "Alt",
        form: Form::Modifiers,
        part: Part::Shell,
    },
    Action {
        id: "PreviousTile",
        label: "Focus Previous Tile",
        default: "Alt+J",
        form: Form::Chords,
        part: Part::WindowManager,
    },
    Action {
        id: "NextTile",
        label: "Focus Next Tile",
        default: "Alt+K",
        form: Form::Chords,
        part: Part::WindowManager,
    },
    Action {
        id: "PreviousWorkspace",
        label: "Previous Workspace",
        default: "Ctrl+Alt+ArrowLeft Ctrl+Alt+J",
        form: Form::Chords,
        part: Part::WindowManager,
    },
    Action {
        id: "NextWorkspace",
        label: "Next Workspace",
        default: "Ctrl+Alt+ArrowRight Ctrl+Alt+K",
        form: Form::Chords,
        part: Part::WindowManager,
    },
    Action {
        id: "MoveToPreviousWorkspace",
        label: "Move Window to Previous Workspace",
        default: "Ctrl+Alt+Shift+ArrowLeft Ctrl+Alt+Shift+J",
        form: Form::Chords,
        part: Part::WindowManager,
    },
    Action {
        id: "MoveToNextWorkspace",
        label: "Move Window to Next Workspace",
        default: "Ctrl+Alt+Shift+ArrowRight Ctrl+Alt+Shift+K",
        form: Form::Chords,
        part: Part::WindowManager,
    },
];

/// The action with this id, if there is one.
pub fn action(id: &str) -> Option<&'static Action> {
    ACTIONS.iter().find(|action| action.id == id)
}

// ---- chords, as chord.js has them

/// The modifiers, in the order a chord is written with them.
const ORDER: [&str; 4] = ["Ctrl", "Alt", "Shift", "Meta"];

fn modifier(name: &str) -> Option<&'static str> {
    Some(match name.to_lowercase().as_str() {
        "ctrl" | "control" => "Ctrl",
        "alt" | "option" => "Alt",
        "shift" => "Shift",
        "meta" | "super" | "cmd" | "command" | "win" => "Meta",
        _ => return None,
    })
}

fn key_alias(name: &str) -> Option<&'static str> {
    Some(match name.to_lowercase().as_str() {
        "esc" => "Escape",
        "space" => "Space",
        "return" => "Enter",
        "del" => "Delete",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        _ => return None,
    })
}

fn written(held: &[&str], key: &str) -> String {
    let mut parts: Vec<&str> = ORDER
        .iter()
        .copied()
        .filter(|modifier| held.contains(modifier))
        .collect();
    parts.push(key);
    parts.join("+")
}

/// A chord somebody wrote, as chords are written, or nothing if it is none:
/// `parseChord` in Fenestra's `chord.js`, to the letter. Modifiers come
/// first, in the order Ctrl, Alt, Shift, Meta; a letter or digit is a
/// capital; a few names have short forms (`esc`, `left`). Like `parseChord`
/// it does not ask whether the key is one there is: [`chord`] does.
pub fn parse_chord(text: &str) -> Option<String> {
    let mut parts: Vec<&str> = text.split('+').collect();
    let key = parts.pop().unwrap_or_default();
    let mut held = Vec::new();
    for part in parts {
        held.push(modifier(part)?);
    }
    if key.is_empty() || modifier(key).is_some() {
        return None;
    }
    let key = if key.len() == 1 && key.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        key.to_ascii_uppercase()
    } else {
        key.to_string()
    };
    Some(written(&held, key_alias(&key).unwrap_or(&key)))
}

/// Every chord in a list written with spaces between, as an attribute holds
/// them, leaving out what is none: `parseChords` in `chord.js`.
pub fn parse_chords(text: &str) -> Vec<String> {
    text.split_whitespace().filter_map(parse_chord).collect()
}

/// Whether a chord may be claimed for the whole desktop: it has Ctrl, Alt or
/// Meta in it, so it is not met while typing. `claimable` in `chord.js`.
pub fn claimable(chord: &str) -> bool {
    let parts: Vec<&str> = chord.split('+').collect();
    parts[..parts.len() - 1]
        .iter()
        .any(|part| matches!(*part, "Ctrl" | "Alt" | "Meta"))
}

/// The keys a chord may end in, besides a letter, a digit and F1 to F24: the
/// names the browser gives a key, or, for one that types something that is
/// no letter or digit, where it is (`chordOf` in `chord.js`). The keypad's
/// digits and Enter are the same as the others.
const NAMED: &[&str] = &[
    "Enter",
    "Escape",
    "Space",
    "Tab",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Comma",
    "Period",
    "Slash",
    "Backslash",
    "IntlBackslash",
    "IntlRo",
    "IntlYen",
    "Minus",
    "Equal",
    "Semicolon",
    "Quote",
    "Backquote",
    "BracketLeft",
    "BracketRight",
    "ContextMenu",
    "PrintScreen",
    "Pause",
    "ScrollLock",
    "CapsLock",
    "NumLock",
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadMultiply",
    "NumpadDivide",
    "NumpadDecimal",
    "NumpadEqual",
    "NumpadComma",
];

/// A key's name as a chord ends in it, whatever case it was written in, or
/// nothing if no key is called that.
fn known(key: &str) -> Option<String> {
    if key.len() == 1 && key.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Some(key.to_ascii_uppercase());
    }
    if let Some(named) = NAMED.iter().find(|named| named.eq_ignore_ascii_case(key)) {
        return Some(named.to_string());
    }
    let lower = key.to_ascii_lowercase();
    let n = lower
        .strip_prefix('f')
        .filter(|n| !n.starts_with('0'))
        .and_then(|n| n.parse::<u8>().ok());
    n.filter(|n| (1..=24).contains(n)).map(|n| format!("F{n}"))
}

/// One chord as an action may be bound to it, canonical, or why it may not:
/// it is a chord ([`parse_chord`]), of a key there is, that the desktop may
/// claim ([`claimable`]).
pub fn chord(text: &str) -> Result<String, String> {
    let Some(parsed) = parse_chord(text) else {
        return Err(format!(
            "{text:?} is not a chord: modifiers (Ctrl, Alt, Shift, Meta) then a key, joined by +"
        ));
    };
    let (held, key) = parsed
        .rsplit_once('+')
        .map_or(("", parsed.as_str()), |(held, key)| (held, key));
    let Some(key) = known(key) else {
        return Err(format!("{text:?} ends in no key there is"));
    };
    let canonical = if held.is_empty() {
        key
    } else {
        format!("{held}+{key}")
    };
    if !claimable(&canonical) {
        return Err(format!(
            "{canonical} has none of Ctrl, Alt or Meta in it, so it would be met while typing"
        ));
    }
    Ok(canonical)
}

/// One set of modifiers a [`Form::Modifiers`] action may be bound to,
/// canonical, or why it may not: modifier names joined by +, Ctrl, Alt or
/// Meta among them.
pub fn modifiers(text: &str) -> Result<String, String> {
    let mut held = Vec::new();
    for part in text.split('+') {
        let Some(found) = modifier(part) else {
            return Err(format!(
                "{text:?} is not modifiers alone: Ctrl, Alt, Shift and Meta, joined by +"
            ));
        };
        held.push(found);
    }
    let canonical: Vec<&str> = ORDER
        .iter()
        .copied()
        .filter(|modifier| held.contains(modifier))
        .collect();
    if !canonical
        .iter()
        .any(|modifier| matches!(*modifier, "Ctrl" | "Alt" | "Meta"))
    {
        return Err(format!(
            "{text:?} has none of Ctrl, Alt or Meta in it, so a digit held with it would be typed"
        ));
    }
    Ok(canonical.join("+"))
}

/// A value for `action`, as the words it is bound to in canonical form, or
/// why it is no value for it. Empty is no shortcut at all. A word said twice
/// is said once.
pub fn validate(action: &Action, text: &str) -> Result<Vec<String>, String> {
    if text.len() > MAX_VALUE_BYTES {
        return Err(format!("longer than {MAX_VALUE_BYTES} bytes"));
    }
    let mut words: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        let word = match action.form {
            Form::Chords => chord(word)?,
            Form::Modifiers => modifiers(word)?,
        };
        if !words.contains(&word) {
            words.push(word);
        }
    }
    if words.len() > MAX_WORDS {
        return Err(format!("more than {MAX_WORDS} alternatives"));
    }
    Ok(words)
}

// ---- what is in force

/// Where an action's binding came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Person,
    Machine,
    Default,
}

/// Whose value is read or written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// The person logged on: [`PERSON`].
    Person,
    /// Everyone on the machine who has not chosen: [`MACHINE`].
    Machine,
}

impl Scope {
    pub fn key(self) -> &'static str {
        match self {
            Scope::Person => PERSON,
            Scope::Machine => MACHINE,
        }
    }

    fn chain(self) -> &'static [&'static str] {
        match self {
            Scope::Person => PERSON_CHAIN,
            Scope::Machine => MACHINE_CHAIN,
        }
    }
}

/// What one action is bound to, and where that came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    /// Chords, or for a [`Form::Modifiers`] action, modifiers, canonical.
    /// Empty when the action has no shortcut.
    pub words: Vec<String>,
    pub from: Source,
}

/// A value that was there and was passed over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ignored {
    pub scope: Scope,
    pub id: &'static str,
    pub why: String,
}

/// A chord bound to more than one action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict {
    pub chord: String,
    /// The actions' ids, in the order of [`ACTIONS`].
    pub actions: Vec<&'static str>,
}

/// What a value of one scope is, as read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stored {
    /// There is none.
    Absent,
    /// Its text.
    Text(String),
    /// It is there but could not be taken for text, and why.
    Unreadable(String),
}

/// Every action's binding, as it is in force for the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shortcuts {
    bindings: BTreeMap<&'static str, Binding>,
    /// The values that were there and passed over, for the program to log
    /// ([`Shortcuts::complain`]) and a settings page to show.
    pub ignored: Vec<Ignored>,
}

impl Shortcuts {
    /// Every action at its built-in default.
    pub fn defaults() -> Shortcuts {
        Shortcuts::resolve(|_, _| Stored::Absent)
    }

    /// What is in force for the person logged on: their value, else the
    /// machine's, else the default, action by action.
    pub fn read() -> Shortcuts {
        let person = Values::open(Scope::Person);
        let machine = Values::open(Scope::Machine);
        Shortcuts::resolve(|scope, id| match scope {
            Scope::Person => person.get(id),
            Scope::Machine => machine.get(id),
        })
    }

    /// What is in force given what each scope holds.
    pub fn resolve(stored: impl Fn(Scope, &str) -> Stored) -> Shortcuts {
        let mut bindings = BTreeMap::new();
        let mut ignored = Vec::new();
        for action in ACTIONS {
            let mut binding = None;
            for (scope, from) in [
                (Scope::Person, Source::Person),
                (Scope::Machine, Source::Machine),
            ] {
                let text = match stored(scope, action.id) {
                    Stored::Absent => continue,
                    Stored::Text(text) => text,
                    Stored::Unreadable(why) => {
                        ignored.push(Ignored {
                            scope,
                            id: action.id,
                            why,
                        });
                        continue;
                    }
                };
                match validate(action, &text) {
                    Ok(words) => {
                        binding = Some(Binding { words, from });
                        break;
                    }
                    Err(why) => ignored.push(Ignored {
                        scope,
                        id: action.id,
                        why: format!("{text:?}: {why}"),
                    }),
                }
            }
            let binding = binding.unwrap_or_else(|| Binding {
                words: action
                    .default
                    .split_whitespace()
                    .map(String::from)
                    .collect(),
                from: Source::Default,
            });
            bindings.insert(action.id, binding);
        }
        Shortcuts { bindings, ignored }
    }

    /// The binding of the action `id`. Every action in [`ACTIONS`] has one.
    pub fn binding(&self, id: &str) -> Option<&Binding> {
        self.bindings.get(id)
    }

    /// What the action `id` is bound to, as its value has it: chords, or
    /// modifiers for a [`Form::Modifiers`] action. Empty for no shortcut, or
    /// an id that is no action.
    pub fn words(&self, id: &str) -> &[String] {
        self.bindings.get(id).map_or(&[], |binding| &binding.words)
    }

    /// Every chord the action `id` claims: for a [`Form::Modifiers`] action,
    /// each set of modifiers with each of the digits 1 to 9.
    pub fn chords(&self, id: &str) -> Vec<String> {
        match action(id).map(|action| action.form) {
            Some(Form::Modifiers) => (1..=NUMBERED).flat_map(|n| self.numbered(id, n)).collect(),
            Some(Form::Chords) => self.words(id).to_vec(),
            None => Vec::new(),
        }
    }

    /// The chords of a [`Form::Modifiers`] action for entry `n`, 1 to 9.
    pub fn numbered(&self, id: &str, n: usize) -> Vec<String> {
        if !(1..=NUMBERED).contains(&n)
            || action(id).map(|action| action.form) != Some(Form::Modifiers)
        {
            return Vec::new();
        }
        self.words(id)
            .iter()
            .map(|held| format!("{held}+{n}"))
            .collect()
    }

    /// The chords of the action `id`, with spaces between, as `fx-global-key`
    /// and `aria-keyshortcuts` hold them.
    pub fn attribute(&self, id: &str) -> String {
        self.chords(id).join(" ")
    }

    /// Every action's words by id, as Fenestra hands its page them.
    pub fn map(&self) -> BTreeMap<&'static str, Vec<String>> {
        self.bindings
            .iter()
            .map(|(id, binding)| (*id, binding.words.clone()))
            .collect()
    }

    /// These shortcuts with the action `id` bound to `text` instead, as
    /// though it had been written to the scope in force: for a settings page
    /// to ask what a change would conflict with before making it.
    pub fn with(&self, id: &str, text: &str) -> Result<Shortcuts, String> {
        let action = action(id).ok_or_else(|| format!("there is no action {id:?}"))?;
        let words = validate(action, text)?;
        let mut changed = self.clone();
        changed.bindings.insert(
            action.id,
            Binding {
                words,
                from: Source::Person,
            },
        );
        Ok(changed)
    }

    /// Every chord bound to more than one action, in the order of the
    /// chords' first actions.
    pub fn conflicts(&self) -> Vec<Conflict> {
        let mut by_chord: Vec<Conflict> = Vec::new();
        for action in ACTIONS {
            for chord in self.chords(action.id) {
                match by_chord.iter_mut().find(|conflict| conflict.chord == chord) {
                    Some(conflict) if !conflict.actions.contains(&action.id) => {
                        conflict.actions.push(action.id)
                    }
                    Some(_) => {}
                    None => by_chord.push(Conflict {
                        chord,
                        actions: vec![action.id],
                    }),
                }
            }
        }
        by_chord.retain(|conflict| conflict.actions.len() > 1);
        by_chord
    }

    /// Logs every value that was passed over, as `program` says things.
    pub fn complain(&self, program: &str) {
        for ignored in &self.ignored {
            let id = ignored.id;
            eprintln!(
                "{program}: ignoring {}\\{id}: {}; using {}",
                ignored.scope.key(),
                ignored.why,
                self.describe(id)
            );
        }
    }

    fn describe(&self, id: &str) -> String {
        match self.bindings.get(id) {
            Some(binding) if binding.words.is_empty() => "no shortcut".into(),
            Some(binding) => format!("{:?}", binding.words.join(" ")),
            None => "nothing".into(),
        }
    }
}

/// One scope's key, opened to be read, or nothing when it is not there.
struct Values {
    key: Option<Key>,
    /// Why it could not be opened, when it is there and could not.
    refused: Option<String>,
}

impl Values {
    fn open(scope: Scope) -> Values {
        match Key::open(
            None,
            scope.key(),
            KeyAccess::QUERY_VALUE,
            OpenFlags::empty(),
        ) {
            Ok(key) => Values {
                key: Some(key),
                refused: None,
            },
            Err(e) if e.raw_os_error() == Some(ENOENT) => Values {
                key: None,
                refused: None,
            },
            Err(e) => Values {
                key: None,
                refused: Some(format!("the key could not be opened: {e}")),
            },
        }
    }

    fn get(&self, id: &str) -> Stored {
        if let Some(why) = &self.refused {
            return Stored::Unreadable(why.clone());
        }
        let Some(key) = &self.key else {
            return Stored::Absent;
        };
        match key.query_value(id.as_bytes(), None) {
            Ok(value) => text(&value),
            Err(e) if e.raw_os_error() == Some(ENOENT) => Stored::Absent,
            Err(e) => Stored::Unreadable(format!("it could not be read: {e}")),
        }
    }
}

/// A `REG_SZ`'s text: UTF-8, ending in a NUL that a writer may have left off.
fn text(value: &RegValue) -> Stored {
    if value.ty != ValueType::SZ {
        return Stored::Unreadable(format!("not a REG_SZ (type {:#x})", value.ty.0));
    }
    let bytes = value
        .data
        .split(|&byte| byte == 0)
        .next()
        .unwrap_or_default();
    if bytes.len() > MAX_VALUE_BYTES {
        return Stored::Unreadable(format!("longer than {MAX_VALUE_BYTES} bytes"));
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Stored::Text(text.to_string()),
        Err(_) => Stored::Unreadable("not UTF-8".into()),
    }
}

// ---- writing

/// Binds the action `id` to `text` in `scope`, written in canonical form.
/// An empty `text` is no shortcut. What it answers with when it could not is
/// for the person to read. It does not look for conflicts: ask
/// [`Shortcuts::with`] first.
pub fn set(scope: Scope, id: &str, text: &str) -> Result<(), String> {
    let action = action(id).ok_or_else(|| format!("There is no shortcut called {id:?}."))?;
    let words = validate(action, text).map_err(|why| format!("That is not a shortcut: {why}."))?;
    let key = made(scope)
        .map_err(|e| format!("{} could not be opened to be written: {e}.", scope.key()))?;
    let mut data = words.join(" ").into_bytes();
    data.push(0);
    key.set_value(action.id.as_bytes(), ValueType::SZ, &data)
        .call()
        .map_err(|e| format!("{}\\{} could not be written: {e}.", scope.key(), action.id))
}

/// Takes away the action `id`'s value in `scope`, so that the next one down
/// is used: the machine's for the person, the default for the machine. One
/// that is not there is already taken away.
pub fn unset(scope: Scope, id: &str) -> Result<(), String> {
    let action = action(id).ok_or_else(|| format!("There is no shortcut called {id:?}."))?;
    let key = match Key::open(None, scope.key(), KeyAccess::SET_VALUE, OpenFlags::empty()) {
        Ok(key) => key,
        Err(e) if e.raw_os_error() == Some(ENOENT) => return Ok(()),
        Err(e) => {
            return Err(format!(
                "{} could not be opened to be written: {e}.",
                scope.key()
            ));
        }
    };
    match key.delete_value(action.id.as_bytes(), None, None) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(ENOENT) => Ok(()),
        Err(e) => Err(format!(
            "{}\\{} could not be taken away: {e}.",
            scope.key(),
            action.id
        )),
    }
}

/// Whether the person may change the machine's shortcuts: whether the key,
/// or the nearest key it would be made under, opens to be written. Asked of
/// the registry, never guessed from who the person is.
pub fn may_set_machine() -> bool {
    may_set(Scope::Machine)
}

/// Whether `scope`'s shortcuts may be changed by this process. See
/// [`may_set_machine`].
pub fn may_set(scope: Scope) -> bool {
    let chain = scope.chain();
    for (at, place) in chain.iter().enumerate() {
        let access = if at == 0 {
            KeyAccess::SET_VALUE
        } else {
            KeyAccess::CREATE_SUB_KEY
        };
        match Key::open(None, place, access, OpenFlags::empty()) {
            Ok(_) => return true,
            Err(e) if e.raw_os_error() == Some(ENOENT) => continue,
            Err(_) => return false,
        }
    }
    false
}

/// The scope's key, opened to be written, made with whatever it is in that
/// is not there yet.
fn made(scope: Scope) -> Result<Key, peios::Error> {
    let chain = scope.chain();
    // The nearest that is there, opened to have the next made in it.
    let mut at = 0;
    let mut key = loop {
        let access = if at == 0 {
            KeyAccess::SET_VALUE
        } else {
            KeyAccess::CREATE_SUB_KEY
        };
        match Key::open(None, chain[at], access, OpenFlags::empty()) {
            Ok(key) => break key,
            Err(e) if e.raw_os_error() == Some(ENOENT) && at + 1 < chain.len() => at += 1,
            Err(e) => return Err(e),
        }
    };
    // Then each nearer one made in the last.
    while at > 0 {
        at -= 1;
        let name = chain[at].rsplit('\\').next().unwrap_or_default();
        let access = if at == 0 {
            KeyAccess::SET_VALUE
        } else {
            KeyAccess::CREATE_SUB_KEY
        };
        key = Key::create(Some(&key), name, access, CreateFlags::empty(), None, None)?.0;
    }
    Ok(key)
}

// ---- following

/// Follows both scopes' keys for as long as the process runs, and calls
/// `hear` with what is in force whenever it is no longer `shown`: each is
/// watched from a thread of its own, and the person's need not be there
/// yet. Where a key cannot be watched that is logged, as `program` says
/// things, and a change there is seen when the other changes or at the next
/// session.
pub fn watch(
    program: &'static str,
    shown: Shortcuts,
    hear: impl Fn(Shortcuts) + Send + Sync + 'static,
) {
    let shown = Arc::new(Mutex::new(shown));
    let hear: Arc<dyn Fn(Shortcuts) + Send + Sync> = Arc::new(hear);
    for scope in [Scope::Person, Scope::Machine] {
        let (shown, hear) = (shown.clone(), hear.clone());
        std::thread::spawn(move || {
            follow(program, scope.chain(), || {
                let now = Shortcuts::read();
                let mut last = shown.lock().unwrap_or_else(|e| e.into_inner());
                if *last != now {
                    if last.ignored != now.ignored {
                        now.complain(program);
                    }
                    *last = now.clone();
                    drop(last);
                    hear(now);
                }
            })
        });
    }
}

/// Calls `refresh` once the first of `places` that is there is watched, and
/// again after every change under it.
fn follow(program: &str, places: &[&str], refresh: impl Fn()) {
    let mut buffer = vec![0u8; WATCH_BUFFER_BYTES];
    loop {
        let Some((place, key)) = places.iter().find_map(|place| {
            Key::open(None, place, KeyAccess::NOTIFY, OpenFlags::empty())
                .ok()
                .map(|key| (place, key))
        }) else {
            return eprintln!(
                "{program}: none of {places:?} can be opened to be watched; a change to the shortcuts there is seen later"
            );
        };
        if let Err(e) = key.notify(NotifyFilter::VALUE | NotifyFilter::SUBKEY, true) {
            return eprintln!(
                "{program}: {place} cannot be watched: {e}; a change to the shortcuts there is seen later"
            );
        }
        // Read once it is watched, so that nothing falls between the last
        // look and the watching.
        refresh();
        if let Err(e) = key.read_watch_events(&mut buffer) {
            return eprintln!(
                "{program}: watching {place}: {e}; a change to the shortcuts there is seen later"
            );
        }
        // A moment, so that changes made together are read together.
        std::thread::sleep(std::time::Duration::from_millis(WATCH_DEBOUNCE_MS));
    }
}

#[cfg(test)]
mod tests;
