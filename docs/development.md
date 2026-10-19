# Development Qualification

The `dev/` directory preserves the GXWI browser and guest integration
harness. It coordinates a larger desktop stack than this repository alone.
The scripts are qualification tools, not the production build interface.
Use [Building GXWI](building.md) for Bazel and package generation.

## Scope and prerequisites

The browser cases exercise sign-in, sessions, desktop surfaces, controls,
raw pages, and applications from other repositories. They expect a prepared
disposable Peios guest, Chromium, Node.js, and the guest command channel.
Read each case's prerequisites before running it. Set `GXWI_VM_RUNNER` to
the absolute path of the image runner before using `dev/boot.sh`.

`dev/legacy/pins.toml` records the historical stack revisions used by the
harness.
The pinning workflow belongs to the historical Cargo and Pekit stack.
Active browser cases use the consolidated application identities, while
retaining test artifact names where they identify historical evidence.
These cases still need a matching image and service configuration. Their
presence does not establish compatibility with every desktop stack.
Record the exact substituted paths and revisions when adapting a run.

## Tool responsibilities

The harness separates these operations:

| Tool or directory | Responsibility |
|---|---|
| `dev/legacy/pins.toml` and `dev/legacy/repin.py` | Cross-repository input revisions |
| `dev/boot.sh` | Guest startup configuration |
| `dev/push.sh` | Artifact transfer into the development setup |
| `dev/guest.sh` | Commands through the guest control channel |
| `dev/devloop.sh` | Service restart after staged artifact changes |
| `dev/browser/` | Browser interaction cases and shared harness |
| `dev/check-remote-interactive.py` | Native logon and session identity checks |

Inspect these scripts before execution. Guest commands can change accounts,
registry values, services, and files. Use disposable test accounts and
images, never production credentials.

The development push builds through Bazel. The guest startup script stages
`libgxwi.so.1` atomically before application startup, and the service loop
watches shared-library changes as well as executable changes.

## Certificate and account assumptions

The browser harness uses development credentials and Chromium's certificate
error override. That override is for isolated test machines. It does not
verify the machine's certificate and is not a model for normal sign-in.

`GXWI_DESK` can select a different desktop endpoint for browser cases.
Set it only to the disposable machine being qualified. The shared harness
can invoke commands as the guest console administrator.

## Record results by layer

Keep build, unit-test, browser, and native-security results separate. A host
unrestricted run does not exercise KACS restriction, authd identity, or
peinit token transfer. A live browser success does not prove every package
manifest or source archive is correct.

Capture the booted image identity, component revisions, configuration,
case names, logs, and observed outcomes outside the published Learn tree.
When a case is skipped, record the missing prerequisite and its untested
behavior instead of treating it as a pass.

## Visual handover

The sign-in pages can share decorative state with another page on their
origin through `sessionStorage` key `gxwi.field`. This is presentation
state, not authentication state. The implementation in
`gxwi-server/src/logon.js` owns its accepted shape and age checks.

The stored object uses version `1` and carries a timestamp, viewport size,
animation clock, glow clocks, star values, and an optional arrival effect.
Malformed or expired state is ignored. Preserve this behavior when adapting
the browser tests; visual continuity must not become a prerequisite for
authentication or session access.
