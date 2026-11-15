import json
import tempfile
import unittest
from pathlib import Path

from tools.build_vercel import build


class VercelBuildTest(unittest.TestCase):
    def test_build_includes_prepared_body_and_layer_availability(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = root / "app"
            body_data = app / "data" / "mars"
            body_data.mkdir(parents=True)
            (app / "bodies").mkdir()
            (app / "index.html").write_text("<html></html>", encoding="utf-8")
            (app / "bodies" / "index.json").write_text('["mars"]', encoding="utf-8")
            (app / "bodies" / "mars.json").write_text('{"name":"Mars"}', encoding="utf-8")
            (body_data / "elev.txt").write_text("AAAAAA==", encoding="ascii")
            (body_data / "map.jpg").write_bytes(b"image")
            meta = {"schema": 1, "layers": {"image": "map.jpg"}}
            (body_data / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

            out = root / "dist"
            self.assertEqual(build(app, out), ["mars"])
            deployment = json.loads((out / "deployment.json").read_text(encoding="utf-8"))
            self.assertEqual(deployment["mode"], "static")
            self.assertTrue(deployment["bodies"][0]["layers"]["elevation"])
            self.assertTrue(deployment["bodies"][0]["layers"]["optical"])
            self.assertFalse(deployment["bodies"][0]["layers"]["thermal"])
            self.assertTrue((out / "data" / "mars" / "elev.txt").is_file())
            self.assertTrue((out / "index.html").is_file())


if __name__ == "__main__":
    unittest.main()
