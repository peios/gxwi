---
title: The GXWI Application Model
type: concept
description: Separate process state, browser presentation, and desktop authority.
---

A GXWI application runs on the Peios machine and presents surfaces through
the desktop. It connects to the display named by `GXWI_DISPLAY`; it does
not expose an independent public listening port.

## Three layers

The SDK has distinct responsibilities:

| Layer | Responsibility |
|---|---|
| `libgxwi.so` | C interface for desktop connections and surface requests |
| Rust `gxwi` crate | Application HTTP service, rendering, and settings helpers |
| Compositor | Desktop layout, browser presentation, and shell authorization |

Use the C interface when integrating another language or a custom runtime.
Use the Rust rendering layer for process-owned HTML surfaces. The shared
library does not implement the Rust rendering helpers.

## State belongs to the application

A live surface owns its application state and named input fields in the
process. Browsers receive renderings of that state. Multiple browsers can
interact with the same surface, and reconnecting browsers receive its
latest state.

This is not automatic persistence across application failure or session
shutdown. Save durable data explicitly. Keep focus, viewport geometry, and
other device-specific presentation out of shared application state.

## Surfaces and requests

An application can present windows and dialogs. Shell programs can also use
panels, backgrounds, and overlay surfaces where the compositor permits
those roles. Merely requesting a role or obtaining an SDK shell handle does
not grant shell authority.

Closing a live surface is a request to the application. The application can
ask about unsaved work before allowing the close. Closing the last surface
ends the application's desktop loop.

## Trust the operation, not the markup

Treat events and field values as untrusted input. Validate actions in the
process and rely on the backend's authorization checks. Escape untrusted
text before placing it in HTML. The Rust `escape` helper handles text
escaping; it does not validate URLs or authorize operations.

## Launching files

`Application::command` returns a result when adding a file argument. The
desktop startup protocol carries UTF-8 text, so a native filename that is
not valid UTF-8 cannot be represented in that request. The SDK returns an
error instead of replacing bytes and opening a different path. Show the
error and keep the original native path intact.

## Application declarations

The application catalog accepts regular declaration files up to 64 KiB.
It checks the opened descriptor and bounds the actual read, so a file that
grows beyond the limit is rejected. A declaration at the exact limit is
accepted if its content is valid. Special files are not declarations.

Executable icon probes also require an opened regular file. These checks
prevent catalog discovery from treating a pipe or device as a normal file.
They do not replace validation of the declaration's fields.
