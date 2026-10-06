#!/usr/bin/env python3
"""Pin programs of the graphical stack to dev/pins.toml (PEI-1400).

    python3 dev/repin.py ../gexora ../gxwi-task-manager ...

In each repository named, every dependency on a sibling repository, whether
a path beside the checkout or a Git revision, becomes the Git revision
pins.toml gives it. A recipe's dev.peios.gxwi-sdk constraint becomes the SDK
release pins.toml names. Then each Cargo.lock is brought along by asking
Cargo, which fetches what it needs and changes nothing else.

It changes files and commits nothing. fuzz/ manifests keep their own pins.
"""
import pathlib, re, subprocess, sys, tomllib

here = pathlib.Path(__file__).resolve().parent
pins = tomllib.loads((here / 'pins.toml').read_text())
url, rev = pins['url'], pins['rev']
crate_rev = pins.get('crate', {})
by_url = {u.removesuffix('.git'): name for name, u in url.items()}
siblings = here.parent.parent

LINE = re.compile(r'^(\s*[A-Za-z0-9_-]+\s*=\s*\{)(.*)(\}\s*(#.*)?)$')
PATH = re.compile(r'path\s*=\s*"([^"]+)"')
GIT = re.compile(r'git\s*=\s*"([^"]+)"')
REV = re.compile(r'rev\s*=\s*"[0-9a-f]+"')
SDK = re.compile(r'("dev\.peios\.gxwi-sdk"\s*=\s*")= [^"]+(")')


def owner(manifest: pathlib.Path, path: str) -> str | None:
    """The sibling repository a path dependency points into, if it leaves
    its own."""
    target = (manifest.parent / path).resolve()
    try:
        rel = target.relative_to(siblings)
    except ValueError:
        return None
    repo = rel.parts[0]
    mine = manifest.resolve().relative_to(siblings).parts[0]
    return repo if repo != mine else None


def pin_line(manifest: pathlib.Path, line: str) -> str:
    m = LINE.match(line)
    if not m:
        return line
    head, body, tail = m.group(1), m.group(2), m.group(3)
    crate = head.split('=')[0].strip()
    p = PATH.search(body)
    if p:
        repo = owner(manifest, p.group(1))
        if repo is None:
            return line
        if repo not in rev:
            sys.exit(f'{manifest}: {p.group(1)} is in {repo}, which pins.toml does not name')
        pin = crate_rev.get(crate, rev[repo])
        body = PATH.sub(f'git = "{url[repo]}", rev = "{pin}"', body, count=1)
        return head + body + tail
    g = GIT.search(body)
    if g:
        repo = by_url.get(g.group(1).removesuffix('.git'))
        if repo is None:
            return line
        pin = crate_rev.get(crate, rev[repo])
        if REV.search(body):
            body = REV.sub(f'rev = "{pin}"', body, count=1)
        else:
            body = GIT.sub(f'git = "{g.group(1)}", rev = "{pin}"', body, count=1)
        return head + body + tail
    return line


def manifests(repo: pathlib.Path):
    for m in sorted(repo.rglob('Cargo.toml')):
        parts = m.relative_to(repo).parts
        if {'target', 'fuzz', 'vendor', 'out'} & set(parts) or any(p.startswith('.') for p in parts):
            continue
        yield m


def main():
    for arg in sys.argv[1:]:
        repo = pathlib.Path(arg).resolve()
        locks = []
        for m in manifests(repo):
            old = m.read_text()
            new = ''.join(pin_line(m, l) for l in old.splitlines(keepends=True))
            if new != old:
                m.write_text(new)
            if (m.parent / 'Cargo.lock').exists():
                locks.append(m)
        for recipe in [repo / 'pekit.toml', *sorted(repo.glob('*/pekit.toml'))]:
            if recipe.exists():
                old = recipe.read_text()
                new = SDK.sub(rf'\g<1>= {pins["sdk"]["version"]}\g<2>', old)
                if new != old:
                    recipe.write_text(new)
        for m in locks:
            subprocess.run(['cargo', 'metadata', '--format-version', '1', '--manifest-path', str(m)],
                           check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['git', '-C', str(repo), 'diff', '--stat'], check=True)


main()
