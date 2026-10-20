---
title: "gxwid.certificate.renewed"
description: "gxwid renewed the machine's GXWI certificate for its existing key."
---

- **Event type:** `gxwid.certificate.renewed`
- **Defined in:** `gxwid.evman`
- **Tier:** essential
- **Gating:** none — every completed certificate renewal is recorded
- **Cardinality:** once per renewal

gxwid renewed the machine's GXWI certificate for its existing private key.
GXWI checks its certificate at startup, every 24 hours, and on service
reload. It renews a certificate with fewer than 30 days remaining or a
validity interval outside the accepted policy. Initial certificate creation
is not a renewal.

The replacement has a different fingerprint, so users who trusted the
preceding certificate need to verify and trust its replacement. Existing TLS
connections continue, and later connections use the replacement. For
browser trust and service behavior, see [Certificate Identity and
Renewal](~peios/desktop-service/certificate-lifecycle).

A renewal record does not establish that a client has trusted the
replacement. Verify the fingerprint through a trusted channel before
importing the certificate.

## Fields

| Field | Type | Presence | Meaning |
|---|---|---|---|
| `object.certificate.digest` | `bin` | required | The SHA-256 digest of the replacement certificate's DER encoding, as 32 bytes. |
| `object.certificate.digest-previous` | `bin` | required | The SHA-256 digest of the preceding certificate's DER encoding, as 32 bytes. Compare it with `object.certificate.digest` to identify the certificate that the renewal replaced. |
| `object.certificate.name` | `str` | required | The replacement certificate's subject, with the machine name as `CN` and `Peios` as `O`. |

The event has no subject, because gxwid renews its own certificate. Every
record also carries the common event envelope. The payload does not repeat
its header fields.

The installed `gxwid.evman` fragment is the event interface reference. This
page summarizes that event for readers of the GXWI documentation.
