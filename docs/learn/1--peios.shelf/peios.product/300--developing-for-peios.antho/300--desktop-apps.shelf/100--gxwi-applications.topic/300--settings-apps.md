---
title: Building a Settings Application
type: how-to
description: Compose settings pages and apply validated changes with the Rust settings kit.
---

The Rust `gxwi::settings` module builds settings interfaces from HTML
helpers. It supplies layout and controls; your application owns state,
validation, backend calls, and authorization.

## Before you start

Create an application using `App` and implement `Live` for its page state.
Choose the backend operation and permissions each control needs. Use the
SDK's checked example and Rust API documentation for complete signatures.

## Build the page

1. Register `settings::stylesheet` with the application before adding your
   own stylesheet.
2. Choose `settings::window` for a page with navigation or `settings::single`
   for one section without navigation.
3. Build navigation with stable section identifiers. Handle the `section`
   event by validating the requested identifier and selecting its page.
4. Assemble controls with settings helpers and named fields. Escape text
   that comes from users, files, or services before embedding it in HTML.
5. Show the effective backend state and an actionable error when an
   operation fails.

The kit adapts navigation to narrow views. It does not require the process
to track a browser's viewport.

## Apply changes deliberately

Use immediate application for controls such as a switch when the operation
is reversible and failure can be shown clearly. Restore the displayed field
if the backend refuses the change.

Use an explicit **Apply** action for a group of typed values that must be
validated together. Validate the complete proposed state before submitting
it. Rendering a success message before the backend accepts the operation
misrepresents the effective configuration.

For a destructive operation, ask for confirmation and focus the safe
choice. A confirmation is not authorization: the backend still checks the
caller's rights.

## Verify the result

Exercise successful changes, refused access, invalid values, and backend
failure. Open the same surface in two browser views and check that both
reflect accepted state. Verify keyboard operation and a narrow viewport.
