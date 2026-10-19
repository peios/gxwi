//! Desktop protocol implementation of the stable peios/gxwi.h C ABI.
//!
//! # Safety
//!
//! Exported calls require the pointer, lifetime, aliasing and concurrency
//! contracts in the installed header. Raw-pointer checks reject null and
//! impossible lengths; they cannot prove that caller-provided memory is live.

use std::io;
use std::mem;
use std::os::fd::{AsRawFd, IntoRawFd};
use std::ptr;
use std::slice;
use std::str;

use gxwi_abi as abi;

mod engine;
#[cfg(test)]
mod tests;

pub struct Display(engine::Display);
pub struct Event(engine::Asked);

fn invalid() -> io::Error {
    io::Error::from_raw_os_error(libc::EINVAL)
}

fn fail(error: io::Error) -> i32 {
    let errno = error.raw_os_error().unwrap_or(match error.kind() {
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => libc::EINVAL,
        io::ErrorKind::NotFound => libc::ENOENT,
        _ => libc::EIO,
    });
    // SAFETY: libc supplies this thread's writable errno slot.
    unsafe { *libc::__errno_location() = errno };
    -1
}

fn status(result: io::Result<()>) -> i32 {
    result.map_or_else(fail, |()| 0)
}

unsafe fn reference<'a, T>(pointer: *const T) -> io::Result<&'a T> {
    // SAFETY: the ABI caller guarantees a live aligned object for non-null pointers.
    unsafe { pointer.as_ref() }.ok_or_else(invalid)
}

unsafe fn array<'a, T>(pointer: *const T, count: usize) -> io::Result<&'a [T]> {
    if count == 0 {
        return Ok(&[]);
    }
    if pointer.is_null() || count > isize::MAX as usize / mem::size_of::<T>().max(1) {
        return Err(invalid());
    }
    // SAFETY: caller guarantees count initialized elements in one live allocation;
    // the null/size checks above satisfy slice representation bounds.
    Ok(unsafe { slice::from_raw_parts(pointer, count) })
}

unsafe fn text<'a>(value: abi::Bytes) -> io::Result<&'a str> {
    // SAFETY: the caller's byte-span validity contract is forwarded to array.
    str::from_utf8(unsafe { array(value.data, value.len)? }).map_err(|_| invalid())
}

unsafe fn texts(pointer: *const abi::Bytes, count: usize) -> io::Result<Vec<String>> {
    // SAFETY: both the array and each span obey the public caller contract.
    unsafe { array(pointer, count)? }
        .iter()
        .map(|value| unsafe { text(*value) }.map(str::to_owned))
        .collect()
}

fn role(value: u32) -> io::Result<engine::Role> {
    match value {
        abi::ROLE_WINDOW => Ok(engine::Role::Window),
        abi::ROLE_PANEL => Ok(engine::Role::Panel),
        abi::ROLE_OVERLAY => Ok(engine::Role::Overlay),
        abi::ROLE_BACKGROUND => Ok(engine::Role::Background),
        abi::ROLE_DIALOG => Ok(engine::Role::Dialog),
        _ => Err(invalid()),
    }
}

fn role_code(value: engine::Role) -> u32 {
    match value {
        engine::Role::Window => abi::ROLE_WINDOW,
        engine::Role::Panel => abi::ROLE_PANEL,
        engine::Role::Overlay => abi::ROLE_OVERLAY,
        engine::Role::Background => abi::ROLE_BACKGROUND,
        engine::Role::Dialog => abi::ROLE_DIALOG,
    }
}

fn edge(value: u32) -> io::Result<Option<engine::Edge>> {
    match value {
        abi::EDGE_DEFAULT => Ok(None),
        abi::EDGE_TOP => Ok(Some(engine::Edge::Top)),
        abi::EDGE_BOTTOM => Ok(Some(engine::Edge::Bottom)),
        abi::EDGE_LEFT => Ok(Some(engine::Edge::Left)),
        abi::EDGE_RIGHT => Ok(Some(engine::Edge::Right)),
        _ => Err(invalid()),
    }
}

/// Returns the stable ABI generation, independent of the package version.
#[unsafe(no_mangle)]
pub extern "C" fn peios_gxwi_abi_version() -> u32 {
    abi::ABI_VERSION
}

/// Connects using GXWI_DISPLAY with Identification before connect.
/// # Safety
/// out must be writable for one pointer and follow the header's aliasing rules.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_connect(out: *mut *mut Display) -> i32 {
    if out.is_null() {
        return fail(invalid());
    }
    if std::env::var_os("GXWI_DISPLAY").is_none() {
        return fail(io::Error::from_raw_os_error(libc::ENOENT));
    }
    status(engine::Display::connect().map(|display| {
        // SAFETY: the caller provided a writable output; ownership transfers once.
        unsafe { out.write(Box::into_raw(Box::new(Display(display)))) };
    }))
}

/// Releases the connection; null is permitted.
/// # Safety
/// display must be null or an owned handle with no active calls or later uses.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_display_destroy(display: *mut Display) {
    if !display.is_null() {
        // SAFETY: ownership returns exactly once under the caller contract.
        drop(unsafe { Box::from_raw(display) });
    }
}

/// Returns an owned HTTP stream fd.
/// # Safety
/// display and out_fd must follow the public handle and output contracts.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_serve(display: *const Display, out_fd: *mut i32) -> i32 {
    status((|| {
        if out_fd.is_null() {
            return Err(invalid());
        }
        // SAFETY: caller guarantees a live display and writable output.
        let stream = unsafe { reference(display)? }.0.serve()?;
        unsafe { out_fd.write(stream.into_raw_fd()) };
        Ok(())
    })())
}

/// Sends a live surface request.
/// # Safety
/// The handle, options, and nested spans must follow the header's input contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_create_live(
    display: *const Display,
    options: *const abi::LiveOptions,
) -> i32 {
    status((|| {
        // SAFETY: caller guarantees all referenced objects live for this call.
        let display = unsafe { reference(display)? };
        let options = unsafe { reference(options)? };
        display.0.create_live(
            options.surface,
            unsafe { text(options.title)? },
            role(options.role)?,
            edge(options.edge)?,
            unsafe { text(options.socket)? },
            &unsafe { texts(options.styles, options.style_count)? },
        )
    })())
}

/// Sends a raw surface request.
/// # Safety
/// The handle and spans must follow the public input contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_create_raw(
    display: *const Display,
    surface: u64,
    title: abi::Bytes,
    path: abi::Bytes,
) -> i32 {
    // SAFETY: forwarded caller contracts cover the handle and both spans.
    status(unsafe {
        (|| {
            reference(display)?
                .0
                .create_raw(surface, text(title)?, text(path)?)
        })()
    })
}

/// Retitles a surface.
/// # Safety
/// The handle and span must follow the public input contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_title(
    display: *const Display,
    surface: u64,
    title: abi::Bytes,
) -> i32 {
    // SAFETY: forwarded caller contracts cover the handle and span.
    status(unsafe { (|| reference(display)?.0.title(surface, text(title)?))() })
}

/// Destroys an app-owned surface.
/// # Safety
/// display must be a live handle for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_destroy(display: *const Display, surface: u64) -> i32 {
    // SAFETY: caller provides a live display.
    status(unsafe { reference(display) }.and_then(|display| display.0.destroy(surface)))
}

/// Sends a shell start request; the compositor remains the authority.
/// # Safety
/// The handle, program and argument array must follow the public input contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_start(
    display: *const Display,
    program: abi::Bytes,
    arguments: *const abi::Bytes,
    argument_count: usize,
) -> i32 {
    // SAFETY: forwarded caller contracts cover all borrowed inputs.
    status(unsafe {
        (|| {
            reference(display)?
                .0
                .start(text(program)?, &texts(arguments, argument_count)?)
        })()
    })
}

/// Sends a shell close request using the desktop surface ID.
/// # Safety
/// display must be a live handle for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_close(display: *const Display, surface: u64) -> i32 {
    // SAFETY: caller provides a live display.
    status(unsafe { reference(display) }.and_then(|display| display.0.close(surface)))
}

/// Sends a shell log-off request.
/// # Safety
/// display must be a live handle for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_log_off(display: *const Display) -> i32 {
    // SAFETY: caller provides a live display.
    status(unsafe { reference(display) }.and_then(|display| display.0.log_off()))
}

/// Receives one independently owned immutable event, or EOF.
/// # Safety
/// display and out must follow the header's handle/output contracts.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_receive(display: *const Display, out: *mut *mut Event) -> i32 {
    if out.is_null() {
        return fail(invalid());
    }
    // SAFETY: caller provides a live display.
    match unsafe { reference(display) }.and_then(|display| display.0.asked()) {
        Ok(event) => {
            let result = i32::from(event.is_some());
            let event = event.map_or(ptr::null_mut(), |event| {
                Box::into_raw(Box::new(Event(event)))
            });
            // SAFETY: out is writable by the caller contract; ownership transfers once.
            unsafe { out.write(event) };
            result
        }
        Err(error) => fail(error),
    }
}

/// Wakes receiving calls with EOF while preserving the sending half.
/// # Safety
/// display must be a live handle for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_stop_listening(display: *const Display) -> i32 {
    status((|| {
        // SAFETY: caller provides a live display; its fd remains owned during shutdown.
        let display = unsafe { reference(display)? };
        if unsafe { libc::shutdown(display.0.0.as_raw_fd(), libc::SHUT_RD) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })())
}

/// Releases an event and all its borrowed views; null is permitted.
/// # Safety
/// event must be null or an owned event with no active calls or later uses.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_event_destroy(event: *mut Event) {
    if !event.is_null() {
        // SAFETY: ownership returns exactly once under the caller contract.
        drop(unsafe { Box::from_raw(event) });
    }
}

unsafe fn output<T>(out: *mut T, value: T) -> io::Result<()> {
    if out.is_null() {
        return Err(invalid());
    }
    // SAFETY: caller guarantees writable, aligned, nonaliasing output storage.
    unsafe { out.write(value) };
    Ok(())
}

/// Returns the event's typed kind.
/// # Safety
/// event and out must follow the public handle/output contracts.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_event_kind(event: *const Event, out: *mut u32) -> i32 {
    // SAFETY: caller contracts are forwarded to reference/output.
    status(unsafe {
        (|| {
            output(
                out,
                match reference(event)?.0 {
                    engine::Asked::Other => abi::EVENT_OTHER,
                    engine::Asked::Close(_) => abi::EVENT_CLOSE,
                    engine::Asked::Surfaces(_) => abi::EVENT_SURFACES,
                },
            )
        })()
    })
}

/// Returns the app-owned number in a close event.
/// # Safety
/// event and out must follow the public handle/output contracts.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_event_close(event: *const Event, out: *mut u64) -> i32 {
    // SAFETY: caller contracts are forwarded to reference/output.
    status(unsafe {
        (|| match reference(event)?.0 {
            engine::Asked::Close(surface) => output(out, surface),
            _ => Err(invalid()),
        })()
    })
}

/// Returns the count in a surface-list event.
/// # Safety
/// event and out must follow the public handle/output contracts.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_event_surface_count(
    event: *const Event,
    out: *mut usize,
) -> i32 {
    // SAFETY: caller contracts are forwarded to reference/output.
    status(unsafe {
        (|| match &reference(event)?.0 {
            engine::Asked::Surfaces(surfaces) => output(out, surfaces.len()),
            _ => Err(invalid()),
        })()
    })
}

fn listed(surface: &engine::Listed) -> abi::Listed {
    let mut flags = 0;
    if surface.own.is_some() {
        flags |= abi::LISTED_HAS_OWN;
    }
    if surface.application.is_some() {
        flags |= abi::LISTED_HAS_APPLICATION;
    }
    let (application_id, application_title) = surface
        .application
        .as_ref()
        .map_or(("", ""), |app| (app.id.as_str(), app.title.as_str()));
    abi::Listed {
        id: surface.id,
        title: abi::Bytes::new(surface.title.as_bytes()),
        role: role_code(surface.role),
        flags,
        icon: abi::Bytes::new(surface.icon.as_bytes()),
        app: surface.app,
        workspace: surface.workspace,
        reserved: 0,
        own: surface.own.unwrap_or(0),
        application_id: abi::Bytes::new(application_id.as_bytes()),
        application_title: abi::Bytes::new(application_title.as_bytes()),
    }
}

/// Returns a borrowed view into a surface-list event.
/// # Safety
/// event/out must follow the public contracts; string views expire with event.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn peios_gxwi_event_surface(
    event: *const Event,
    index: usize,
    out: *mut abi::Listed,
) -> i32 {
    // SAFETY: caller contracts are forwarded to reference/output.
    status(unsafe {
        (|| match &reference(event)?.0 {
            engine::Asked::Surfaces(surfaces) => output(
                out,
                listed(
                    surfaces
                        .get(index)
                        .ok_or_else(|| io::Error::from_raw_os_error(libc::ERANGE))?,
                ),
            ),
            _ => Err(invalid()),
        })()
    })
}
