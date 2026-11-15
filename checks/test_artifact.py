import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from build_artifact import build


class ArtifactTest(unittest.TestCase):
    def test_topography_only_package_and_missing_declared_layer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = root / "app"
            data = app / "data"
            data.mkdir(parents=True)
            (app / "index.html").write_bytes(b"<body>\n<title>Test</title>\n</body>")
            (data / "elev.txt").write_text("AAAAAA==", encoding="ascii")
            meta = {"schema": 1}
            (data / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
            result = build(app, root / "out")
            self.assertIn("data/elev.txt", result)
            meta["layers"] = {"image": "missing.png"}
            (data / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "missing.png"):
                build(app, root / "out")


if __name__ == "__main__":
    unittest.main()
