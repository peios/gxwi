---
title: Certificate Identity and Renewal
type: concept
description: Understand certificate storage, renewal, and changes to browser trust.
---

GXWI keeps a private key and a certificate in `/var/state/gxwi`. The private
key identifies the machine cryptographically. A renewed certificate uses
the same key but has a different fingerprint.

## Stored identity

The identity files have different access requirements:

| File | Purpose | Intended read access |
|---|---|---|
| `key.pem` | Private ECDSA P-256 key | SYSTEM |
| `certificate.pem` | Public certificate | Everyone |
| `certificate.sha256` | Public SHA-256 fingerprint | Everyone |

Protect the private key when backing up or restoring machine state. Sharing
one key between machines also shares their cryptographic identity. GXWI
does not silently replace an unreadable key; startup fails instead.

## Renewal

A generated certificate starts 1 day before creation and expires 1 year
after creation. GXWI checks certificates at startup, every 24 hours, and
on service reload. It renews a certificate with fewer than 30 days left.
It also replaces certificates outside the accepted lifetime policy.

Renewal uses the machine's hostname at that time. Renaming the machine does
not itself renew an otherwise acceptable certificate.

An authorized operator can request the reload check with:

```sh
svctl reload gxwid
```

This requests the normal check; it does not force renewal of an otherwise
acceptable certificate or end existing desktop sessions.

Existing TLS connections continue. Subsequent connections receive the
replacement certificate. A browser that trusted the preceding certificate
can require verification and import again. See
[Verifying the Machine's Certificate](~peios/signing-in-from-a-browser/the-certificate).

## Renewal records

The event `gxwid.certificate.renewed` records the preceding fingerprint,
the replacement fingerprint, and the certificate subject. Consult
`evman gxwid.certificate.renewed` for its fields. Initial certificate
creation is distinct from renewal.

A renewal record identifies the certificate change; it does not prove that
a browser has imported the replacement. Use the trusted fingerprint file
when verifying a connection.

## Browser policy

GXWI does not send a `Strict-Transport-Security` header. HTTPS remains the
only transport for desktop content. Browser name, expiry, and trust checks
still apply.
