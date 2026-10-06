#!/bin/sh
# Runs on the host: boot a Peios VM that runs gxwid from this checkout's build
# output, reachable at https://127.0.0.1:7780/. Stays up until the VM is killed
# or the timeout passes. Rebuild into it with dev/push.sh.
#
# VM_EXTRA is more for QEMU's command line, for whoever wants the machine to
# have something it does not: ../installer-gxwi/dev/boot.sh gives it disks.
# DRIVE_ARGS is more for drive.py's: the installer's has it start through the
# firmware and survive a restart (--uefi --reboot).
set -eu
cd "$(dirname "$0")/.."
share="$PWD/target/vmshare"
./dev/push.sh
cp dev/allow-7780.reg dev/gxwid-dev-service.reg dev/devloop.sh dev/run-gxwid.sh dev/guest-start.sh "$share/"
rm -f "$share"/*.log "$share"/*.txt
# drive.py types this into the guest console, so it stays tiny.
printf 'sh /share/guest-start.sh\nsleep 14000\n' > "$share/run.sh"
cd ../dist/release
# shellcheck disable=SC2086 # DRIVE_ARGS is words, as VM_EXTRA is.
exec ./drive.py --no-disk ${DRIVE_ARGS:-} --share "$share" \
    --hostfwd tcp:127.0.0.1:7780-:7780 \
    --qemu-extra "-fsdev local,id=gxwi,path=$share,security_model=none -device virtio-9p-pci,fsdev=gxwi,mount_tag=gxwishare ${VM_EXTRA:-}" \
    --console-log "$share/console.log" --timeout 14400 "$share/run.sh"
