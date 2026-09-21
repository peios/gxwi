# Runs in the guest, once per boot, from the 9p share drive.py mounts at /share.
# The VM must also carry the same host directory as a second 9p device tagged
# `gxwishare` (dev/boot.sh adds it): one tag cannot be mounted twice.
export REG_ASSUME_YES=1

# The shipped network policy drops inbound flows to any port no rule names.
reg apply --yes /share/allow-7780.reg > /share/apply.txt 2>&1

# gxwi-server's restricted token matches nothing but its capability SID, so the
# fallback descriptor a synthesising mount gives its files (SYSTEM,
# Administrators, Everyone) denies it. Mount the build output again with a
# template that also names the capability. This is dev tooling: the share
# holds only our own build output.
CAP=$(/share/gxwid --print-capability-sid)
mkdir -p /gxwi
mount -t 9p -o trans=virtio,version=9p2000.L,policy=synth-ephemeral \
    --synth-sddl "O:SYG:SYD:(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)(A;OICI;GRGX;;;WD)(A;OICI;GRGX;;;$CAP)" \
    gxwishare /gxwi > /share/mount.txt 2>&1
echo "rc=$? cap=$CAP" >> /share/mount.txt

reg apply --yes /share/gxwid-dev-service.reg >> /share/apply.txt 2>&1
sh /share/devloop.sh &

# For the host to read: how the service fared, and the token the server got.
(
    sleep 5
    svctl status gxwid > /share/status.txt 2>&1
    for p in /proc/[0-9]*; do
        [ "$(cat "$p/comm" 2>/dev/null)" = gxwi-server ] && pid=${p#/proc/}
    done
    token show --pid "${pid:-0}" > /share/token.txt 2>&1
) &
