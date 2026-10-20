---
title: Reconnection and the Waiting Page
type: concept
description: Distinguish browser reconnection, session lifetime, and the cached waiting page.
---

A browser connection and a desktop session have different lifetimes.
Losing network access does not save or end applications. Reconnection works
only while the relevant service, session, and application state remain
available.

## The waiting page

GXWI supplies a service worker at `/.gxwi/sw.js`. When browser policy
permits registration, it caches the waiting page and that page's assets.
It does not cache ordinary application content as an offline desktop.
Requests marked `cache: "no-store"` bypass its interception. Cache cleanup
removes only obsolete GXWI waiting-page caches, preserving unrelated caches.

A failed navigation or a navigation taking more than 10 seconds can show
the waiting page. A navigation timeout aborts the underlying fetch rather
than leaving it running. Caller cancellation remains cancellation.
The page checks for the machine every 1.5 seconds and
returns when it can reach it. A browser that cannot register the service
worker can show its own network error instead.

Trust the machine's certificate through the browser's supported controls.
An exception at a certificate warning does not guarantee that the service
worker can run.

## Worker and session recovery

`gxwid` retains the listening socket when `gxwi-server` restarts. This
allows connections to queue while the worker is unavailable, within the
operating system's backlog limits. It does not guarantee that every client
request survives a restart.

The privileged daemon retains session jobs independently of the network
worker. A browser might need to authenticate again after worker state is
lost. Reconnecting to a surviving session differs from restoring a stopped
application.

## Diagnose a failed connection

Check the failure in order:

1. Confirm that the machine is reachable at the configured address and port.
2. Verify the certificate through a trusted console.
3. Check the `gxwid` service log for worker, authentication, or compositor
   startup failures.
4. Check whether a machine overlay intentionally hides normal sessions.
5. Verify that the compositor and application processes remain running.
