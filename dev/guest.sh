#!/bin/sh
# Runs on the host: run a shell command in the VM dev/boot.sh started, as its
# console's administrator, and print what it said.
#
#     dev/guest.sh 'svctl status gxwid'
set -eu
cd "$(dirname "$0")/.."
share=target/vmshare
rm -f "$share/cmd.done" "$share/cmd.out"
printf '%s\n' "$*" > "$share/cmd.new"
mv "$share/cmd.new" "$share/cmd.sh"
i=0
until [ -e "$share/cmd.done" ]; do
    i=$((i + 1))
    [ "$i" -le 120 ] || { echo "guest.sh: no answer from the guest" >&2; exit 1; }
    sleep 0.5
done
cat "$share/cmd.out"
