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
# The test app and the parts of Fenestra's fallback shell go beside it, where
# Fenestra looks for them. fenesh, the shell proper, goes there too if
# ../fenesh/dev/push.sh has put one on the share, for its setting to name.
for beside in gxwi-hello-app fenestra-taskbar fenestra-launcher fenesh; do
    [ -e "/gxwi/$beside" ] || continue
    cp "/gxwi/$beside" "/tmp/$beside.$$" \
        && sd allow "/tmp/$beside.$$" Everyone:rx \
        && mv "/tmp/$beside.$$" "/tmp/$beside"
done
# Fenestra's launcher lists /bin, where nothing is an app. The test app goes
# there as well, so that there is something to start that can be seen.
[ -e /tmp/gxwi-hello-app ] && cp -p /tmp/gxwi-hello-app /bin/gxwi-hello-app.$$ \
    && sd allow /bin/gxwi-hello-app.$$ Everyone:rx \
    && mv /bin/gxwi-hello-app.$$ /bin/gxwi-hello-app
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
