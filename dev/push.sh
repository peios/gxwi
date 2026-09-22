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
# libgxwi's example is the app compositors are tried with.
cargo build --release -p libgxwi --example hello
mkdir -p "$share"
# The registry settings, which dev/run-gxwid.sh applies as it starts gxwid.
cp dev/gxwi-dev.reg "$share/gxwi-dev.reg.new"
mv "$share/gxwi-dev.reg.new" "$share/gxwi-dev.reg"
cp target/release/examples/hello "$share/gxwi-hello-app.new"
mv "$share/gxwi-hello-app.new" "$share/gxwi-hello-app"
# Its icon, for the base theme (PGSS Icons), under the name the app carries.
mkdir -p "$share/icons/base"
cp libgxwi/examples/hello/hello.svg "$share/icons/base/dev.peios.gxwi.hello.svg"
cp target/x86_64-unknown-linux-musl/release/gxwi-server "$share/gxwi-server.new"
mv "$share/gxwi-server.new" "$share/gxwi-server"
cp target/release/gxwi-hello "$share/gxwi-hello.new"
mv "$share/gxwi-hello.new" "$share/gxwi-hello"
cp target/release/gxwid "$share/gxwid.new"
mv "$share/gxwid.new" "$share/gxwid"
