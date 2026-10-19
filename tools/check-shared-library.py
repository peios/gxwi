#!/usr/bin/env python3
"""Verify the public ELF identity and exact C export set of libgxwi."""

import re
import subprocess
import sys
from pathlib import Path


def check(library: Path, exports: Path) -> None:
    """Reject unintended public symbols or a different installed ABI identity."""
    symbols = subprocess.check_output(
        ["nm", "-D", "--defined-only", "--format=posix", str(library)], text=True
    )
    actual = {line.split()[0] for line in symbols.splitlines() if line.strip()}
    expected = set(exports.read_text(encoding="utf-8").splitlines())
    if actual != expected:
        raise ValueError(
            f"C export mismatch: missing={expected - actual}, extra={actual - expected}"
        )
    dynamic = subprocess.check_output(["readelf", "-dW", str(library)], text=True)
    if "Library soname: [libgxwi.so.1]" not in dynamic:
        raise ValueError("libgxwi must carry SONAME libgxwi.so.1")
    dependencies = set(re.findall(r"Shared library: \[([^]]+)\]", dynamic))
    if "libpeios.so.0" not in dependencies:
        raise ValueError("libgxwi must use the Peios native API library")
    print(f"Verified {len(actual)} C exports and libgxwi.so.1 identity")


if __name__ == "__main__":
    check(Path(sys.argv[1]), Path("libgxwi/exports.txt"))
