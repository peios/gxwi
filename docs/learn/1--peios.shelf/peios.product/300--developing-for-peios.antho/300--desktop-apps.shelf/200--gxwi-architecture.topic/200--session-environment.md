---
title: The Session Environment
type: reference
description: Locate runtime paths and understand when session environment values are chosen.
---

GXWI starts a compositor with environment values chosen for the
authenticated principal. Those values describe the session, not the
browser device that happens to display it.

## Identity and runtime

The session receives these values:

| Value | Purpose |
|---|---|
| `HOME` | Home directory from the account profile |
| `SHELL` | Account shell |
| `PATH` | Program search path for the session |
| `GXWI_RUNTIME_DIR` | Session runtime directory |
| `GXWI_DISPLAY_NAME` | Display label from the first logon profile |

The compositor exposes `GXWI_DISPLAY` to applications it starts. An
application should connect to that display rather than guessing a socket
path. The session runtime directory and socket are not public network
addresses.

## Locale

GXWI reads machine locale settings and the authenticated user's locale
preferences before starting the session. It clears inherited locale
overrides and falls back to `C.UTF-8` where needed.

Rejoining an existing session does not restart its processes or replace
their environment. Changes to locale, home, display label, or shell apply
when another session is created, according to the relevant service policy.

## Separate overlay runtime

A machine overlay receives its own runtime and job. It is not the overlay
account's ordinary desktop session. Its lifecycle follows the configured
overlay rather than a browser visitor's sign-in.
