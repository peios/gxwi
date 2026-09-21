#!/bin/sh
# Runs on the host: boot a Peios VM that runs gxwid from this checkout's build
# output, reachable at http://127.0.0.1:7780/. Stays up until the VM is killed
# or the timeout passes. Rebuild into it with dev/push.sh.
set -eu
cd "$(dirname "$0")/.."
share="$PWD/target/vmshare"
./dev/push.sh
cp dev/allow-7780.reg dev/gxwid-dev-service.reg dev/devloop.sh dev/guest-start.sh "$share/"
rm -f "$share"/*.log "$share"/*.txt
# drive.py types this into the guest console, so it stays tiny.
printf 'sh /share/guest-start.sh\nsleep 14000\n' > "$share/run.sh"
cd ../dist/release
exec ./drive.py --no-disk --share "$share" \
    --hostfwd tcp:127.0.0.1:7780-:7780 \
    --qemu-extra "-fsdev local,id=gxwi,path=$share,security_model=none -device virtio-9p-pci,fsdev=gxwi,mount_tag=gxwishare" \
    --console-log "$share/console.log" --timeout 14400 "$share/run.sh"
