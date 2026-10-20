---
title: The C Client Lifecycle
type: concept
description: Manage desktop handles, service descriptors, and owned events through libgxwi.
---

`libgxwi.so.1` exposes the desktop control interface to C and other
languages with a C foreign-function interface. Include `peios/gxwi.h`
and link with `libgxwi`. The header and `libgxwi(3)` define exact types,
function signatures, errors, and concurrency requirements.

## Connect and serve

`peios_gxwi_connect` uses `GXWI_DISPLAY` and returns an owned opaque display
handle. The library sets Identification before connecting. It does not
adopt arbitrary caller-supplied display descriptors.

`peios_gxwi_serve` transfers one end of a socket to the desktop and returns
the other as a close-on-exec descriptor. Your application owns that
descriptor and serves HTTP/2 on it. Start serving before asking the desktop
to present routes from that connection.

Create live or raw surfaces with application-chosen identifiers. The C
library sends the surface description; it does not implement rendering,
HTTP handling, or the live-surface WebSocket protocol for you. The Rust
`gxwi` framework supplies those higher layers.

## Receive and release events

`peios_gxwi_receive` blocks and returns one of three results:

| Result | Meaning |
|---|---|
| `1` | An independently owned event is available |
| `0` | End of file, with a null event output |
| `-1` | Failure reported through `errno` |

Inspect an event's kind before using its typed getters. A close event
identifies an application surface. A surface-list event describes the
desktop surfaces visible to an authorized shell connection. Unknown or
malformed messages become `PEIOS_GXWI_EVENT_OTHER`. Truncated packet data
or descriptor control data also produces that event rather than a parsed
partial message.

Destroy each event after use. Text returned by an event getter borrows
storage from that event and becomes invalid when the event is destroyed.
An event remains valid after its display handle is destroyed.

## Text and output ownership

Text is UTF-8 with explicit byte lengths. No NUL terminator is required,
and embedded NUL bytes are supported. A null pointer is valid for an empty
span or array, not a nonempty one.

Input storage is borrowed only for the duration of the call. Output
parameters remain unchanged on failure. Supply writable outputs that do not
alias inputs. The library cannot make an invalid non-null pointer safe.

## Shutdown and concurrent calls

Display operations can run concurrently. Concurrent receivers consume
different packets without a promised completion order. Use one receiver
when your application requires a single ordered event-processing loop.

`peios_gxwi_stop_listening` wakes receivers with end of file and leaves
sending available. Wait until all calls using a display finish before
destroying it. Events can be read concurrently, but destruction cannot
race a reader.

## Shell authority

Program startup, desktop-surface close, and sign-out calls send requests.
Successful transmission does not acknowledge that the desktop accepted or
completed the action. The compositor decides whether the connection has
shell authority. Observe subsequent desktop state rather than inventing a
completion guarantee.
