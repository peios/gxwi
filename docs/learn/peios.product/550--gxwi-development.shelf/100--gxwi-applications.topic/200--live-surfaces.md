---
title: Live Surfaces and Input
type: concept
description: Use process-owned rendering, named fields, and explicit event handlers.
---

Implement the Rust `Live` trait to draw a surface from application state.
`render` returns HTML. `event` handles named actions, `input` responds to
field changes, and `closing` decides whether a close request can proceed.

## Rendering and actions

`App::live` creates a window and returns a `Surface` handle. Use
`Surface::update` to change state from a worker and request another render.
Use `Surface::look` to inspect the application, fields, and surface facts
under their shared state lock.

An element's `fx-click` attribute names an action. Attributes beginning
with `fx-value-` provide action data. A form with `fx-submit` names its
submission action. The browser protocol is implemented by the compositor;
adding arbitrary HTML event attributes does not create a Rust callback.

Keep rendering free of irreversible effects. A browser reconnect or field
change can cause another render. Put effects in explicit action handlers
and background operations.

## Named fields

`Fields` stores values for named inputs. `Fields::get` returns an empty
string for an absent field. `Fields::set` changes a field from the process
and updates connected views, including a view editing that field.

The browser input path accepts at most 256 fields. Each value is limited
to 1 MiB, their total to 4 MiB, and each name to 256 bytes. These are
transport limits, not application-specific validation rules. Validate
lengths and formats required by the operation itself.

Do not use the field transport for files larger than its limits. A custom
bounded HTTP route can serve a different data-transfer requirement.

## Shared edits

Multiple views share field values. They do not form an independent draft
per browser. Design conflict-sensitive operations around explicit state,
revisions, or confirmation rather than assuming only one viewer edits a
surface.

The surface state lock serializes its callbacks. Avoid blocking operations
inside rendering or a callback that must keep the interface responsive.
Move long work to a worker and publish progress through the surface handle.

## Closing

Return `false` from `closing` to keep a surface while asking about unsaved
work. Once the user confirms, use the surface or closer handle to close it.
A process failure or ended desktop session is not an interactive close
request, so save durable data independently of this callback.
