//! A settings app's surface, built the same way by every one of them: its
//! sections down the side, each saying what it is set to now; the chosen
//! section beside them, as groups of rows with a row's name and what it
//! means on the left and what changes it on the right; and a line along the
//! bottom for what was last done.
//!
//! These are functions that return HTML, and [`STYLE`] is what draws it.
//! What a setting is, how it is read and what changing it does stay the
//! app's: this only says how it looks. Text is escaped here; a `control` or
//! a `page` is HTML the caller made, from these functions or its own.
//!
//! Switches and selects are fields, as any input is: their value is in
//! [`Fields`](crate::Fields), and a settings app applies one as it changes,
//! in [`Live::input`](crate::Live::input). Where a change can't be undone
//! with a click, or takes something away, ask first: a [`more`] under the
//! row, with [`asking`](More::Asking).

use crate::escape;

/// What draws everything here. Serve it with [`stylesheet`].
pub const STYLE: &str = include_str!("settings.css");

/// Serves [`STYLE`] to every surface of `app`. An app's own stylesheet comes
/// after, for what is its alone.
pub fn stylesheet(app: &mut crate::App) {
    app.stylesheet("/gxwi-settings.css", STYLE);
}

/// A picture for a section, drawn in lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Glyph {
    Clock,
    Globe,
    Keyboard,
    Info,
    Power,
    User,
    Lock,
    Key,
    Picture,
    File,
    Dock,
    Screen,
    Shield,
    Terminal,
    Tag,
    Server,
    Certificate,
    Blocked,
    Package,
    Download,
    Refresh,
    Folder,
    Toggle,
    /// A fixed disk.
    Disk,
    /// A disk that is plugged in and taken out: a USB stick, a card.
    Removable,
    /// An optical disc.
    Disc,
    /// Things stacked over one another: layers, strata.
    Layers,
}

impl Glyph {
    fn paths(self) -> &'static str {
        match self {
            Glyph::Clock => r#"<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>"#,
            Glyph::Globe => {
                r#"<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>"#
            }
            Glyph::Keyboard => {
                r#"<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>"#
            }
            Glyph::Info => r#"<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>"#,
            Glyph::Power => r#"<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>"#,
            Glyph::User => {
                r#"<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.4-7 8-7s7 2.5 8 7"/>"#
            }
            Glyph::Lock => {
                r#"<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>"#
            }
            Glyph::Key => {
                r#"<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3M16 7l3 3M14 9l2 2"/>"#
            }
            Glyph::Picture => {
                r#"<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>"#
            }
            Glyph::File => {
                r#"<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>"#
            }
            Glyph::Dock => {
                r#"<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>"#
            }
            Glyph::Screen => {
                r#"<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>"#
            }
            Glyph::Shield => r#"<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/>"#,
            Glyph::Terminal => r#"<path d="m5 8 4 4-4 4M12 16h7"/>"#,
            Glyph::Tag => {
                r#"<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>"#
            }
            Glyph::Server => {
                r#"<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>"#
            }
            Glyph::Certificate => {
                r#"<path d="M12 20H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M8 8h8M8 12h4"/><circle cx="17" cy="14" r="3"/><path d="m15.4 16.6-.9 4.4 2.5-1.4 2.5 1.4-.9-4.4"/>"#
            }
            Glyph::Blocked => r#"<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>"#,
            Glyph::Package => {
                r#"<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>"#
            }
            Glyph::Download => r#"<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/>"#,
            Glyph::Refresh => {
                r#"<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>"#
            }
            Glyph::Folder => {
                r#"<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>"#
            }
            Glyph::Toggle => {
                r#"<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="16" cy="12" r="2.5"/>"#
            }
            Glyph::Disk => {
                r#"<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 13h18M17 15.5h.01M14 15.5h.01"/>"#
            }
            Glyph::Removable => {
                r#"<rect x="7" y="9" width="10" height="13" rx="2"/><path d="M9 9V3h6v6M11 6h.01M13 6h.01"/>"#
            }
            Glyph::Disc => {
                r#"<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 6a6 6 0 0 0-6 6"/>"#
            }
            Glyph::Layers => {
                r#"<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>"#
            }
        }
    }

    fn svg(self) -> String {
        format!(
            r#"<svg viewBox="0 0 24 24" aria-hidden="true">{}</svg>"#,
            self.paths()
        )
    }
}

/// The colour of a section's tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tile {
    Blue,
    Teal,
    Violet,
    Orange,
    Pink,
    Green,
    Slate,
    Red,
}

impl Tile {
    fn class(self) -> &'static str {
        match self {
            Tile::Blue => "t-blue",
            Tile::Teal => "t-teal",
            Tile::Violet => "t-violet",
            Tile::Orange => "t-orange",
            Tile::Pink => "t-pink",
            Tile::Green => "t-green",
            Tile::Slate => "t-slate",
            Tile::Red => "t-red",
        }
    }
}

/// A glyph on its tile.
pub fn icon(glyph: Glyph, tile: Tile) -> String {
    format!(
        r#"<span class="st-icon {}">{}</span>"#,
        tile.class(),
        glyph.svg()
    )
}

/// One section of an app, as its side lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Section {
    /// What the app knows it by, sent with the event `section` when it is
    /// chosen, as `section`.
    pub id: &'static str,
    pub title: &'static str,
    /// What it is set to now, in a few words, under the title.
    pub now: String,
    pub glyph: Glyph,
    pub tile: Tile,
}

/// What the side holds: sections, and headings over runs of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Nav {
    Heading(&'static str),
    Section(Section),
}

/// The whole surface of an app with sections: the side, the section
/// `current` beside it as `page`, and `status` along the bottom.
pub fn window(nav: &[Nav], current: &str, page: &str, status: &str) -> String {
    let mut side = String::new();
    for entry in nav {
        match entry {
            Nav::Heading(text) => side.push_str(&format!("<h3>{}</h3>", escape(text))),
            Nav::Section(section) => side.push_str(&format!(
                r#"<button id="st-nav-{id}" fx-click="section" fx-value-section="{id}" title="{title}"{current}>{icon}<span class="what"><b>{title}</b><small>{now}</small></span></button>"#,
                id = escape(section.id),
                title = escape(section.title),
                current = if section.id == current { r#" aria-current="page""# } else { "" },
                icon = icon(section.glyph, section.tile),
                now = escape(&section.now),
            )),
        }
    }
    format!(
        r#"<div class="st"><nav class="st-nav" aria-label="Sections">{side}</nav><main class="st-page" id="st-page-{current}"><div class="st-inner">{page}</div></main></div>{status}"#,
        current = escape(current)
    )
}

/// The whole surface of an app with one page and no sections.
pub fn single(page: &str, status: &str) -> String {
    format!(
        r#"<div class="st"><main class="st-page"><div class="st-inner">{page}</div></main></div>{status}"#
    )
}

/// A section's heading: its icon, its title and a line on what it is for.
pub fn head(glyph: Glyph, tile: Tile, title: &str, about: &str) -> String {
    format!(
        "<header class=\"st-head\">{}<div><h1>{}</h1>{}</div></header>",
        icon(glyph, tile),
        escape(title),
        if about.is_empty() {
            String::new()
        } else {
            format!("<p>{}</p>", escape(about))
        }
    )
}

/// What a section is about, large, before its rows: `left` and `right` are
/// HTML. See [`hero_title`] and [`big`].
pub fn hero(left: &str, right: &str) -> String {
    format!(
        r#"<section class="st-hero"><div class="who">{left}</div><div class="control">{right}</div></section>"#
    )
}

/// A hero's left side for a page that is one thing: its icon, its name and
/// a line on it.
pub fn hero_title(glyph: Glyph, tile: Tile, title: &str, about: &str) -> String {
    format!(
        r#"{}<div><div class="title">{}</div><div class="sub">{}</div></div>"#,
        icon(glyph, tile),
        escape(title),
        escape(about)
    )
}

/// A hero's left side for a figure: the time, say, and a line under it.
pub fn big(figure: &str, under: &str) -> String {
    format!(
        r#"<div><div class="big">{}</div><div class="sub">{}</div></div>"#,
        escape(figure),
        escape(under)
    )
}

/// How a [`pill`] reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Good,
    Warn,
    Bad,
    Plain,
}

/// A few words on how something is, with a dot of its colour.
pub fn pill(text: &str, tone: Tone) -> String {
    let class = match tone {
        Tone::Good => " good",
        Tone::Warn => " warn",
        Tone::Bad => " bad",
        Tone::Plain => "",
    };
    format!(r#"<span class="st-pill{class}">{}</span>"#, escape(text))
}

/// Rows together, under a title when there is one, with `foot` under them:
/// a [`locked`] or a [`note`], or nothing.
pub fn group(title: &str, rows: &str, foot: &str) -> String {
    let title = if title.is_empty() {
        String::new()
    } else {
        format!("<h2>{}</h2>", escape(title))
    };
    format!(r#"<section class="st-group">{title}<div class="st-rows">{rows}</div>{foot}</section>"#)
}

/// A setting: its name, what it means (or nothing), and `control`, HTML.
pub fn row(label: &str, about: &str, control: &str) -> String {
    let about = if about.is_empty() {
        String::new()
    } else {
        format!("<small>{}</small>", escape(about))
    };
    format!(
        r#"<div class="st-row"><span class="label"><b>{}</b>{about}</span><span class="control">{control}</span></div>"#,
        escape(label)
    )
}

/// Something known, not set: a short row of its name and its value, in the
/// monospace face when `mono`.
pub fn fact(label: &str, text: &str, mono: bool) -> String {
    format!(
        r#"<div class="st-row fact"><span class="label"><b>{}</b></span><span class="control">{}</span></div>"#,
        escape(label),
        value(text, mono)
    )
}

/// One of a list, as a row: an icon, its name, lines under it (each shown
/// in the monospace face when `true`), and `control`.
pub fn item(icon: &str, name: &str, lines: &[(&str, bool)], control: &str) -> String {
    let lines: String = lines
        .iter()
        .map(|(text, mono)| {
            format!(
                r#"<small{}>{}</small>"#,
                if *mono { r#" class="st-mono""# } else { "" },
                escape(text)
            )
        })
        .collect();
    format!(
        r#"<div class="st-row"><span class="st-item">{icon}<span class="label"><b>{}</b>{lines}</span></span><span class="control">{control}</span></div>"#,
        escape(name)
    )
}

/// One of a list that opens to more about it, as a row to press: an icon,
/// its name, lines under it as [`item`] has them, `aside` (HTML) at the
/// end before an arrow, and `event` with `values` sent when it is pressed.
pub fn link(
    icon: &str,
    name: &str,
    lines: &[(&str, bool)],
    aside: &str,
    event: &str,
    values: &[(&str, &str)],
) -> String {
    let lines: String = lines
        .iter()
        .map(|(text, mono)| {
            format!(
                r#"<small{}>{}</small>"#,
                if *mono { r#" class="st-mono""# } else { "" },
                escape(text)
            )
        })
        .collect();
    format!(
        r#"<button type="button" class="st-row link" fx-click="{}"{}><span class="st-item">{icon}<span class="label"><b>{}</b>{lines}</span></span><span class="control">{aside}<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>"#,
        escape(event),
        attributes(values),
        escape(name)
    )
}

/// Above a long list: a field named `name` to narrow it as it is typed in
/// (the app filters in [`Live::input`](crate::Live::input)), saying
/// `placeholder` while empty, and `buttons` at the end.
pub fn search(name: &str, label: &str, placeholder: &str, buttons: &str) -> String {
    format!(
        r#"<div class="st-bar"><label class="st-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/></svg><input class="st-input wide" type="search" name="{}" aria-label="{}" placeholder="{}" autocomplete="off" spellcheck="false"></label>{buttons}</div>"#,
        escape(name),
        escape(label),
        escape(placeholder)
    )
}

/// A button back to where a page was opened from: `label` is where.
pub fn back(label: &str, event: &str) -> String {
    format!(
        r#"<button type="button" class="st-back" fx-click="{}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>{}</button>"#,
        escape(event),
        escape(label)
    )
}

/// What opens under a row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum More {
    /// A form to fill in.
    Form,
    /// A question about something that can't be undone with a click.
    Asking,
}

/// HTML that opens under the row before it, in its group.
pub fn more(kind: More, html: &str) -> String {
    let class = match kind {
        More::Form => "st-more",
        More::Asking => "st-more asking",
    };
    format!(r#"<div class="{class}">{html}</div>"#)
}

/// Under a group: why it can't be changed. Say who can, and that looking is
/// fine.
pub fn locked(why: &str) -> String {
    format!(
        r#"<p class="st-foot">{}<span>{}</span></p>"#,
        Glyph::Lock.svg(),
        escape(why)
    )
}

/// Under a section's heading: why nothing on it can be changed, said once
/// for the whole section.
pub fn banner(why: &str) -> String {
    format!(
        r#"<p class="st-banner">{}<span>{}</span></p>"#,
        Glyph::Lock.svg(),
        escape(why)
    )
}

/// Under a section's heading: a word on everything in it, said once.
pub fn caution(text: &str) -> String {
    format!(
        r#"<p class="st-banner">{}<span>{}</span></p>"#,
        Glyph::Info.svg(),
        escape(text)
    )
}

/// A button the keyboard goes to as it appears (fx-autofocus), which also
/// brings it into sight: the safe answer to a question that has just opened.
pub fn focused_button(label: &str, event: &str, kind: Kind) -> String {
    button(label, event, &[], kind, true).replacen("<button ", "<button fx-autofocus ", 1)
}

/// Under a group: a word on it.
pub fn note(text: &str) -> String {
    format!(
        r#"<p class="st-foot">{}<span>{}</span></p>"#,
        Glyph::Info.svg(),
        escape(text)
    )
}

/// Under a group: a word on it, with no picture.
pub fn hint(text: &str) -> String {
    format!(r#"<p class="st-foot"><span>{}</span></p>"#, escape(text))
}

fn disabled(enabled: bool) -> &'static str {
    if enabled { "" } else { " disabled" }
}

/// An on-and-off field, drawn as a switch. It holds "on" or "".
pub fn switch(name: &str, label: &str, enabled: bool) -> String {
    format!(
        r#"<input type="checkbox" class="st-switch" name="{}" aria-label="{}"{}>"#,
        escape(name),
        escape(label),
        disabled(enabled)
    )
}

/// A field to choose one of `options`, each its value and what it says.
pub fn select(name: &str, label: &str, options: &[(String, String)], enabled: bool) -> String {
    let options: String = options
        .iter()
        .map(|(value, text)| {
            format!(
                r#"<option value="{}">{}</option>"#,
                escape(value),
                escape(text)
            )
        })
        .collect();
    format!(
        r#"<select class="st-select" name="{}" aria-label="{}"{}>{options}</select>"#,
        escape(name),
        escape(label),
        disabled(enabled)
    )
}

/// How wide a [`text`] field is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Width {
    /// A number: a port, seconds.
    Short,
    /// A name.
    Normal,
    /// As wide as where it is.
    Wide,
}

/// A field to type in. `kind` is its HTML type (`text`, `password`,
/// `number`); `attributes` is any more, such as `autocomplete="off"`.
pub fn text(
    name: &str,
    label: &str,
    kind: &str,
    width: Width,
    enabled: bool,
    attributes: &str,
) -> String {
    let width = match width {
        Width::Short => " short",
        Width::Normal => "",
        Width::Wide => " wide",
    };
    format!(
        r#"<input class="st-input{width}" type="{}" name="{}" aria-label="{}"{} {attributes}>"#,
        escape(kind),
        escape(name),
        escape(label),
        disabled(enabled)
    )
}

/// How a [`button`] reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Plain,
    /// What a form is for.
    Primary,
    /// Taking something away.
    Danger,
    /// A link's weight.
    Quiet,
}

/// A button sending `event` with `values`, as fx-value-* attributes.
pub fn button(
    label: &str,
    event: &str,
    values: &[(&str, &str)],
    kind: Kind,
    enabled: bool,
) -> String {
    let class = match kind {
        Kind::Plain => "st-button",
        Kind::Primary => "st-button primary",
        Kind::Danger => "st-button danger",
        Kind::Quiet => "st-button quiet",
    };
    format!(
        r#"<button type="button" class="{class}" fx-click="{}"{}{}>{}</button>"#,
        escape(event),
        attributes(values),
        disabled(enabled),
        escape(label)
    )
}

/// A button that sends the form it is in, as `fx-submit` names.
pub fn submit(label: &str, kind: Kind, enabled: bool) -> String {
    let class = match kind {
        Kind::Danger => "st-button danger",
        Kind::Plain => "st-button",
        _ => "st-button primary",
    };
    format!(
        r#"<button class="{class}"{}>{}</button>"#,
        disabled(enabled),
        escape(label)
    )
}

fn attributes(values: &[(&str, &str)]) -> String {
    values
        .iter()
        .map(|(name, value)| format!(r#" fx-value-{}="{}""#, escape(name), escape(value)))
        .collect()
}

/// Buttons in a row, at the end.
pub fn actions(buttons: &str) -> String {
    format!(r#"<div class="st-actions">{buttons}</div>"#)
}

/// A chord as keys: `Ctrl+Alt+ArrowLeft` as Ctrl, Alt and ←, each a key.
pub fn keys(chord: &str) -> String {
    chord
        .split('+')
        .map(|key| {
            let shown = match key {
                "ArrowLeft" => "←",
                "ArrowRight" => "→",
                "ArrowUp" => "↑",
                "ArrowDown" => "↓",
                "Meta" => "Meta",
                other => other,
            };
            format!("<kbd>{}</kbd>", escape(shown))
        })
        .collect()
}

/// A chord as a chip, with a button sending `remove` and `values` (and the
/// chord as `chord`) to take it away, when `enabled`.
pub fn chord(
    chord: &str,
    shown: &str,
    remove: &str,
    values: &[(&str, &str)],
    enabled: bool,
) -> String {
    let remove = if enabled {
        format!(
            r#"<button type="button" class="x" fx-click="{}"{} fx-value-chord="{}" title="Remove {}" aria-label="Remove {}">×</button>"#,
            escape(remove),
            attributes(values),
            escape(chord),
            escape(chord),
            escape(chord)
        )
    } else {
        String::new()
    };
    format!(r#"<span class="st-chord">{}{remove}</span>"#, keys(shown))
}

/// A button that, clicked, waits for keys to be pressed and sends them as
/// `event` with `values` and `chord` (fx-record). `idle` is what it says
/// until then.
pub fn recorder(event: &str, values: &[(&str, &str)], idle: &str, enabled: bool) -> String {
    format!(
        r#"<button type="button" class="st-record" fx-record="{}"{}{}><span class="idle">{}</span><span class="busy">Press the keys… Esc to stop</span></button>"#,
        escape(event),
        attributes(values),
        disabled(enabled),
        escape(idle)
    )
}

/// Chips and a recorder together, at the end of a row.
pub fn chords(html: &str) -> String {
    format!(r#"<span class="st-chords">{html}</span>"#)
}

/// How far something long has got: a bar `done` of `of` along, with `text`
/// over it saying what it is doing now. With `of` 0 the bar moves without
/// saying how far, for work whose length isn't known.
pub fn progress(done: usize, of: usize, text: &str) -> String {
    // A <progress> says how far in attributes: a page's style attributes
    // are refused (style-src 'self').
    let bar = if of == 0 {
        "<progress></progress>".to_string()
    } else {
        format!(
            r#"<progress max="{of}" value="{}"></progress>"#,
            done.min(of)
        )
    };
    format!(
        r#"<div class="st-progress" role="status"><span class="text">{}</span>{bar}</div>"#,
        escape(text)
    )
}

/// What an empty list says, quietly, where its items would be.
pub fn none(text: &str) -> String {
    format!(r#"<span class="st-none">{}</span>"#, escape(text))
}

/// A value shown, not changed: in the monospace face when `mono`.
pub fn value(text: &str, mono: bool) -> String {
    format!(
        r#"<span class="value{}">{}</span>"#,
        if mono { " mono" } else { "" },
        escape(text)
    )
}

/// The line along the bottom: what was last done, or why it wasn't, and
/// `aside` at the other end. It is there whether or not anything was done,
/// so nothing moves when something is. Lines of `said` run together.
pub fn status(said: Option<&Result<String, String>>, aside: &str) -> String {
    let said = match said {
        None => r#"<span class="said" role="status"></span>"#.to_string(),
        Some(Ok(done)) => format!(
            r#"<span class="said good" role="status">{}</span>"#,
            escape(&one_line(done))
        ),
        Some(Err(why)) => format!(
            r#"<span class="said bad" role="alert" title="{0}">{0}</span>"#,
            escape(&one_line(why))
        ),
    };
    format!(
        r#"<footer class="st-status">{said}<span>{}</span></footer>"#,
        escape(aside)
    )
}

fn one_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests;
