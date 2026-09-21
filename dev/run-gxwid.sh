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
# The test app and the parts of Fenestra's shell go beside it, where Fenestra
# looks for them.
for beside in gxwi-hello-app fenestra-taskbar fenestra-launcher; do
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
echo "run-gxwid: sessions will run a copy of $from" >> /share/gxwi.log
exec /gxwi/gxwid >> /share/gxwi.log 2>&1
