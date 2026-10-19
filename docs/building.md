# Building GXWI

Bazel provides the build, test, and packaging interface. Host checks and
native Peios checks cover different environments; neither replaces a live
desktop qualification run.

## Prepare a host SDK

Use Linux on x86-64 with the repository's pinned Bazel launcher and Rust
toolchains. The native API dependency needs a prepared libpeios SDK and
matching kernel user API headers.

Prepare an SDK outside the source tree:

```sh
tools/prepare-dev-sdk <libpeios-root> <kernel-uapi-root> <sdk-output>
export PEIOS_SDK=<sdk-output>
```

Replace the placeholders with absolute paths to the libpeios source,
exported kernel user API headers, and output SDK directory. The helper's
checks establish whether those inputs are usable; a path alone does not
establish compatibility with a booted kernel.

## Build programs and tests

Run the host test suite and build the package store:

```sh
./bazel test //...
./bazel build //:packages
```

Individual targets separate the platform's parts:

| Target | Output |
|---|---|
| `//gxwid` | Privileged daemon |
| `//gxwi-server` | Static musl network worker |
| `//gxwi-hello` | Diagnostic compositor |
| `//gxwi:hello` | Framework demonstration application |
| `//libgxwi:shared` | C shared library |
| `//gxwi` | Rust application framework |

Run `tools/check` for the repository's combined style and code checks.
Run `tools/check-docs` with `TRAIL` naming the Trail executable for strict
Learn and reference-prose checks. These commands do not start a desktop or
authenticate a real account.

## Inspect packages

`bazel-bin/packages.store` holds canonical blobs and manifests. The package
family separates the GXWI runtime, Rust SDK, C shared library, C development
files, and source or debugging data. The version remains `0.0.7`; this
migration does not declare a release.

Inspect the manifests and payloads before publication. Local unsigned
packages and successful source checks do not establish release readiness.

## Build in native Peios userspace

Acquire dependencies while network access is available:

```sh
tools/offline-build acquire <snapshot-directory>
```

Use an absolute `<snapshot-directory>` outside the repository. Preserve the
snapshot with the exact source revision being qualified.

Inside a prepared Peios userspace, supply `PEIOS_SDK` and `PEIOS_RUSTC`,
then run the offline operations:

```sh
tools/offline-build build <snapshot-directory> <work-directory>
tools/offline-build test <snapshot-directory> <work-directory>
```

Replace `<work-directory>` with an absolute writable location for isolated
build output. The native environment must include compatible Peios Rust
`1.98.1` tooling, `org.rust-lang.rust-std-x86-64-unknown-linux-musl` version
`1.98.1` or later, and `musl-sysroot` version `1.2.6` or later. The static
network worker needs the musl target and sysroot as well as the main SDK.

Record the source revision, toolchain and SDK identities, package hashes,
and complete logs for each qualification run. Treat browser integration,
authentication, token isolation, and installed package operation as
separate checks in a disposable guest.
