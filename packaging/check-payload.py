import json, pathlib, sys, subprocess, tomllib
root = pathlib.Path(sys.argv[1])
for binary in ['gxwid', 'gxwi-server', 'gxwi-hello', 'gxwi-hello-app']:
    elf = root / 'usr/bin' / binary
    assert elf.is_file()
    dynamic = subprocess.check_output(['readelf', '-dW', elf], text=True)
    assert 'BIND_NOW' in dynamic and 'RELR' in dynamic
    assert 'RPATH' not in dynamic and 'RUNPATH' not in dynamic and 'TEXTREL' not in dynamic
    notes = subprocess.check_output(['readelf', '-n', elf], text=True)
    assert 'IBT' in notes and 'SHSTK' in notes
    build_id = notes.split('Build ID: ')[1].split()[0]
    debug = root / 'debug' / 'gxwi' / 'usr/lib/debug/.build-id' / build_id[:2] / (build_id[2:] + '.debug')
    assert debug.is_file()
for seed in (root / 'usr/share/regim').glob('*.reg'):
    data = json.loads(seed.read_text())
    assert data['keys']
    assert '/tmp/' not in seed.read_text() and '/share/' not in seed.read_text()
for app in (root / 'usr/share/apps').glob('*.toml'):
    tomllib.loads(app.read_text())

# Seeds are applied in filename order: GXWI precedes port-reservations.
# Its network seed must create every parent below the existing System key.
known = {r'Machine', r'Machine\System'}
network = json.loads((root / 'usr/share/regim/gxwi-network.reg').read_text())
for key in network['keys']:
    path = key['path']
    assert path.rsplit('\\', 1)[0] in known, path
    known.add(path)
