---
title: Custom HTTP Pages
type: concept
description: Understand custom application routes and browser-owned state.
---

Use a custom HTTP page when a live surface cannot represent the interface,
such as a terminal renderer. The application still serves through the
desktop's connection; it does not need its own public network listener.

## Routes and resources

`App::routes` adds application HTTP routes. `App::file` serves a resource,
and `App::stylesheet` registers a stylesheet for live surfaces. Paths are
relative to the application's routing space. Do not assume that the
application owns the browser's root path.

`App::raw_page` presents a scripted page. The compositor keeps that page
apart from other applications. Its browser-owned state does not
automatically reach another device or survive a tab being closed.

## Isolation and keyboard access

A raw page has no ordinary access to the desktop's cookies or browser
storage. Worker code uses a blob where required by the isolated page's
origin. Do not use the absence of storage as a substitute for validating
requests in the application.

Include the compositor's key-forwarding module from `.fx/keys.js` within
the application's path space. Without it, desktop keyboard shortcuts can
be unavailable while focus is inside the page. The SDK's hello raw-page
example demonstrates the expected resource layout.

## Lifecycle

Closing a raw window allows it to close without the live surface's
`closing` decision. Keep important state in the process and implement an
explicit save or stop flow where the interface requires it.

Limit request bodies, pending work, and output queues according to the
application's needs. The shared transport cannot choose an appropriate
memory or cancellation policy for every application protocol.
