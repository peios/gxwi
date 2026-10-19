"""Check GXWI's staged desktop payload without launching applications or applying seeds."""

import gzip
import json
import os
import re
import subprocess
import tomllib
import xml.etree.ElementTree as xml
from pathlib import Path

BINARIES = ("gxwid", "gxwi-server", "gxwi-hello", "gxwi-hello-app")
LIBDIR = "usr/lib/x86_64-linux-peios"


def require(condition: bool, message: str) -> None:
    """Keep package gates effective when Python assertions are disabled."""
    if not condition:
        raise ValueError(message)


def readelf(path: Path, option: str) -> str:
    """Read one ELF view, tolerating binary CRC bytes in the debug-link section."""
    return subprocess.check_output(
        ["readelf", option, str(path)],
        text=True,
        errors="replace",
        env=os.environ | {"LC_ALL": "C"},
    )


def build_id(notes: str, path: Path) -> str:
    """Extract the single GNU build identity required by split debugging."""
    matches = re.findall(r"Build ID: ([0-9a-f]+)", notes)
    require(len(matches) == 1 and len(matches[0]) >= 3, f"{path}: missing or ambiguous build ID")
    return matches[0]


def validate_elf(stage: Path, binary: str, *, native: bool) -> None:
    """Require linked hardening and the matching shared-family split debug payload."""
    library = binary == "libgxwi"
    elf = stage / (LIBDIR + "/libgxwi.so.1" if library else "usr/bin/" + binary)
    require(elf.is_file() and os.access(elf, os.X_OK), f"{elf}: missing executable")
    header, program, dynamic = (readelf(elf, option) for option in ("-h", "-lW", "-dW"))
    notes, sections = readelf(elf, "-n"), readelf(elf, "-SW")
    require(bool(re.search(r"Type:\s+DYN\b", header)), f"{elf}: not position independent")
    require("GNU_RELRO" in program and "BIND_NOW" in dynamic, f"{elf}: missing full RELRO")
    stack = [line for line in program.splitlines() if "GNU_STACK" in line]
    require(len(stack) == 1 and bool(re.search(r"\sRW\s", stack[0])), f"{elf}: executable stack")
    if not library:
        require(bool(re.search(r"FLAGS_1.*\bPIE\b", dynamic)), f"{elf}: missing PIE flag")
    if binary == "gxwi-server":
        require("INTERP" not in program and "NEEDED" not in dynamic, f"{elf}: worker is dynamic")
    else:
        require(
            "Shared library: [libpeios.so.0]" in dynamic, f"{elf}: missing libpeios ABI linkage"
        )
    if library:
        require("Library soname: [libgxwi.so.1]" in dynamic, f"{elf}: incorrect client SONAME")
    if binary == "gxwi-hello-app":
        require(
            "Shared library: [libgxwi.so.1]" in dynamic, f"{elf}: client is not dynamically linked"
        )
    require(not re.search(r"\((RPATH|RUNPATH|TEXTREL)\)", dynamic), f"{elf}: unsafe dynamic tag")
    require(".debug_info" not in sections, f"{elf}: unsplit debug information")
    if native:
        if binary != "gxwi-server":
            require("IBT" in notes and "SHSTK" in notes, f"{elf}: missing native CET properties")
        require(bool(re.search(r"\(RELR\)", dynamic)), f"{elf}: missing native packed relocations")
    identity = build_id(notes, elf)
    component = "libgxwi" if library else "gxwi"
    debug = stage / f"debug/{component}/usr/lib/debug/.build-id/{identity[:2]}/{identity[2:]}.debug"
    require(debug.is_file() and debug.stat().st_size > 0, f"{elf}: missing split debug file")
    require(".debug_info" in readelf(debug, "-SW"), f"{debug}: missing debug information")
    require(build_id(readelf(debug, "-n"), debug) == identity, f"{debug}: build ID mismatch")
    require(debug.name in readelf(elf, "--string-dump=.gnu_debuglink"), f"{elf}: wrong debug link")
    forbidden = {str(Path.cwd().resolve()), str(Path.cwd().resolve()).split("/execroot/")[0]}
    for path in (elf, debug):
        contents = path.read_bytes()
        for prefix in forbidden:
            require(len(prefix) <= 1 or prefix.encode() not in contents, f"{path}: leaked {prefix}")


def validate_data(stage: Path) -> None:
    """Preserve the service authority, network reservation and certificate trust guidance."""
    manuals = ("gxwid.8", "gxwi-server.8", "gxwi-hello.1", "gxwi-hello-app.1", "libgxwi.3")
    for name in manuals:
        manual = stage / f"usr/share/man/man{name[-1]}/{name}.gz"
        with gzip.open(manual, "rt", encoding="utf-8") as stream:
            require(
                bool(re.search(r"^\.TH ", stream.read(), re.MULTILINE)),
                f"missing heading: {manual}",
            )
    directory = stage / "usr/share/regim"
    expected = {path.name for path in Path("registry.d").glob("*.reg")}
    require({path.name for path in directory.iterdir()} == expected, "incomplete registry seeds")
    for path in directory.iterdir():
        data = json.loads(path.read_text())
        require(
            data == json.loads((Path("registry.d") / path.name).read_text()),
            f"changed seed: {path}",
        )
        require(bool(data["keys"]), f"empty seed: {path}")
        require(
            "/tmp/" not in path.read_text() and "/share/" not in path.read_text(),
            f"development path: {path}",
        )
    known = {r"Machine", r"Machine\System"}
    for key in json.loads((directory / "gxwi-network.reg").read_text())["keys"]:
        path = key["path"]
        require(path.rsplit("\\", 1)[0] in known, f"missing network seed parent: {path}")
        known.add(path)
    service = json.loads((directory / "gxwid-service.reg").read_text())
    privileges = next(
        v["data"] for v in service["keys"][0]["values"] if v["name"] == "RequiredPrivileges"
    )
    require(
        {"SeImpersonatePrivilege", "SeAuditPrivilege"} <= set(privileges),
        "missing service privileges",
    )
    for name in ("gxwi-config.reg", "gxwi-live-notice.reg"):
        data = json.loads((directory / name).read_text())
        notice = next(
            v["data"]
            for k in data["keys"]
            if k["path"].endswith("\\Logon")
            for v in k["values"]
            if v["name"] == "Notice"
        )
        text = " ".join(notice)
        require(
            "SHA-256" in text and "/var/state/gxwi/certificate.sha256" in text,
            "missing certificate guidance",
        )
        require(
            ("live image account" in text) == (name == "gxwi-live-notice.reg"),
            "live account notice boundary changed",
        )
    event = (stage / "usr/share/evman/gxwid.evman").read_text()
    require("--- event gxwid.certificate.renewed" in event, "missing certificate event reference")
    app = tomllib.loads((stage / "usr/share/apps/dev.peios.gxwi.hello.toml").read_text())
    require(app["program"] == "/usr/bin/gxwi-hello-app", "wrong demonstration app program")
    require(
        xml.parse(stage / "usr/share/icons/base/dev.peios.gxwi.hello.svg")
        .getroot()
        .tag.endswith("}svg"),
        "invalid example icon",
    )
    require(
        (stage / LIBDIR / "libgxwi.so").readlink() == Path("libgxwi.so.1"), "wrong linker symlink"
    )
    require((stage / "usr/include/peios/gxwi.h").is_file(), "missing public C header")
    require(not (stage / "var").exists(), "package unexpectedly contains mutable state")


def validate(stage: Path, *, native: bool, sdk: Path) -> None:
    """Validate all artifacts without starting privileged services or desktop sessions."""
    require(sdk.is_dir(), "missing declared SDK")
    for binary in (*BINARIES, "libgxwi"):
        validate_elf(stage, binary, native=native)
    validate_data(stage)
