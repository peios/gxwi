use super::*;

// The cases of Fenestra's page/chord.test.mjs, which the page's
// parseChord, parseChords and claimable pass.
#[test]
fn chords_are_read_as_chord_js_reads_them() {
    assert_eq!(parse_chord("ctrl+s").as_deref(), Some("Ctrl+S"));
    assert_eq!(
        parse_chord("Shift+Control+s").as_deref(),
        Some("Ctrl+Shift+S")
    );
    assert_eq!(parse_chord("down").as_deref(), Some("ArrowDown"));
    assert_eq!(parse_chord("Cmd+Space").as_deref(), Some("Meta+Space"));
    assert_eq!(parse_chord("esc").as_deref(), Some("Escape"));
    assert_eq!(parse_chord("Ctrl"), None);
    assert_eq!(parse_chord("Hyper+S"), None);
    assert_eq!(parse_chord(""), None);
    assert_eq!(
        parse_chords(" ctrl+s  Meta+S nonsense+x "),
        ["Ctrl+S", "Meta+S"]
    );
    assert!(claimable("Alt+J") && claimable("Ctrl+Shift+S") && claimable("Meta+Space"));
    assert!(!claimable("Shift+S") && !claimable("Escape") && !claimable("S"));
    // As lenient as the page about what the key is called.
    assert_eq!(
        parse_chord("Ctrl+Nonsense").as_deref(),
        Some("Ctrl+Nonsense")
    );
    assert_eq!(
        parse_chord("alt+shift+ctrl+meta+1").as_deref(),
        Some("Ctrl+Alt+Shift+Meta+1")
    );
    assert_eq!(parse_chord("Ctrl+"), None);
    assert_eq!(parse_chord("+"), None);
}

#[test]
fn a_chord_to_bind_is_a_key_there_is_that_may_be_claimed() {
    assert_eq!(chord("ctrl+alt+left"), Ok("Ctrl+Alt+ArrowLeft".into()));
    assert_eq!(chord("alt+enter"), Ok("Alt+Enter".into()));
    assert_eq!(chord("Meta+f5"), Ok("Meta+F5".into()));
    assert_eq!(chord("Ctrl+numpadadd"), Ok("Ctrl+NumpadAdd".into()));
    assert_eq!(chord("Alt+pageup"), Ok("Alt+PageUp".into()));
    assert!(chord("Ctrl+Nonsense").is_err() && chord("Ctrl+Numpad1").is_err());
    assert!(chord("Ctrl+F25").is_err() && chord("Ctrl+F05").is_err());
    assert!(chord("Shift+K").is_err());
    assert!(chord("K").is_err());
    assert!(chord("Hyper+K").is_err());
    // What is bound is what the page reads it as, and claims.
    for text in [
        "ctrl+alt+left",
        "alt+enter",
        "Meta+f5",
        "Ctrl+numpadadd",
        "cmd+space",
    ] {
        let bound = chord(text).unwrap();
        assert_eq!(parse_chord(&bound).as_deref(), Some(bound.as_str()));
        assert!(claimable(&bound));
    }
}

#[test]
fn modifiers_are_modifiers_alone_with_ctrl_alt_or_meta() {
    assert_eq!(modifiers("alt"), Ok("Alt".into()));
    assert_eq!(modifiers("Shift+Control+Alt"), Ok("Ctrl+Alt+Shift".into()));
    assert_eq!(modifiers("win"), Ok("Meta".into()));
    assert!(modifiers("Shift").is_err());
    assert!(modifiers("Alt+1").is_err());
    assert!(modifiers("").is_err());
}

#[test]
fn a_value_is_alternatives_or_nothing_and_one_bad_word_spoils_it() {
    let launcher = action("Launcher").unwrap();
    assert_eq!(
        validate(launcher, "  ctrl+space   alt+p ctrl+space "),
        Ok(vec!["Ctrl+Space".into(), "Alt+P".into()])
    );
    assert_eq!(validate(launcher, ""), Ok(vec![]));
    assert_eq!(validate(launcher, "   "), Ok(vec![]));
    assert!(validate(launcher, "Ctrl+Space P").is_err());
    assert!(validate(launcher, "Alt").is_err());
    assert!(validate(launcher, &"Alt+P ".repeat(60)).is_err());
    let many: Vec<String> = (1..=MAX_WORDS + 1).map(|n| format!("Alt+F{n}")).collect();
    assert!(validate(launcher, &many.join(" ")).is_err());
    let dock = action("DockItem").unwrap();
    assert_eq!(
        validate(dock, "Alt meta"),
        Ok(vec!["Alt".into(), "Meta".into()])
    );
    assert!(validate(dock, "Alt+1").is_err());
}

#[test]
fn every_default_is_valid_canonical_and_conflicts_with_none() {
    let mut ids = Vec::new();
    for action in ACTIONS {
        let words =
            validate(action, action.default).unwrap_or_else(|why| panic!("{}: {why}", action.id));
        assert_eq!(
            words.join(" "),
            action.default,
            "{} is not written canonically",
            action.id
        );
        assert!(!words.is_empty());
        assert!(!ids.contains(&action.id));
        ids.push(action.id);
    }
    let defaults = Shortcuts::defaults();
    assert_eq!(defaults.conflicts(), []);
    assert!(defaults.ignored.is_empty());
    assert!(
        ACTIONS
            .iter()
            .all(|action| defaults.binding(action.id).unwrap().from == Source::Default)
    );
    // Every chord claimed is one the page would claim.
    for action in ACTIONS {
        for chord in defaults.chords(action.id) {
            assert_eq!(parse_chord(&chord).as_deref(), Some(chord.as_str()));
            assert!(claimable(&chord));
        }
    }
}

#[test]
fn the_dock_is_its_modifiers_with_each_digit() {
    let defaults = Shortcuts::defaults();
    assert_eq!(defaults.numbered("DockItem", 1), ["Alt+1"]);
    assert_eq!(defaults.numbered("DockItem", 9), ["Alt+9"]);
    assert!(
        defaults.numbered("DockItem", 10).is_empty() && defaults.numbered("DockItem", 0).is_empty()
    );
    assert!(defaults.numbered("Launcher", 1).is_empty());
    assert_eq!(defaults.chords("DockItem").len(), 9);
    let both = defaults.with("DockItem", "Alt Ctrl+Meta").unwrap();
    assert_eq!(both.numbered("DockItem", 3), ["Alt+3", "Ctrl+Meta+3"]);
    assert_eq!(defaults.attribute("Launcher"), "Ctrl+Space Alt+P");
    assert_eq!(
        defaults.with("Launcher", "").unwrap().attribute("Launcher"),
        ""
    );
}

fn stored(
    person: &'static [(&'static str, &'static str)],
    machine: &'static [(&'static str, &'static str)],
) -> impl Fn(Scope, &str) -> Stored {
    move |scope, id| {
        let values = if scope == Scope::Person {
            person
        } else {
            machine
        };
        values
            .iter()
            .find(|(name, _)| *name == id)
            .map_or(Stored::Absent, |(_, text)| Stored::Text(text.to_string()))
    }
}

#[test]
fn the_person_comes_before_the_machine_and_the_machine_before_the_default() {
    let shortcuts = Shortcuts::resolve(stored(
        &[("NextTile", "alt+l"), ("Launcher", "")],
        &[("NextTile", "Alt+N"), ("PreviousTile", "Alt+H")],
    ));
    assert_eq!(
        shortcuts.binding("NextTile"),
        Some(&Binding {
            words: vec!["Alt+L".into()],
            from: Source::Person
        })
    );
    assert_eq!(
        shortcuts.binding("PreviousTile"),
        Some(&Binding {
            words: vec!["Alt+H".into()],
            from: Source::Machine
        })
    );
    // Empty is no shortcut, not the machine's or the default.
    assert_eq!(
        shortcuts.binding("Launcher"),
        Some(&Binding {
            words: vec![],
            from: Source::Person
        })
    );
    assert_eq!(
        shortcuts.words("NextWorkspace"),
        ["Ctrl+Alt+ArrowRight", "Ctrl+Alt+K"]
    );
    assert!(shortcuts.ignored.is_empty());
    assert_eq!(
        shortcuts.map().get("NextTile"),
        Some(&vec!["Alt+L".to_string()])
    );
}

#[test]
fn a_value_that_makes_no_sense_is_passed_over_and_said() {
    let shortcuts = Shortcuts::resolve(|scope, id| match (scope, id) {
        (Scope::Person, "NextTile") => Stored::Text("K".into()),
        (Scope::Machine, "NextTile") => Stored::Text("Alt+N".into()),
        (Scope::Person, "PreviousTile") => Stored::Unreadable("not a REG_SZ (type 0x4)".into()),
        _ => Stored::Absent,
    });
    assert_eq!(
        shortcuts.binding("NextTile"),
        Some(&Binding {
            words: vec!["Alt+N".into()],
            from: Source::Machine
        })
    );
    assert_eq!(
        shortcuts.binding("PreviousTile").unwrap().from,
        Source::Default
    );
    assert_eq!(
        shortcuts
            .ignored
            .iter()
            .map(|ignored| (ignored.scope, ignored.id))
            .collect::<Vec<_>>(),
        [(Scope::Person, "PreviousTile"), (Scope::Person, "NextTile")]
    );
}

#[test]
fn a_chord_bound_twice_is_a_conflict() {
    let shortcuts = Shortcuts::resolve(stored(&[("Launcher", "Alt+K Alt+3")], &[]));
    assert_eq!(
        shortcuts.conflicts(),
        [
            Conflict {
                chord: "Alt+K".into(),
                actions: vec!["Launcher", "NextTile"]
            },
            Conflict {
                chord: "Alt+3".into(),
                actions: vec!["Launcher", "DockItem"]
            }
        ]
    );
    assert_eq!(
        Shortcuts::defaults()
            .with("NextTile", "Ctrl+Alt+J")
            .unwrap()
            .conflicts()[0]
            .actions,
        ["NextTile", "PreviousWorkspace"]
    );
    assert!(Shortcuts::defaults().with("NextTile", "Shift+K").is_err());
    assert!(Shortcuts::defaults().with("Nothing", "Alt+K").is_err());
}

#[test]
fn a_value_is_text_in_a_reg_sz() {
    let value = |ty, data: &[u8]| RegValue {
        sequence: 1,
        ty,
        data: data.to_vec(),
        layer: Vec::new(),
    };
    assert_eq!(
        text(&value(ValueType::SZ, b"Alt+K\0")),
        Stored::Text("Alt+K".into())
    );
    assert_eq!(
        text(&value(ValueType::SZ, b"Alt+K")),
        Stored::Text("Alt+K".into())
    );
    assert_eq!(
        text(&value(ValueType::SZ, b"\0")),
        Stored::Text(String::new())
    );
    assert!(matches!(
        text(&value(ValueType::MULTI_SZ, b"Alt+K\0\0")),
        Stored::Unreadable(_)
    ));
    assert!(matches!(
        text(&value(ValueType::SZ, &[0xff, 0])),
        Stored::Unreadable(_)
    ));
}
