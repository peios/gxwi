---
title: GXWI Process Boundaries
type: concept
description: Trace network traffic, authentication, and application transport across processes.
---

GXWI separates privileged machine operations from network parsing.
`gxwid` owns the listener, certificate state, authentication connections,
and session jobs. `gxwi-server` handles browser traffic with a restricted
token and descriptors supplied by the daemon.

## Browser to desktop

The network worker accepts TLS and HTTP requests. It communicates with the
daemon over private channels for authentication and overlay state. The
daemon starts session jobs with the access token returned by authd.

A compositor receives a session socket and serves HTTP/2 over it. The
network worker forwards requests for the authenticated browser session to
that connection. The compositor then routes desktop and application
requests inside the session.

The externally served protocol and internal transport differ. Browser
connections use HTTP/1.1 over TLS. The worker-to-session connection uses
HTTP/2 over a local socket.

## Session credentials

The network worker owns its session cookies. It strips GXWI authentication
cookies before forwarding requests to a session and prevents application
responses from replacing them. A compositor or application does not need
the browser's session cookie to serve its connection.

The worker also keeps application-origin routing separate from ordinary
session paths. Application-provided labels do not establish another
application's authority.

## Failure boundaries

The daemon restarts a failed network worker with a bounded retry delay.
Keeping the listener and desktop jobs outside that worker allows them to
outlive its failure. This does not make in-flight browser requests
transactional or preserve the worker's in-memory cookie table.

Session startup waits for the compositor to accept its connection within
10 seconds. A program that cannot become ready fails startup rather than
leaving authentication waiting indefinitely.

## Restricted and development execution

Normal execution relies on Peios access tokens, registry access control,
authd, peinit jobs, and local token transfer. A host-only unrestricted run
omits those security mechanisms. It can exercise HTTP and browser code,
but it cannot qualify native authentication or sandbox behavior.
