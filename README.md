# GXWI

The Graphical Extensible Web Interface (GXWI) connects browser clients to
Peios desktop sessions. The repository
contains the privileged `gxwid` daemon, its restricted `gxwi-server`
worker, diagnostic programs, the `libgxwi.so.1` C library, and the Rust
`gxwi` application framework. Compositors, desktop shells, and desktop
applications live in separate repositories.

Read the [Learn documentation](docs/learn/1--peios.shelf/peios.product) for browser access,
certificate trust, service configuration, and application development.
Command and C-library references are in [docs/man](docs/man). Registry and
event definitions are [gxwi.regman](docs/gxwi.regman) and
[gxwid.evman](docs/gxwid.evman).

## Build and check

Pekit builds the programs and libgxwi and runs their tests, as
[Building GXWI](docs/building.md) describes:

```sh
pekit build gxwid gxwi_server gxwi_hello hello libgxwi
pekit test
```

Version `0.0.7` remains the development baseline. Passing tests do not
establish release readiness or native desktop qualification.

[Development qualification](docs/development.md) describes the preserved
browser and guest tooling, including its dependencies and test-machine
requirements. The [Rust framework](gxwi/README.md) provides the higher-level
application entry point.
