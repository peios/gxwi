#!/bin/sh
# Runs on the host: build the binaries and put them where the guest's
# devloop.sh picks them up. The rename makes each new binary appear whole,
# never half-written. gxwid goes last: it is the one devloop.sh restarts on.
#
# gxwi-server is static, because its restricted token can open no shared
# library. gxwid links libpeios, so it is an ordinary glibc build and uses the
# libpeios the guest image ships.
set -eu
cd "$(dirname "$0")/.."
. dev/env.sh
share=target/vmshare
cargo build --release -p gxwi-server --target x86_64-unknown-linux-musl
cargo build --release -p gxwid -p gxwi-hello
mkdir -p "$share"
cp target/x86_64-unknown-linux-musl/release/gxwi-server "$share/gxwi-server.new"
mv "$share/gxwi-server.new" "$share/gxwi-server"
cp target/release/gxwi-hello "$share/gxwi-hello.new"
mv "$share/gxwi-hello.new" "$share/gxwi-hello"
cp target/release/gxwid "$share/gxwid.new"
mv "$share/gxwid.new" "$share/gxwid"
