#!/usr/bin/env python3
"""Check a fresh dev VM running gxwi-hello against the kernel's session table.

Run after guest-start.sh in a VM with the updated authd and kernel:
  python3 dev/check-remote-interactive.py --share /path/to/vmshare

Mount securityfs with policy=synth-ephemeral at /sys/kernel/security first.
The share must run guest-start.sh's command loop and the compositor must be
gxwi-hello, whose response queries its own primary token. Uses only the dev
accounts guest-start.sh documents; never point this at a production system.
"""

import argparse
import html
from html.parser import HTMLParser
from http.cookiejar import CookieJar
from pathlib import Path
import re
import ssl
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, HTTPSHandler, Request, build_opener


class Inputs(HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.fields = {}
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "input" and "name" in attrs:
            self.fields[attrs["name"]] = attrs.get("value", "")


def request(client, url, fields=None):
    data = None if fields is None else urlencode(fields).encode()
    try:
        response = client.open(Request(url, data=data), timeout=15)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.read().decode()


def session_table(share):
    # The same single-command mailbox as guest.sh. Refuse to race another user.
    for name in ("cmd.sh", "cmd.running"):
        if (share / name).exists():
            raise RuntimeError(f"guest command already pending: {name}")
    (share / "cmd.done").unlink(missing_ok=True)
    (share / "cmd.out").unlink(missing_ok=True)
    pending = share / "remote-interactive-command.new"
    pending.write_text("cat /sys/kernel/security/kacs/sessions\n")
    pending.rename(share / "cmd.sh")
    deadline = time.monotonic() + 20
    while not (share / "cmd.done").exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("guest did not return its kernel session table")
        time.sleep(0.1)
    result = (share / "cmd.out").read_text()
    assert result.endswith("rc=0\n"), result
    return result


def login(url, username, password):
    # The dev VM's certificate is its own making, and checking it is not what
    # this is for.
    unchecked = ssl.create_default_context()
    unchecked.check_hostname = False
    unchecked.verify_mode = ssl.CERT_NONE
    client = build_opener(HTTPCookieProcessor(CookieJar()), HTTPSHandler(context=unchecked))
    status, page = request(client, url, {"username": username})
    if password is not None:
        assert status == 401, f"expected a credential prompt, got {status}"
        fields = Inputs(page).fields
        secrets = [name for name in fields if re.fullmatch(r"c\d+", name)]
        assert secrets and "t" in fields, "missing password prompt or form token"
        for name in secrets:
            fields[name] = password
        status, page = request(client, url, fields)
    return client, status, page


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://127.0.0.1:7780/")
    parser.add_argument("--share", required=True, type=Path)
    args = parser.parse_args()

    _, status, _ = login(args.url, "alice", "deliberately-wrong-password")
    assert status == 401, f"wrong password was not denied: {status}"

    for username, password in (("alice", "alice-dev-password"), ("peios", None)):
        client, status, page = login(args.url, username, password)
        assert status == 200, f"{username}: logon failed: {status} {page[:200]}"
        match = re.search(r"<pre>(.*?)</pre>", page, re.S)
        assert match, f"{username}: no compositor token response: {page[:500]}"
        identity = html.unescape(match.group(1))
        session = int(re.search(r"^logon session\s+(0x[0-9a-f]+)$", identity, re.M).group(1), 16)
        groups = set(re.findall(r"^group\s+(S-[\d-]+)\s", identity, re.M))
        assert {"S-1-5-4", "S-1-5-14"} <= groups, identity
        assert "S-1-5-2" not in groups, identity
        if username == "peios":
            assert "S-1-5-32-544" in groups, identity
        else:
            assert "S-1-5-32-544" not in groups, identity
        rows = [dict(field.split("=", 1) for field in line.split())
                for line in session_table(args.share).splitlines()
                if line.startswith("logon_session_id=")]
        row = next(row for row in rows if int(row["logon_session_id"]) == session)
        assert row["logon_type"] == "10", row
        print(f"PASS {username}: session={session} kernel_type=10 "
              "Interactive+RemoteInteractive, no Network", flush=True)
        # End the actual compositor so the test leaves no old session to rejoin.
        status, _ = request(client, args.url.rstrip("/") + "/.hello/logoff", {})
        assert status == 200, status
        deadline = time.monotonic() + 5
        while request(client, args.url)[0] != 401:
            assert time.monotonic() < deadline, "logoff did not end the session"
            time.sleep(0.1)


if __name__ == "__main__":
    main()
