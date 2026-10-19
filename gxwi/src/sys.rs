//! Raw declarations for the separately linked libgxwi.so.1.
use gxwi_abi::{Bytes, Listed, LiveOptions};

pub enum Display {}
pub enum Event {}

#[link(name = "gxwi")]
unsafe extern "C" {
    pub fn peios_gxwi_connect(out: *mut *mut Display) -> i32;
    pub fn peios_gxwi_display_destroy(display: *mut Display);
    pub fn peios_gxwi_serve(display: *const Display, out_fd: *mut i32) -> i32;
    pub fn peios_gxwi_create_live(display: *const Display, options: *const LiveOptions) -> i32;
    pub fn peios_gxwi_create_raw(
        display: *const Display,
        surface: u64,
        title: Bytes,
        path: Bytes,
    ) -> i32;
    pub fn peios_gxwi_title(display: *const Display, surface: u64, title: Bytes) -> i32;
    pub fn peios_gxwi_destroy(display: *const Display, surface: u64) -> i32;
    pub fn peios_gxwi_start(
        display: *const Display,
        program: Bytes,
        arguments: *const Bytes,
        argument_count: usize,
    ) -> i32;
    pub fn peios_gxwi_close(display: *const Display, surface: u64) -> i32;
    pub fn peios_gxwi_log_off(display: *const Display) -> i32;
    pub fn peios_gxwi_receive(display: *const Display, out: *mut *mut Event) -> i32;
    pub fn peios_gxwi_stop_listening(display: *const Display) -> i32;
    pub fn peios_gxwi_event_destroy(event: *mut Event);
    pub fn peios_gxwi_event_kind(event: *const Event, out: *mut u32) -> i32;
    pub fn peios_gxwi_event_close(event: *const Event, out: *mut u64) -> i32;
    pub fn peios_gxwi_event_surface_count(event: *const Event, out: *mut usize) -> i32;
    pub fn peios_gxwi_event_surface(event: *const Event, index: usize, out: *mut Listed) -> i32;
}
