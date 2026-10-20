---
title: Certificate Renewal
description: Interpret the event that records a replacement GXWI certificate.
---

`gxwid.certificate.renewed` records replacement of the machine's GXWI
certificate for its existing private key. Initial certificate creation is
not a renewal. The event has essential tier and occurs once per renewal.

The record identifies both sides of the change:

| Field | Meaning |
|---|---|
| `object.certificate.digest` | SHA-256 digest of the replacement certificate |
| `object.certificate.digest-previous` | SHA-256 digest of the preceding certificate |
| `object.certificate.name` | Replacement certificate subject |

The digests contain 32 bytes of the certificate's DER encoding hash. The
event has no subject because the daemon renews its own certificate.

The exact field definitions and emission policy belong to `gxwid.evman`.
Read them with `evman gxwid.certificate.renewed`. For browser trust and
service behavior, see
[Certificate Identity and Renewal](~peios/signing-in-from-a-browser/certificate-lifecycle).

A renewal record does not establish that a client has trusted the
replacement. Verify the fingerprint through a trusted channel before
importing the certificate.
