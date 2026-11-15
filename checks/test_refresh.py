"""Tests for status.json + serve.refresh with adapters.prepare_source monkeypatched (no network).
Run: uv run python -m unittest discover -s checks -p "test_refresh.py" -v"""
import hashlib
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from tools import adapters, serve

META = b'{"lonW": 1, "lonE": 2, "latN": 3, "latS": 4, "N": 5}'
LAYERS = ["elevation", "optical", "hillshade"]


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = (serve.DATA_DIR, adapters.prepare_source)
        serve.DATA_DIR = Path(self.tmp.name)
        self.content = {"elev.txt": b"elev", "hirise.jpg": b"hirise", "hillshade.jpg": b"shade"}
        self.calls, self.fail_sources, self.delay = [], set(), 0

        def fake(body, src, out, url=None):
            self.calls.append(src["id"])
            time.sleep(self.delay)
            if src["id"] in self.fail_sources:
                raise RuntimeError("nasa down")
            out = Path(out)
            out.mkdir(parents=True, exist_ok=True)
            f = adapters.layer_file(src["id"])
            (out / f).write_bytes(self.content[f])
            if src["id"] == "elevation":
                (out / "meta.json").write_bytes(META)

        adapters.prepare_source = fake
        self.assertEqual(serve.prepare("moon", LAYERS, {})[0], 200)
        self.calls.clear()
        self.out = serve.DATA_DIR / "moon"

    def tearDown(self):
        serve.DATA_DIR, adapters.prepare_source = self.saved
        self.tmp.cleanup()

    def status(self):
        return json.loads((self.out / "status.json").read_text("utf-8"))

    def test_status_hashes_package(self):
        s = self.status()
        self.assertEqual(set(s["files"]), {"elev.txt", "meta.json", "hirise.jpg", "hillshade.jpg"})
        self.assertEqual(s["files"]["hirise.jpg"]["sha256"], hashlib.sha256(b"hirise").hexdigest())
        self.assertEqual(s["files"]["elev.txt"]["size"], 4)
        self.assertEqual((s["body"], s["cooldownSeconds"], s["lastCheckAt"]), ("moon", 600, None))
        self.assertEqual(s["lastChangeAt"], max(f["changedAt"] for f in s["files"].values()))

    def test_refresh_no_change(self):
        before = self.status()
        code, d = serve.refresh("moon")
        self.assertEqual(code, 200)
        self.assertEqual((d["throttled"], d["changed"], d["errors"]), (False, [], {}))
        self.assertEqual(sorted(self.calls), sorted(LAYERS))
        for n, f in before["files"].items():
            self.assertEqual(d["status"]["files"][n], f)
        self.assertIsNotNone(d["status"]["lastCheckAt"])
        self.assertTrue(d["nextCheckAt"].endswith("Z"))

    def test_refresh_detects_change(self):
        self.content["hirise.jpg"] = b"new hirise"
        code, d = serve.refresh("moon")
        self.assertEqual(d["changed"], ["hirise.jpg"])
        self.assertEqual((self.out / "hirise.jpg").read_bytes(), b"new hirise")
        f = d["status"]["files"]["hirise.jpg"]
        self.assertEqual(f["changedAt"], d["status"]["lastChangeAt"])
        self.assertEqual(f["sha256"], hashlib.sha256(b"new hirise").hexdigest())

    def test_cooldown_skips_nasa(self):
        serve.refresh("moon")
        self.calls.clear()
        code, d = serve.refresh("moon")
        self.assertEqual((code, d["throttled"], d["changed"]), (200, True, []))
        self.assertEqual(self.calls, [])

    def test_concurrent_refresh_single_query(self):
        self.delay = 0.2
        res = []
        ts = [threading.Thread(target=lambda: res.append(serve.refresh("moon"))) for _ in range(2)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(sorted(self.calls), sorted(LAYERS))
        self.assertEqual(sorted(d["throttled"] for _, d in res), [False, True])

    def test_failed_layer_keeps_old_file(self):
        self.fail_sources = {"hillshade"}
        self.content["hirise.jpg"] = b"new hirise"
        code, d = serve.refresh("moon")
        self.assertEqual(code, 200)
        self.assertIn("hillshade", d["errors"])
        self.assertEqual(d["changed"], ["hirise.jpg"])
        self.assertEqual((self.out / "hillshade.jpg").read_bytes(), b"shade")
        self.assertIn("hillshade.jpg", d["status"]["files"])

    def test_unprepared_body_409(self):
        self.assertEqual(serve.refresh("mars")[0], 409)
        self.assertEqual(serve.refresh("venus")[0], 404)


if __name__ == "__main__":
    unittest.main()
