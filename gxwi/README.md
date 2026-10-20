# GXWI Rust Framework

The `gxwi` crate builds process-owned desktop applications above the
`libgxwi` desktop control interface. It provides live HTML surfaces, named
fields, HTTP routes, settings controls, application declarations, and icon
helpers.

Start with the [application model](../docs/learn/1--peios.shelf/peios.product/550--gxwi-development.shelf/100--gxwi-applications.topic/100--application-model.md)
and the [hello example](examples/hello/main.rs). The example implements a
shared counter and note and also includes a raw-page diagnostic mode.

Use `App::connect` to connect to the compositor-provided `GXWI_DISPLAY`.
Create surfaces and register resources before `App::run`. Keep durable
state in an explicit store; process-owned fields survive browser reconnects
but not application termination.

The C library handles connection and surface control. It does not provide
the Rust rendering or HTTP layer. Read [libgxwi(3)](../docs/man/libgxwi.3)
for C handle ownership and error conventions.

Build the checked example with `./bazel build //gxwi:hello` from the
repository root. Running it requires a compatible Peios desktop session.
See [Building GXWI](../docs/building.md) for SDK prerequisites and checks.
