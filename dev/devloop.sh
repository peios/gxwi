# Runs in the guest: keep the gxwid service running, restarting it whenever the
# host pushes a newer binary. File-change notifications do not cross 9p, so
# poll. Stopping gxwid stops gxwi-server with it.
svctl start gxwid >> /share/svctl.txt 2>&1
while :; do
    touch /tmp/gxwi.stamp
    while ! [ /gxwi/gxwid -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-server -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-hello -nt /tmp/gxwi.stamp ]; do
        sleep 1
    done
    svctl restart gxwid >> /share/svctl.txt 2>&1
done
