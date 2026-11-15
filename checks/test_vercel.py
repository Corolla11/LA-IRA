import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from tools.build_vercel import Deployment, build


class VercelBuildTest(unittest.TestCase):
    def test_build_fails_when_a_registered_body_package_is_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = root / "app"
            body_data = app / "data" / "mars"
            body_data.mkdir(parents=True)
            (app / "bodies").mkdir()
            (app / "bodies" / "index.json").write_text('["mars","moon"]', encoding="utf-8")
            (app / "bodies" / "mars.json").write_text('{"name":"Mars"}', encoding="utf-8")
            (body_data / "elev.txt").write_text("AAAAAA==", encoding="ascii")
            (body_data / "meta.json").write_text(
                json.dumps({"schema": 1, "N": 1, "layers": {}}),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "prepare_data.py --body moon"):
                build(app, root / "dist")

    def test_vercel_build_prepares_every_registered_body(self):
        root = Path(__file__).resolve().parent.parent
        bodies = json.loads((root / "app" / "bodies" / "index.json").read_text(encoding="utf-8"))
        config = json.loads((root / "vercel.json").read_text(encoding="utf-8"))

        for body_id in bodies:
            with self.subTest(body=body_id):
                self.assertIn(
                    f"tools/prepare_data.py --body {body_id}",
                    config["buildCommand"],
                )

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
            meta: dict[str, object] = {"schema": 1, "N": 1, "layers": {"image": "map.jpg"}}
            (body_data / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

            out = root / "dist"
            self.assertEqual(build(app, out), ["mars"])
            deployment: Deployment = json.loads((out / "deployment.json").read_text(encoding="utf-8"))
            self.assertEqual(deployment["mode"], "live")
            self.assertTrue(deployment["bodies"][0]["layers"]["elevation"])
            self.assertTrue(deployment["bodies"][0]["layers"]["optical"])
            self.assertFalse(deployment["bodies"][0]["layers"]["thermal"])
            self.assertTrue((out / "data" / "mars" / "elev.txt").is_file())
            status = json.loads((out / "data" / "mars" / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(set(status["files"]), {"elev.txt", "meta.json", "map.jpg"})
            self.assertEqual(status["files"]["elev.txt"]["size"], 4)
            self.assertEqual(status["files"]["elev.txt"]["sha256"], hashlib.sha256(bytes(4)).hexdigest())
            self.assertTrue((out / "index.html").is_file())


if __name__ == "__main__":
    unittest.main()
