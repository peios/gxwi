//! Stable C layouts shared by libgxwi and its safe Rust wrapper.
//!
//! The integers below are ABI values, independent of the component version.

pub const ABI_VERSION: u32 = 1;
pub const ROLE_WINDOW: u32 = 1;
pub const ROLE_PANEL: u32 = 2;
pub const ROLE_OVERLAY: u32 = 3;
pub const ROLE_BACKGROUND: u32 = 4;
pub const ROLE_DIALOG: u32 = 5;
pub const EDGE_DEFAULT: u32 = 0;
pub const EDGE_TOP: u32 = 1;
pub const EDGE_BOTTOM: u32 = 2;
pub const EDGE_LEFT: u32 = 3;
pub const EDGE_RIGHT: u32 = 4;
pub const EVENT_OTHER: u32 = 0;
pub const EVENT_CLOSE: u32 = 1;
pub const EVENT_SURFACES: u32 = 2;
pub const LISTED_HAS_OWN: u32 = 1;
pub const LISTED_HAS_APPLICATION: u32 = 2;
pub const MAX_ICON_ID_BYTES: usize = 255;

/// A borrowed byte span. A null pointer is permitted only when len is zero.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Bytes {
    pub data: *const u8,
    pub len: usize,
}

impl Bytes {
    pub fn new(bytes: &[u8]) -> Self {
        Self {
            data: bytes.as_ptr(),
            len: bytes.len(),
        }
    }
}

/// Inputs borrowed only for the duration of create_live.
#[repr(C)]
pub struct LiveOptions {
    pub surface: u64,
    pub title: Bytes,
    pub role: u32,
    pub edge: u32,
    pub socket: Bytes,
    pub styles: *const Bytes,
    pub style_count: usize,
}

/// Strings borrow the owning immutable event, not the display connection.
#[repr(C)]
pub struct Listed {
    pub id: u64,
    pub title: Bytes,
    pub role: u32,
    pub flags: u32,
    pub icon: Bytes,
    pub app: u64,
    pub workspace: u32,
    pub reserved: u32,
    pub own: u64,
    pub application_id: Bytes,
    pub application_title: Bytes,
}

/// The existing icon/application identifier grammar used on both sides of the ABI.
pub fn is_icon_id(text: &str) -> bool {
    let mut chars = text.bytes();
    !text.is_empty()
        && text.len() <= MAX_ICON_ID_BYTES
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}
