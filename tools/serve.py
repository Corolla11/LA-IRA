"""Static server for the repo root on http://localhost:8765/ (forces .js to text/javascript) + sources API.

Usage: uv run tools/serve.py [PORT]   then open http://localhost:8765/app/
Needed because opening app/index.html from disk cannot fetch data files or load ES modules.
Serving the repo root (not app/) also lets tests/route.test.html reach ../app/js.

API (JSON):
    GET  /api/bodies                 -> [{"id","name"}]
    GET  /api/sources?body=<id>      -> {"body","checks":[{"id","label","required","ok","detail","prepared"}]}
    POST /api/prepare                -> {"body","layers":[ids],"overrides":{id:url}} -> {"ok","manifest","errors"}
"""
import functools
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import adapters  # noqa: E402

DATA_DIR = ROOT / "app" / "data"
SKIP_DETAIL = "format check skipped (assumed compatible)"


def list_bodies():
    ids = json.loads((adapters.BODIES_DIR / "index.json").read_text("utf-8"))
    return [{"id": i, "name": adapters.load_body(i)["name"]} for i in ids]


def body_ids():
    return [b["id"] for b in list_bodies()]


def sources_report(body_id):
    body = adapters.load_body(body_id)
    with ThreadPoolExecutor(max(1, len(body["sources"]))) as ex:
        checks = list(ex.map(lambda s: adapters.check_source(body, s), body["sources"]))
    for c in checks:
        c["prepared"] = (DATA_DIR / body_id / adapters.layer_file(c["id"])).is_file()
    return {"body": body_id, "checks": checks}


def prepare(body_id, layers, overrides):
    """Prepare selected layers that are missing or overridden. Returns (status, payload)."""
    body = adapters.load_body(body_id)
    layers, overrides = list(layers or []), dict(overrides or {})
    if "elevation" not in layers:
        return 400, {"ok": False, "errors": {"elevation": "elevation must be selected"}}
    out = DATA_DIR / body_id
    by_id = {s["id"]: s for s in body["sources"]}
    result, errors, used = {}, {}, {}
    for sid in adapters.SOURCE_IDS:
        if sid not in layers:
            result[sid] = False
            continue
        src = by_id.get(sid)
        if src is None:
            result[sid], errors[sid] = False, "source not defined for this body"
            continue
        url = overrides.get(sid) or None
        if url:
            used[sid] = url
        if not url and (out / adapters.layer_file(sid)).is_file():
            result[sid] = True
            continue
        try:
            adapters.prepare_source(body, src, out, url)
            result[sid] = True
        except Exception as e:
            result[sid], errors[sid] = False, str(e)[:300]
    manifest = adapters.write_manifest(out, body_id, result, {k: v for k, v in used.items() if result.get(k)})
    if not manifest["layers"]["elevation"]:
        return 400, {"ok": False, "manifest": manifest, "errors": errors}
    notes = {k: SKIP_DETAIL for k in manifest["overrides"]}  # similarity test is a stub that always passes
    return 200, {"ok": not errors, "manifest": manifest, "errors": errors, "notes": notes}


class Handler(SimpleHTTPRequestHandler):
    # Windows may map .js to text/plain via the registry, and browsers refuse ES modules with that type.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/bodies":
            return self.send_json(200, list_bodies())
        if u.path == "/api/sources":
            bid = (parse_qs(u.query).get("body") or [""])[0]
            if bid not in body_ids():
                return self.send_json(404, {"error": "unknown body"})
            return self.send_json(200, sources_report(bid))
        return super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != "/api/prepare":
            return self.send_json(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            bid = req["body"]
        except (ValueError, KeyError, TypeError):
            return self.send_json(400, {"error": "invalid request"})
        if bid not in body_ids():
            return self.send_json(404, {"error": "unknown body"})
        status, payload = prepare(bid, req.get("layers"), req.get("overrides"))
        self.send_json(status, payload)


def make_server(port=0):
    return ThreadingHTTPServer(("", port), functools.partial(Handler, directory=str(ROOT)))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Serving {ROOT} on http://localhost:{port}/")
    make_server(port).serve_forever()
