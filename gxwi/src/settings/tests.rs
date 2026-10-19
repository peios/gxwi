use super::*;

#[test]
fn a_chord_is_its_keys() {
    assert_eq!(
        keys("Ctrl+Alt+ArrowLeft"),
        "<kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>←</kbd>"
    );
}

#[test]
fn text_is_escaped_and_html_is_not() {
    let row = row("<b>", "a & b", "<input>");
    assert!(row.contains("&lt;b&gt;") && row.contains("a &amp; b") && row.contains("<input>"));
}

#[test]
fn the_status_line_is_there_when_nothing_was_said() {
    assert!(status(None, "").contains("st-status"));
    assert!(status(Some(&Ok("one\ntwo".into())), "").contains("one · two"));
}

#[test]
fn the_current_section_is_marked() {
    let nav = [Nav::Section(Section {
        id: "time",
        title: "Time",
        now: "UTC".into(),
        glyph: Glyph::Clock,
        tile: Tile::Blue,
    })];
    assert!(window(&nav, "time", "", "").contains(r#"aria-current="page""#));
    assert!(!window(&nav, "other", "", "").contains("aria-current"));
}
