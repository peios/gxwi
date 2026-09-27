"""Stage libgxwi as a Cargo directory source for isolated downstream builds.

Cargo consumers still pin the original Git identity; the signed SDK supplies
its source without forwarding repository credentials into build targets.
"""
import hashlib, json, pathlib, shutil, sys, tomllib
src = pathlib.Path.cwd()
out = pathlib.Path(sys.argv[1]) / 'usr/share/cargo/gxwi'
crate = out / 'libgxwi'
shutil.copytree(src / 'libgxwi', crate)
workspace = tomllib.loads((src / 'Cargo.toml').read_text())['workspace']
manifest = tomllib.loads((crate / 'Cargo.toml').read_text())
for name, value in list(manifest['package'].items()):
    if isinstance(value, dict) and value.get('workspace'):
        manifest['package'][name] = workspace['package'][name]
for name, value in list(manifest['dependencies'].items()):
    if isinstance(value, dict) and value.get('workspace'):
        inherited = workspace['dependencies'][name]
        merged = {'version': inherited} if isinstance(inherited, str) else dict(inherited)
        extra = {k: v for k,v in value.items() if k != 'workspace'}
        features = list(dict.fromkeys(merged.get('features', []) + extra.pop('features', [])))
        merged.update(extra)
        if features: merged['features'] = features
        manifest['dependencies'][name] = merged

def value(v):
    if isinstance(v, dict): return '{ ' + ', '.join(json.dumps(k)+' = '+value(x) for k,x in v.items()) + ' }'
    return json.dumps(v)
(crate / 'Cargo.toml').write_text(''.join('['+table+']\n'+''.join(json.dumps(k)+' = '+value(v)+'\n' for k,v in fields.items())+'\n' for table,fields in manifest.items()))
shutil.copy(src / 'LICENSE', crate / 'LICENSE')
files = {str(p.relative_to(crate)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(crate.rglob('*')) if p.is_file()}
(crate / '.cargo-checksum.json').write_text(json.dumps({'files': files, 'package': None})+'\n')
(out / 'revision').write_text('6a5fa25efea9fd651b7f89669126a3344a8d2106\n')
