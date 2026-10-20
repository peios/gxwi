---
title: Signing in from a Browser
type: how-to
description: Open a GXWI desktop, verify its identity, and sign in to a machine account.
---

GXWI displays the Peios desktop in a browser. Applications run on the
Peios machine, using the authority of the account that signs in.

## Before you start

You need the machine's address, its configured HTTPS port, and an account
on that machine. The default port is `7780`. A machine that listens only
on the built-in address `127.0.0.1` needs a reachable listen address and
network policy before another device can connect.

You also need a trusted way to read the machine's certificate fingerprint,
such as its local console. Do not enter credentials before verifying an
unfamiliar certificate.

## Open the desktop

1. Open `https://<machine-address>:7780` in your browser. Replace
   `<machine-address>` with the machine's address or name. Use its configured
   port if it differs from `7780`.
2. If the browser warns about the certificate, follow
   [Verifying the Machine's Certificate](~peios/signing-in/the-certificate).
3. Enter your account name and complete the requested authentication.
4. Check that your desktop appears. Open an application to confirm that the
   session is ready.

An HTTP request redirects to HTTPS. GXWI does not serve a desktop over an
unencrypted connection.

If an installer or setup program appears, the machine is using an
[overlay](~peios/desktop-service/overlays). Follow that program's instructions.
Normal sign-in and existing desktops remain inaccessible while the overlay
is configured.

## Leave and return

Closing a browser tab does not request the end of the desktop session.
Sign in again to reconnect to a running session. Unsaved application state
survives only while the application and its session remain running.

Use the desktop's sign-out action to end the session. Do not treat closing
a tab on a shared device as signing out of the machine.
