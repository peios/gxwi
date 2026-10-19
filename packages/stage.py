#!/usr/bin/python3
"""Stage and validate declared GXWI artifacts before writing any PPK commit."""

import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import TypedDict, cast

sys.dont_write_bytecode = True
from licences import collect, combined  # noqa: E402
from sdk import stage_sdk  # noqa: E402
from validate import validate  # noqa: E402


class ComponentInput(TypedDict):
    """Declared binary and transitive source inputs from the staging rule."""

    binary: str
    inputs: list[str]


class StageSpec(TypedDict):
    """Internal staging manifest emitted by packages/build.bzl."""

    components: dict[str, ComponentInput]
    sources: list[str]
    version: str
    sdk: str
    rustc: str
    native: bool


LIBDIR = "usr/lib/x86_64-linux-peios"
DESTINATIONS = {
    "gxwid": "usr/bin/gxwid",
    "gxwi-server": "usr/bin/gxwi-server",
    "gxwi-hello": "usr/bin/gxwi-hello",
    "gxwi-hello-app": "usr/bin/gxwi-hello-app",
    "libgxwi": LIBDIR + "/libgxwi.so.1",
}


def copy(source: Path, target: Path) -> None:
    """Copy a file while normalizing its mode for an installed payload."""
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    target.chmod(0o755 if source.stat().st_mode & 0o111 else 0o644)


def split_debug(component: str, elf: Path, output: Path) -> None:
    """Split ELF debug data and record the GNU build ID and debug link."""
    notes = subprocess.check_output(["readelf", "-n", str(elf)], text=True)
    match = re.search(r"Build ID: ([0-9a-f]+)", notes)
    if not match:
        raise ValueError(f"missing build ID: {elf}")
    build_id = match.group(1)
    debug = (
        output / f"debug/{component}/usr/lib/debug/.build-id/{build_id[:2]}/{build_id[2:]}.debug"
    )
    debug.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["objcopy", "--only-keep-debug", elf, debug], check=True)
    subprocess.run(["strip", "--strip-unneeded", elf], check=True)
    subprocess.run(["objcopy", f"--add-gnu-debuglink={debug}", elf], check=True)


def source_files(inputs: list[Path]) -> list[Path]:
    """Resolve declared source files and generated bindings, rejecting missing inputs."""
    files = set()
    for path in inputs:
        if path.is_dir():
            # Generated bindings and build-script source products, not compiled archives.
            files.update(
                p for p in path.rglob("*") if p.is_file() and p.suffix in {".rs", ".h", ".c"}
            )
        elif path.is_file():
            files.add(path)
        else:
            raise ValueError(f"missing declared input: {path}")
    return sorted(files)


def stage_data(sources: list[Path], output: Path, version: str) -> None:
    """Install references, inert seeds, developer headers and the demonstration app."""
    for source in sources:
        if source.parent == Path("docs/man"):
            section = source.suffix[1:]
            target = output / f"usr/share/man/man{section}/{source.name}.gz"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(gzip.compress(source.read_bytes(), compresslevel=9, mtime=0))
        elif source.parent == Path("registry.d"):
            copy(source, output / "usr/share/regim" / source.name)
        elif source.suffix in (".regman", ".evman") and source.parent == Path("docs"):
            copy(source, output / ("usr/share/" + source.suffix[1:]) / source.name)
        elif source.parent == Path("libgxwi/include/peios"):
            copy(source, output / "usr/include/peios" / source.name)
        elif source == Path("gxwi/examples/hello/hello.svg"):
            copy(source, output / "usr/share/icons/base/dev.peios.gxwi.hello.svg")
        elif source == Path("gxwi/examples/hello/dev.peios.gxwi.hello.toml"):
            copy(source, output / "usr/share/apps" / source.name)
    library = output / LIBDIR
    library.mkdir(parents=True, exist_ok=True)
    (library / "libgxwi.so").symlink_to("libgxwi.so.1")
    pkgconfig = library / "pkgconfig/gxwi.pc"
    pkgconfig.parent.mkdir(exist_ok=True)
    pkgconfig.write_text(
        f"prefix=/usr\nlibdir=/{LIBDIR}\nincludedir=${{prefix}}/include\n\n"
        "Name: gxwi\nDescription: GXWI desktop client library\n"
        f"Version: {version}\nLibs: -L${{libdir}} -lgxwi\nCflags: -I${{includedir}}\n"
    )


def check_versions(sources: list[Path], version: str) -> None:
    """Reject an omitted package manifest or a version that differs from the build rule."""
    manifest = Path("Cargo.toml")
    if manifest not in sources:
        raise ValueError("missing package manifest input")
    package = tomllib.loads(manifest.read_text(encoding="utf-8"))["workspace"]["package"]
    if package["version"] != version:
        raise ValueError("package version differs from Bazel")


def _stage_components(
    components: dict[str, ComponentInput], output: Path, debug_inputs: set[Path]
) -> dict[str, str]:
    if set(components) != set(DESTINATIONS):
        raise ValueError("incomplete or unexpected GXWI binary set")
    runtime_inputs = set(debug_inputs)
    library_inputs = set(debug_inputs)
    for name, component in components.items():
        elf = output / DESTINATIONS[name]
        copy(Path(component["binary"]), elf)
        split_debug("libgxwi" if name == "libgxwi" else "gxwi", elf, output)
        inputs = source_files([Path(path) for path in component["inputs"]])
        debug_inputs.update(inputs)
        (library_inputs if name == "libgxwi" else runtime_inputs).update(inputs)
    runtime = collect(sorted(runtime_inputs), output / "licenses")
    library = collect(sorted(library_inputs), output / "licenses-libgxwi")
    # The restricted worker statically includes musl; its copyright travels with it.
    copy(Path("third-party/musl-COPYRIGHT"), output / "licenses/musl-COPYRIGHT")
    runtime = combined({runtime, "OFL-1.1"})
    debug = collect(sorted(debug_inputs), output / "licenses-debugsource")
    copy(Path("third-party/musl-COPYRIGHT"), output / "licenses-debugsource/musl-COPYRIGHT")
    return {"gxwi": runtime, "libgxwi": library, "debugsource": combined({debug, "OFL-1.1"})}


def _stage_debug_sources(debug_inputs: set[Path], output: Path, sdk: Path) -> None:
    # Only source inputs declared by Bazel enter debugsource; never walk a checkout or cache.
    debug_root = output / "usr/src/debug/dev.peios.gxwi"
    for source in sorted(debug_inputs):
        if source.is_relative_to(sdk) or source.suffix in {".so", ".a", ".rlib", ".o"}:
            continue
        if source.is_absolute() or ".." in source.parts:
            raise ValueError(f"non-relative declared source: {source}")
        copy(source, debug_root / source)


def _check_licences(expressions: dict[str, str]) -> None:
    for path in sorted(Path("packages/definitions").glob("*.json")):
        definition = json.loads(path.read_text(encoding="utf-8"))
        name = definition["package"]["name"]
        component = (
            name.removeprefix("dev.peios.").removesuffix("-debuginfo").removesuffix("-devel")
        )
        if component == "gxwi-debugsource":
            component = "debugsource"
        if component in expressions and definition["package"]["license"] != expressions[component]:
            raise ValueError(f"{path}: licence expression differs: {expressions[component]}")


def _write_build_record(
    spec: StageSpec, output: Path, debug_inputs: set[Path], expressions: dict[str, str]
) -> None:
    fingerprints = {
        str(path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(debug_inputs)
        if path.is_file()
    }
    record = {
        "version": spec["version"],
        "userspace_abi": "peios-native" if spec["native"] else "debian-development",
        "release_ready": False,
        "signed": False,
        "checks": "native-hardening-and-payload" if spec["native"] else "development-payload",
        "input_digest": hashlib.sha256(
            json.dumps(fingerprints, sort_keys=True).encode("utf-8")
        ).hexdigest(),
        "licences": expressions,
    }
    (output / "build.json").write_text(
        json.dumps(record, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    """Stage the declared build inputs and write provenance after validation succeeds."""
    spec = cast(StageSpec, json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
    output = Path(sys.argv[2])
    output.mkdir(parents=True, exist_ok=True)
    sources = [Path(path) for path in spec["sources"]]
    check_versions(sources, spec["version"])
    debug_inputs = set(sources)
    expressions = _stage_components(spec["components"], output, debug_inputs)
    _stage_debug_sources(debug_inputs, output, Path(spec["sdk"]))
    _check_licences(expressions)
    stage_data(sources, output, spec["version"])
    stage_sdk(sources, output)
    os.environ["RUSTC"] = str(Path(spec["rustc"]).absolute())
    validate(output, native=spec["native"], sdk=Path(spec["sdk"]))
    _write_build_record(spec, output, debug_inputs, expressions)


if __name__ == "__main__":
    main()
