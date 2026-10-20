---
title: Machine Overlays
type: concept
description: Understand shared setup programs, their account authority, and failure behavior.
---

A GXWI overlay replaces normal browser sign-in and desktop access with one
shared program. Installation and first-boot setup can use this mechanism.
An overlay is separate from an application overlay surface inside a desktop.

## Shared authority

`OverlaySession` under `Machine\Software\GXWI` names the program.
`OverlayUsername` names its account. GXWI requests a credential-free
Remote Interactive logon for that account. authd must permit that logon;
GXWI does not bypass an account's credential requirement.

Everyone who reaches the service shares the overlay program and its
account authority. Choose an account with only the rights the setup program
needs. Browser visitors do not authenticate individually before using it.

Write access to either registry value therefore controls a public program
and the authority it receives. Protect both values and the executable.

## Activation and failure

GXWI watches the configuration. Setting an overlay starts it. Changing its
program or account replaces it. Removing `OverlaySession` restores normal
sign-in and access to existing sessions.

Normal desktop sessions continue behind the overlay but cannot be reached
through the browser while it is active. The overlay has its own job,
socket, and runtime directory.

If a configured overlay cannot start, GXWI shows a not-ready page and
retries. The delay increases from 1 second to at most 30 seconds. It does
not expose normal sign-in as a fallback. Read the service log to identify
an unavailable program, missing account, or refused credential-free logon.

An invalidly typed or malformed registry value is rejected according to
the setting's validation rules. Read `regman` for the distinction between
invalid configuration and a valid program path that cannot run.
