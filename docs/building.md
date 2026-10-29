# Building GXWI

Use pekit to build GXWI's programs and C library and to run their tests.
Pekit builds each crate on its own, so a change rebuilds only the crates it
reaches. The supported development host is x86-64 Linux. Host checks and
native Peios checks cover different environments; neither replaces a live
desktop qualification run.

## Before you start

You need pekit and Git. Everything else is pinned and fetched by pekit on
the first build: the Bootlin C toolchains, Rust 1.98.1 with Clippy and the
musl standard library, Python 3.14, busybox, Node.js 22, libclang, and the
crates `Cargo.lock` selects. The first build needs network access; later
builds find what they need in pekit's store, and every step runs without
network access in a sandbox that holds only its declared inputs.

The build files use the gcslib libraries named in `workspace.gcsl` and the
build files, and the libraries of peios-rs and the Peios SDK. `pekit lock`
pins their commits in `pekit.lock`.

## Build

```sh
pekit build gxwid gxwi_server gxwi_hello hello libgxwi
```

| Target | Output |
|---|---|
| `gxwid` | Privileged daemon |
| `gxwi_server` | Static musl network worker |
| `gxwi_hello` | Diagnostic compositor |
| `hello` | Framework demonstration application, installed as `gxwi-hello-app` |
| `libgxwi` | C shared library, `libgxwi.so.1` by its shared object name (SONAME) |

Pekit prints where each output is, under `pekit-out/<target>/`. The network
worker is a static, position-independent musl program with no ELF
interpreter, linked with full RELRO and immediate binding. The other
programs and libgxwi load `libpeios.so.0`, and `hello` loads
`libgxwi.so.1`, by their SONAMEs; they carry no runtime search path.

`hello` is the `gxwi` crate's example. The `gxwi` crate links libgxwi, so
pekit builds libgxwi first and gives the crate's build script its
directory, as `PEIOS_GXWI_LIB_DIR`.

`dev/push.sh` builds the same targets and copies them into a development
virtual machine's share; see [Development Qualification](development.md).

## Test

```sh
pekit test
```

| Test | Check |
|---|---|
| `gxwi_abi`, `gxwi_channel`, `gxwi_hello`, `gxwi_server`, `gxwid`, `libgxwi`, `gxwi` | Each member's unit tests |
| `gxwi_server_static` | The network worker's tests, compiled as the static musl program it ships as |
| `doctests` | Each member's documentation tests |
| `clippy` | Clippy's checks of every target of every member, with every warning denied |
| `shared_library` | libgxwi exports exactly the functions in `libgxwi/exports.txt`, carries its SONAME, and links libpeios |
| `c_abi` | A C program built from `libgxwi/tests/abi.c` checks the header's structure layout and the library's argument checks |
| `service_worker` | Node.js's test runner checks the browser service worker in `gxwi-server/src/sw.test.mjs` |

These tests do not start a desktop or authenticate a real account. A test
whose inputs did not change is found in the store and not run again.

For the full contributor check, install the pinned PSC tools into a
directory outside the repository, then run the shared entry point:

```sh
python3 tools/prepare-style-tools.py "$HOME/.cache/gxwi-style"
export PEIOS_STYLE_BIN="$HOME/.cache/gxwi-style/bin"
tools/check
```

`tools/check` checks owned source formatting and lint with rustfmt,
Prettier, ESLint, Ruff, ShellCheck, and shfmt, then runs `pekit test`. The
style checks use the host's Rust 1.98.1 formatter through rustup. The tool
versions and hashes are recorded in `tools/style-tools.lock.json`.
GitHub's workflow runs the style checks alone; builds and tests run with
pekit.

Run `tools/check-docs` with `TRAIL` naming the Trail executable for strict
Learn and reference-prose checks.

## How the build is planned

`build.gcsl` plans the Cargo workspace with the gcslib rust library's
`workspace`: Cargo works out each member's build, unit by unit, and pekit
compiles each unit as a step. Planning reads the manifests, `Cargo.lock`,
and which files exist, never the sources, so editing a source plans nothing
again. The network worker's workspace is planned for
`x86_64-unknown-linux-musl`; the rest is planned for glibc.

Keep Rust dependency versions in the Cargo manifests and `Cargo.lock`, and
update the lockfile deliberately with Cargo. `peios-sys` generates its
bindings from the SDK's headers with bindgen and links libpeios, so it, and
every crate that depends on it, is given what peios-rs's library says it
needs, `crate_settings()`: libpeios and its headers, built from the Peios
SDK's own files.

The commits `pekit.lock` pins say which SDK and which peios-rs; the rust
library fails a build whose `Cargo.lock` takes peios-rs's crates at another
commit than `pekit.lock` pins its library at. GXWI takes authd's crates at
a commit that uses the same peios-rs, so that one `peios-sys` serves both.

## Not built with pekit yet

Packages, debug information, and builds with the native Peios toolchain,
which hardens programs with control-flow enforcement technology (CET), are
not yet built with pekit. The package definitions and native build settings
from the Bazel build are kept outside this repository until they are.

Record the source revision, toolchain and SDK identities, and complete logs
for each qualification run. Treat browser integration, authentication,
token isolation, and installed package operation as separate checks in a
disposable guest.
