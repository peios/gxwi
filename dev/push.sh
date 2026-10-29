#!/bin/sh
# Build declared artifacts and publish complete files to the caller's VM share.
set -eu
cd "$(dirname "$0")/.."
share=${GXWI_VM_SHARE:-target/vmshare}
built=$(mktemp "${TMPDIR:-/tmp}/gxwi-push.XXXXXXXX")
trap 'rm -f -- "$built"' EXIT HUP INT TERM
# pekit prints each target's output, indented, on the line after its name,
# which a build of one target follows with a count of its steps.
pekit build gxwid gxwi_server gxwi_hello hello libgxwi >"$built"
mkdir -p "$share"

publish() {
    source=$1
    destination=$2
    temporary=$(mktemp "$share/.push.XXXXXXXX")
    cp "$source" "$temporary"
    chmod 755 "$temporary"
    mv -f "$temporary" "$share/$destination"
}

artifact() {
    awk -v target="built /$1" 'found { sub(/^  /, ""); print; exit } $0 == target || index($0, target ":") == 1 { found = 1 }' "$built"
}

cp dev/gxwi-dev.reg "$share/gxwi-dev.reg.new"
mv "$share/gxwi-dev.reg.new" "$share/gxwi-dev.reg"
publish "$(artifact libgxwi)" libgxwi.so.1
publish "$(artifact hello)" gxwi-hello-app
mkdir -p "$share/icons/base" "$share/apps"
cp gxwi/examples/hello/hello.svg "$share/icons/base/dev.peios.gxwi.hello.svg"
cp gxwi/examples/hello/dev.peios.gxwi.hello.toml "$share/apps/dev.peios.gxwi.hello.toml"
publish "$(artifact gxwi_server)" gxwi-server
publish "$(artifact gxwi_hello)" gxwi-hello
# gxwid goes last: the guest development loop restarts its service on change.
publish "$(artifact gxwid)" gxwid
