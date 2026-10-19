#!/bin/sh
# Runs in the guest, once per boot, from the 9p share drive.py mounts at /share.
# The VM must also carry the same host directory as a second 9p device tagged
# `gxwishare` (dev/boot.sh adds it): one tag cannot be mounted twice.
export REG_ASSUME_YES=1

# The shipped network policy drops inbound flows to any port no rule names.
reg apply --yes /share/allow-7780.reg >/share/apply.txt 2>&1

# gxwi-server's restricted token matches nothing but its capability SID, so the
# fallback descriptor a synthesising mount gives its files (SYSTEM,
# Administrators, Everyone) denies it. Mount the build output again with a
# template that also names the capability. This is dev tooling: the share
# holds only our own build output.
CAP=$(/share/gxwid --print-capability-sid)
mkdir -p /gxwi
mount -t 9p -o trans=virtio,version=9p2000.L,policy=synth-ephemeral \
    --synth-sddl "O:SYG:SYD:(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)(A;OICI;GRGX;;;WD)(A;OICI;GRGX;;;$CAP)" \
    gxwishare /gxwi >/share/mount.txt 2>&1
echo "rc=$? cap=$CAP" >>/share/mount.txt

reg apply --yes /share/gxwid-dev-service.reg >>/share/apply.txt 2>&1
sh /share/devloop.sh &

# Someone to log on as. The live image ships `peios`, an administrator with no
# credential, which never exercises a prompt. `alice` is an ordinary user with a
# password; lps reads it from a pipe when stdin is not a terminal.
printf '%s\n' 'alice-dev-password' | lps add alice --no-prompt >/share/accounts.txt 2>&1
# `dana` is an administrator with a password, for what alice may not do: an
# app is tried as both, since what it offers depends on who is asking.
printf '%s\n' 'dana-dev-password' | lps add dana --group Administrators --no-prompt >>/share/accounts.txt 2>&1

# Commands from the host (dev/guest.sh), run as this console's administrator.
# The console itself is drive.py's and nobody can type at it.
(
    while :; do
        if [ -e /share/cmd.sh ]; then
            mv /share/cmd.sh /share/cmd.running
            sh /share/cmd.running >/share/cmd.out 2>&1
            echo "rc=$?" >>/share/cmd.out
            mv /share/cmd.running /share/cmd.done
        fi
        sleep 1
    done
) &
