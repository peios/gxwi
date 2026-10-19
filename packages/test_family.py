"""Check the produced GXWI package boundaries and runtime authority metadata."""

import json
import tomllib
import unittest
from pathlib import Path
from typing import Any, ClassVar

NAMES = {
    "gxwi",
    "gxwi-debuginfo",
    "gxwi-debugsource",
    "gxwi-sdk",
    "gxwi-source",
    "libgxwi",
    "libgxwi-devel",
    "libgxwi-debuginfo",
}
BINARIES = {"usr/bin/" + name for name in ("gxwid", "gxwi-server", "gxwi-hello", "gxwi-hello-app")}
LIBRARY = "usr/lib/x86_64-linux-peios/libgxwi.so.1"


class FamilyTests(unittest.TestCase):
    """Inspect canonical manifests and provenance emitted by the actual package build."""

    index: ClassVar[dict[str, Any]]
    packages: ClassVar[dict[str, Any]]
    manifests: ClassVar[dict[str, Any]]

    @classmethod
    def setUpClass(cls) -> None:
        root = Path("packages.store")
        cls.index = json.loads((root / "index.json").read_text())
        cls.packages = {p["name"].removeprefix("dev.peios."): p for p in cls.index["packages"]}
        cls.manifests = {
            name: tomllib.loads((root / p["manifest"]).read_text())["files"]
            for name, p in cls.packages.items()
        }

    def test_complete_unsigned_family(self) -> None:
        self.assertEqual(set(self.packages), NAMES)
        self.assertEqual(self.index["package_count"], 8)
        self.assertEqual(len({p["version"] for p in self.packages.values()}), 1)
        self.assertFalse(self.index["release_ready"])
        self.assertEqual(self.index["trust"], "development")
        for item in self.packages.values():
            self.assertFalse(item["release_ready"])

    def test_runtime_and_shared_library_are_separate(self) -> None:
        for name, files in self.manifests.items():
            self.assertEqual(BINARIES & files.keys(), BINARIES if name == "gxwi" else set())
            self.assertEqual(LIBRARY in files, name == "libgxwi")
        self.assertIn("usr/include/peios/gxwi.h", self.manifests["libgxwi-devel"])
        self.assertIn("usr/lib/x86_64-linux-peios/libgxwi.so", self.manifests["libgxwi-devel"])
        self.assertIn(
            "usr/lib/x86_64-linux-peios/pkgconfig/gxwi.pc", self.manifests["libgxwi-devel"]
        )

    def test_service_authority_is_preserved(self) -> None:
        metadata = self.packages["gxwi"]["package_metadata"]
        self.assertEqual(metadata["side_effects"], ["man-db"])
        self.assertEqual(set(metadata["sd_overrides"]), {"usr/bin/gxwi-server"})
        self.assertEqual(
            metadata["sd_overrides"]["usr/bin/gxwi-server"],
            "O:SYG:SYD:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;WD)"
            "(A;;GRGX;;;S-1-15-3-165089264-3223449312-1247726440-2294222582-3667604814-1924088670-4213972040-4159405878)",
        )
        self.assertIn("dev.peios.authd", metadata["dependencies"])
        self.assertIn("dev.peios.peinit", metadata["dependencies"])
        self.assertEqual(
            metadata["dependencies"]["dev.peios.libgxwi"],
            "= " + self.packages["libgxwi"]["version"],
        )

    def test_references_and_debug_artifacts_are_complete(self) -> None:
        runtime = self.manifests["gxwi"]
        for path in (
            "usr/share/man/man8/gxwid.8.gz",
            "usr/share/man/man8/gxwi-server.8.gz",
            "usr/share/evman/gxwid.evman",
            "usr/share/regman/gxwi.regman",
            "usr/share/apps/dev.peios.gxwi.hello.toml",
        ):
            self.assertIn(path, runtime)
        self.assertIn("usr/share/man/man3/libgxwi.3.gz", self.manifests["libgxwi-devel"])
        for name, count in (("gxwi-debuginfo", 4), ("libgxwi-debuginfo", 1)):
            self.assertEqual(sum(path.endswith(".debug") for path in self.manifests[name]), count)

    def test_sdk_contains_both_crates_without_fictional_revision(self) -> None:
        sdk = self.manifests["gxwi-sdk"]
        for crate in ("gxwi", "gxwi-abi"):
            for path in ("Cargo.toml", "src/lib.rs", ".cargo-checksum.json"):
                self.assertIn(f"usr/share/cargo/gxwi/{crate}/{path}", sdk)
        self.assertNotIn("usr/share/cargo/gxwi/revision", sdk)

    def test_source_package_is_complete_without_build_caches(self) -> None:
        files = self.manifests["gxwi-source"]
        for path in (
            "Cargo.lock",
            "MODULE.bazel",
            "MODULE.bazel.lock",
            "BUILD.bazel",
            "bazel",
            "gxwid/src/main.rs",
            "gxwi-server/src/sw.js",
            "libgxwi/include/peios/gxwi.h",
            "gxwi/src/lib.rs",
            "gxwi/README.md",
            "gxwi-abi/src/lib.rs",
            "packages/sdk.py",
            "vendor/ppk/src/lib.rs",
            "docs/man/libgxwi.3",
            "dev/boot.sh",
        ):
            self.assertIn("usr/src/gxwi/" + path, files)
        forbidden = {".git", "target", "__pycache__", "bazel-out", ".trail-cache", "node_modules"}
        for path in files:
            self.assertFalse(forbidden & set(Path(path).parts), path)
            self.assertFalse(
                path.startswith("usr/src/gxwi/dev/browser/") and path.endswith(".png"), path
            )


if __name__ == "__main__":
    unittest.main()
