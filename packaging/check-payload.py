import json, pathlib, sys, subprocess, tomllib
root = pathlib.Path(sys.argv[1])
for binary in ['gxwid', 'gxwi-server', 'gxwi-hello', 'gxwi-hello-app']:
    elf = root / 'usr/bin' / binary
    assert elf.is_file()
    dynamic = subprocess.check_output(['readelf', '-dW', elf], text=True)
    assert 'BIND_NOW' in dynamic and 'RELR' in dynamic
    assert 'RPATH' not in dynamic and 'RUNPATH' not in dynamic and 'TEXTREL' not in dynamic
    notes = subprocess.check_output(['readelf', '-n', elf], text=True)
    if binary == 'gxwi-server':
        headers = subprocess.check_output(['readelf', '-lW', elf], text=True)
        assert 'INTERP' not in headers and 'NEEDED' not in dynamic
        assert 'GNU_RELRO' in headers
    else:
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

# KACS_SCM_TOKEN uses the impersonation gate when handing a principal's
# identity to peinit; SYSTEM identity alone does not satisfy that gate.
service = json.loads((root / 'usr/share/regim/gxwid-service.reg').read_text())
privileges = next(v['data'] for v in service['keys'][0]['values']
                  if v['name'] == 'RequiredPrivileges')
assert 'SeImpersonatePrivilege' in privileges

# The live account is the medium's alone: every system's notice never names
# it, and the live seed's, which a medium applies after it, does.
def notice(name):
    data = json.loads((root / 'usr/share/regim' / name).read_text())
    return next(v['data'] for k in data['keys'] if k['path'].endswith('\\Logon') for v in k['values'] if v['name'] == 'Notice')
assert not any('live image account' in line for line in notice('gxwi-config.reg'))
assert any('live image account' in line for line in notice('gxwi-live-notice.reg'))
