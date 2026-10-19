---
title: Verifying the Machine's Certificate
type: how-to
description: Compare a GXWI certificate with a trusted fingerprint before entering credentials.
---

GXWI creates a certificate for the machine rather than relying on a public
certificate authority. Verify its fingerprint before trusting an unfamiliar
certificate or entering credentials.

## Before you start

Use the machine's trusted local console or another independently verified
channel. A page delivered through the connection being checked cannot
establish that connection's identity.

## Compare the fingerprints

1. At the trusted console, read `/var/state/gxwi/certificate.sha256`.
   The file contains the certificate's SHA-256 fingerprint and is public.
2. In the browser's certificate details, find the SHA-256 fingerprint of the
   certificate presented by the machine.
3. Compare all 32 byte pairs. Spaces or colons between pairs do not affect
   the value. If the fingerprints differ, do not sign in.
4. If they match, check the certificate's name and validity period before
   accepting it or importing it into your browser's trust store.

A matching fingerprint ties the presented certificate to the certificate
read through the trusted channel. It does not establish that a different
hostname is valid for that certificate.

## Trust the verified certificate

The public certificate is `/var/state/gxwi/certificate.pem`. Transfer it
through a trusted channel and import it using your browser's or operating
system's certificate controls. Import only the certificate, never
`key.pem`.

The generated certificate includes the hostname at creation, `localhost`,
`127.0.0.1`, and `::1`. Other network addresses are not included
automatically. Inspect the certificate actually presented; importing it
does not fix a name mismatch or expiry.

Browser trust affects more than the warning page. The
[waiting page](~peios/gxwi-service/reconnection) uses a service worker,
which requires a browser environment that permits it. A certificate
exception does not guarantee that the browser permits service workers.

## Check again after a change

[Certificate renewal](~peios/signing-in-from-a-browser/certificate-lifecycle)
changes the fingerprint even when the private key stays the same. Verify
the replacement through the trusted channel before importing it.

## Installation and first boot

Installation, a restored machine image, or loss of persistent certificate
state can also change the presented certificate. Installation completing
does not prove that the certificate was retained. Verify the installed
machine's fingerprint before entering credentials.
