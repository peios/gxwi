"""Exercise package policy checks against declared GXWI resources."""

import json
import tempfile
import unittest
from pathlib import Path

from stage import stage_data
from validate import validate_data


class PayloadTests(unittest.TestCase):
    """Reject missing resources and changed service authority before package publication."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        sources = []
        for pattern in (
            "docs/man/*",
            "docs/*.evman",
            "docs/*.regman",
            "registry.d/*.reg",
            "gxwi/examples/hello/*.toml",
            "gxwi/examples/hello/*.svg",
            "libgxwi/include/peios/*.h",
        ):
            sources.extend(Path(".").glob(pattern))
        stage_data(sources, self.root, "0.0.7")

    def test_declared_resources_pass(self) -> None:
        validate_data(self.root)

    def test_changed_service_privileges_are_rejected(self) -> None:
        path = self.root / "usr/share/regim/gxwid-service.reg"
        data = json.loads(path.read_text())
        for value in data["keys"][0]["values"]:
            if value["name"] == "RequiredPrivileges":
                value["data"] = []
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "changed seed"):
            validate_data(self.root)

    def test_missing_registry_seed_is_rejected(self) -> None:
        (self.root / "usr/share/regim/gxwi-network.reg").unlink()
        with self.assertRaisesRegex(ValueError, "incomplete registry"):
            validate_data(self.root)

    def test_mutable_state_is_not_packaged(self) -> None:
        (self.root / "var").mkdir()
        with self.assertRaisesRegex(ValueError, "mutable state"):
            validate_data(self.root)


if __name__ == "__main__":
    unittest.main()
