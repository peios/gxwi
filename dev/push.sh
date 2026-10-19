#!/bin/sh
# Build declared artifacts and publish complete files to the caller's VM share.
set -eu
cd "$(dirname "$0")/.."
. dev/env.sh
share=${GXWI_VM_SHARE:-target/vmshare}
./bazel build --//build:package-mode=true \
    //gxwid //gxwi-server //gxwi-hello //gxwi:hello //libgxwi:shared
mkdir -p "$share"

publish() {
    source=$1
    destination=$2
    temporary=$(mktemp "$share/.push.XXXXXXXX")
    trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
    cp "$source" "$temporary"
    chmod 755 "$temporary"
    mv -f "$temporary" "$share/$destination"
    trap - EXIT HUP INT TERM
}

artifact() {
    ./bazel cquery --//build:package-mode=true --output=files "$1"
}

cp dev/gxwi-dev.reg "$share/gxwi-dev.reg.new"
mv "$share/gxwi-dev.reg.new" "$share/gxwi-dev.reg"
publish "$(artifact //libgxwi:shared)" libgxwi.so.1
publish "$(artifact //gxwi:hello)" gxwi-hello-app
mkdir -p "$share/icons/base" "$share/apps"
cp gxwi/examples/hello/hello.svg "$share/icons/base/dev.peios.gxwi.hello.svg"
cp gxwi/examples/hello/dev.peios.gxwi.hello.toml "$share/apps/dev.peios.gxwi.hello.toml"
publish "$(artifact //gxwi-server)" gxwi-server
publish "$(artifact //gxwi-hello)" gxwi-hello
# gxwid goes last: the guest development loop restarts its service on change.
publish "$(artifact //gxwid)" gxwid
