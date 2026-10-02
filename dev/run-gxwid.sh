# Runs in the guest, as the gxwid dev service: start gxwid from the share with
# its output where the host can read it.
#
# The compositor is Fenestra if ../fenestra/dev/push.sh has put one on the
# share, and GXWI's own stand-in otherwise. It is run from a copy off the
# share: a program replaced on 9p while an older copy of it is still running
# (as a session is, across a push) segfaults when next started from there.
# The copy lands in /tmp, whose files only SYSTEM and administrators can
# touch, so everyone is let read and run it.
from=/gxwi/gxwi-hello
[ -e /gxwi/fenestra ] && from=/gxwi/fenestra
cp "$from" /tmp/gxwi-compositor.$$ \
    && sd allow /tmp/gxwi-compositor.$$ Everyone:rx \
    && mv /tmp/gxwi-compositor.$$ /tmp/gxwi-compositor
# GXWI's stand-in is also what dev/browser/overlay.mjs sets as the overlay,
# because it says who it is running as. It is copied off the share for the
# same reason the compositor is.
cp /gxwi/gxwi-hello /tmp/gxwi-overlay.$$ \
    && sd allow /tmp/gxwi-overlay.$$ Everyone:rx \
    && mv /tmp/gxwi-overlay.$$ /tmp/gxwi-overlay
# The test app and the parts of Fenestra's fallback shell go beside it, where
# Fenestra looks for them. fenesh, the shell proper, goes there too if
# ../fenesh/dev/push.sh has put one on the share, for its setting to name.
#
# The installer goes there too if ../installer-gxwi/dev/push.sh has put one on
# the share. Nothing here starts it: its dev/overlay.sh names it as the
# overlay, and takes that away again.
for beside in gxwi-hello-app fenestra-taskbar fenestra-launcher fenesh gexora gxwi-sd-editor services-manager peiterm peitor installer-gxwi; do
    [ -e "/gxwi/$beside" ] || continue
    cp "/gxwi/$beside" "/tmp/$beside.$$" \
        && sd allow "/tmp/$beside.$$" Everyone:rx \
        && mv "/tmp/$beside.$$" "/tmp/$beside"
done
# The test app, Gexora, the permissions editor, Services Manager, peiterm and
# peitor go where a package would put them, /usr/bin, which is where their
# declarations say they are, so that the launcher has something to start that
# can be seen.
for app in gxwi-hello-app gexora gxwi-sd-editor services-manager peiterm peitor; do
    [ -e "/tmp/$app" ] && cp -p "/tmp/$app" "/usr/bin/$app.$$" \
        && sd allow "/usr/bin/$app.$$" Everyone:rx \
        && mv "/usr/bin/$app.$$" "/usr/bin/$app"
done
# An installerd on the share, from ../installer-gxwi/dev/push.sh, takes the
# place of the one the image ships, for the installer to be tried against one
# that is still being written. It is a service of its own, so it is replaced
# where it lives and restarted, and only when the share's is newer: restarting
# it ends whatever conversation it was holding.
if [ -e /gxwi/installerd ] && [ /gxwi/installerd -nt /usr/sbin/installerd ]; then
    cp /gxwi/installerd "/usr/sbin/installerd.$$" \
        && sd allow "/usr/sbin/installerd.$$" Everyone:rx \
        && mv "/usr/sbin/installerd.$$" /usr/sbin/installerd \
        && svctl restart installerd >> /share/svctl.txt 2>&1
    echo "run-gxwid: installerd replaced from the share" >> /share/gxwi.log
fi
# Their declarations (PGSS Applications) go where the catalogue is, which
# the launcher lists and Fenestra names a running program by. Readable by
# everyone, as the icons are: every part of the shell reads them as whoever
# logged on.
if [ -d /gxwi/apps ]; then
    mkdir -p /usr/share/apps \
        && sd allow --replace --flags CI,OI /usr/share/apps SYSTEM:full Administrators:full Everyone:rx
    for declaration in /gxwi/apps/*.toml; do
        [ -e "$declaration" ] || continue
        cp "$declaration" "/usr/share/apps/$(basename "$declaration").$$" \
            && mv "/usr/share/apps/$(basename "$declaration").$$" "/usr/share/apps/$(basename "$declaration")"
    done
fi
# The icon themes on the share go where PGSS Icons has them looked for.
# Fenestra reads them as whoever logged on, so everyone is let read them. A
# directory made here has no inheritable ACE of its own, so a file made in it
# would be nobody's to write: the ACEs are given to it with inheritance, and
# then the files are made.
for theme in /gxwi/icons/*/; do
    [ -d "$theme" ] || continue
    name=$(basename "$theme")
    for dir in /usr/share/icons "/usr/share/icons/$name"; do
        mkdir -p "$dir" \
            && sd allow --replace --flags CI,OI "$dir" SYSTEM:full Administrators:full Everyone:rx
    done
    for svg in "$theme"*.svg; do
        cp "$svg" "/usr/share/icons/$name/$(basename "$svg").$$" \
            && mv "/usr/share/icons/$name/$(basename "$svg").$$" "/usr/share/icons/$name/$(basename "$svg")"
    done
done
echo "run-gxwid: sessions will run a copy of $from" >> /share/gxwi.log
# What gxwid and Fenestra are to read from the registry, from whichever of
# them has pushed its settings to the share. Applied on every start, so an
# edited one takes a push to try. Nothing in gxwid's environment says any of
# it: the registry is the only place it looks. fenesh's goes last, because it
# names itself as the shell where Fenestra's names the fallback.
for settings in /gxwi/gxwi-dev.reg /gxwi/fenestra-dev.reg /gxwi/fenesh-dev.reg; do
    [ -e "$settings" ] || continue
    echo "run-gxwid: applying $settings" >> /share/gxwi.log
    REG_ASSUME_YES=1 reg apply --yes "$settings" >> /share/gxwi.log 2>&1
done
exec /gxwi/gxwid >> /share/gxwi.log 2>&1
