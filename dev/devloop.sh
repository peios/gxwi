# Runs in the guest: keep the gxwid service running, restarting it whenever the
# host pushes a newer binary. File-change notifications do not cross 9p, so
# poll. Stopping gxwid stops gxwi-server with it.
#
# The image ships a gxwid of its own and has it running by now, so starting
# the service would find it running and do nothing. It is stopped first, and
# what starts is the dev service the registry now describes.
svctl stop gxwid >> /share/svctl.txt 2>&1
svctl start gxwid >> /share/svctl.txt 2>&1
while :; do
    touch /tmp/gxwi.stamp
    while ! [ /gxwi/gxwid -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-server -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-hello -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/fenestra -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/fenesh -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gexora -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-sd-editor -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-services-manager -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-event-viewer -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-registry-editor -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/gxwi-file-dialog -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/peiterm -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/peitor -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/installer-gxwi -nt /tmp/gxwi.stamp ] \
        && ! [ /gxwi/installerd -nt /tmp/gxwi.stamp ]; do
        sleep 1
    done
    svctl restart gxwid >> /share/svctl.txt 2>&1
done
