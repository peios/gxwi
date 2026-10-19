"""Stage the Rust helper sources with resolved, auditable workspace metadata."""

import hashlib
import json
import shutil
import tomllib
from pathlib import Path
from typing import Any


def value(item: Any) -> str:
    """Render the simple TOML values present in the owned Cargo manifests."""
    if isinstance(item, dict):
        return "{ " + ", ".join(json.dumps(k) + " = " + value(v) for k, v in item.items()) + " }"
    return json.dumps(item)


def flatten(manifest: dict[str, Any], workspace: dict[str, Any]) -> str:
    """Resolve inherited package/dependency settings without changing dependency pins."""
    for key, item in list(manifest["package"].items()):
        if item == {"workspace": True}:
            manifest["package"][key] = workspace["package"][key]
    for table in ("dependencies", "dev-dependencies", "build-dependencies"):
        for key, item in list(manifest.get(table, {}).items()):
            if not isinstance(item, dict) or not item.get("workspace"):
                continue
            inherited = workspace["dependencies"][key]
            merged = {"version": inherited} if isinstance(inherited, str) else dict(inherited)
            extra = {k: v for k, v in item.items() if k != "workspace"}
            features = list(dict.fromkeys(merged.get("features", []) + extra.pop("features", [])))
            merged.update(extra)
            if features:
                merged["features"] = features
            manifest[table][key] = merged
    return "".join(
        "["
        + table
        + "]\n"
        + "".join(json.dumps(k) + " = " + value(v) + "\n" for k, v in fields.items())
        + "\n"
        for table, fields in manifest.items()
    )


def stage_sdk(sources: list[Path], output: Path) -> None:
    """Copy only declared owned source files; record actual content rather than a false Git pin."""
    workspace = tomllib.loads(Path("Cargo.toml").read_text())["workspace"]
    destination = output / "usr/share/cargo/gxwi"
    for name in ("gxwi", "gxwi-abi"):
        crate = destination / name
        for source in sources:
            if source.parts[0] != name or source.name == "BUILD.bazel":
                continue
            target = crate / source.relative_to(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o644)
        manifest_path = crate / "Cargo.toml"
        manifest = tomllib.loads(manifest_path.read_text())
        manifest_path.write_text(flatten(manifest, workspace))
        shutil.copyfile("LICENSE", crate / "LICENSE")
        files = {
            str(path.relative_to(crate)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(crate.rglob("*"))
            if path.is_file()
        }
        (crate / ".cargo-checksum.json").write_text(
            json.dumps({"files": files, "package": None}) + "\n"
        )
    (destination / "README").write_text(
        "GXWI Rust helper source. Link against the matching libgxwi.so.1 package.\n"
        "Cargo manifests preserve immutable external dependency pins.\n"
        "Each crate has a content checksum; this modified source has no claimed upstream Git identity.\n"
    )
