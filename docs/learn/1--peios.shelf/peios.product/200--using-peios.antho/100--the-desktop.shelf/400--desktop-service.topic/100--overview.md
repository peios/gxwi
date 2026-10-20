---
title: GXWI Service
type: concept
description: Understand how GXWI connects browser clients to Peios desktop sessions.
---

GXWI provides browser access to Peios desktop sessions. It handles TLS,
authentication conversations, session connections, and installation or setup
overlays. The compositor and desktop shell are separate programs.

## Service and desktop responsibilities

The programs divide responsibility as follows:

| Program | Responsibility |
|---|---|
| `gxwid` | Machine identity, privileged setup, and session lifetime |
| `gxwi-server` | Restricted network-facing HTTP and TLS worker |
| Configured compositor | Desktop presentation and application surfaces |
| Desktop shell | Panels, launchers, settings, and other desktop tools |

Fenestra is a compositor. Fenesh is a desktop shell. GXWI does not require
those names in its protocol; the configured compositor determines the
session program. `gxwi-hello` provides a diagnostic session when no
compositor is configured.

## Authentication and authority

GXWI asks authd to authenticate an account for a Remote Interactive logon.
The resulting access token controls the desktop job. Applications inherit
session authority unless another explicit mechanism changes it.

Rendering a button does not grant permission to perform its action. The
service or kernel handling an operation still checks access. A disabled
button is a usability choice, not an authorization boundary.

## Persistent sessions

A session can continue after browser connections disappear. A later
successful sign-in can reconnect to the same running session. Session
persistence is not disk persistence: restarting a compositor or ending its
job loses process state that applications have not saved.

The service keeps normal sessions separate from
[machine overlays](~peios/desktop-service/overlays).
