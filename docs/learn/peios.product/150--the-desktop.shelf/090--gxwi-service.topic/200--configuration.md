---
title: Configuring the GXWI Service
type: how-to
description: Set the listener, compositor, and public sign-in labels with the registry.
---

Configure GXWI through `Machine\Software\GXWI`. The registry's access
checks determine who can change these values. The complete types,
defaults, and validation rules are in `regman` for that path.

## Before you start

Use an account with write access to the required registry values. Keep a
trusted console available when changing remote access. A failed listener
or compositor change can prevent browser access.

## Change the listener

1. Set `Listen` to the numeric address and port to bind, such as
   `127.0.0.1:7780` for local access. Hostnames are not accepted.
2. If other machines need access, configure the corresponding network
   policy under `Machine\System\Network\Rules\Flow`.
3. Restart the `gxwid` service to apply the listener change.
4. Verify that the configured address accepts HTTPS and presents the
   expected certificate before entering credentials.

Changing the listener does not add a name or address to the certificate.
Verify both reachability and certificate identity.

## Choose the compositor

1. Set `Compositor` to the absolute path of the session program.
2. Start a separate test session to verify that the program can start and
   serve a desktop.
3. End and reopen existing sessions when they need the changed compositor.

The value applies to sessions created after the change. A missing executable
fails session startup; GXWI does not validate program availability when the
registry value is written.

Anyone who can change `Compositor` chooses a program that runs with the
authority of users who start sessions. Protect this value as carefully as
the executable itself.

## Set public labels

Under `Machine\Software\GXWI\Logon`, `Name` supplies a machine label and
`Notice` supplies paragraphs displayed before authentication. Restart
`gxwid` to apply changes. Both are plain text and visible to anyone who
can reach the service. Do not put secrets in them.
