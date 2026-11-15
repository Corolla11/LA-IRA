"""Static server for the repo root on http://localhost:8765/ (forces .js to text/javascript) + sources API.

Usage: uv run tools/serve.py [PORT]   then open http://localhost:8765/app/
Needed because opening app/index.html from disk cannot fetch data files or load ES modules.
Serving the repo root (not app/) also lets tests/route.test.html reach ../app/js.

API (JSON):
    GET  /api/bodies                 -> [{"id","name"}]
    GET  /api/sources?body=<id>      -> {"body","checks":[{"id","label","required","ok","detail","prepared"}]}
    POST /api/refresh                -> {"body"} -> {"throttled","status","changed","errors","nextCheckAt"}
    POST /api/prepare                -> {"body","layers":[ids],"overrides":{id:url}} -> {"ok","manifest","errors"}
"""
import calendar
import functools
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import BinaryIO, NotRequired, TypedDict, TypeGuard, cast
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from tools import adapters

DATA_DIR = ROOT / "app" / "data"
SKIP_DETAIL = "format check skipped (assumed compatible)"


class SourcesReport(TypedDict):
    body: str
    checks: list[adapters.SourceCheck]


class PrepareResponse(TypedDict):
    ok: bool
    errors: dict[str, str]
    manifest: NotRequired[adapters.Manifest]
    notes: NotRequired[dict[str, str]]


def _is_json_object(value: object) -> TypeGuard[dict[str, object]]:
    if not isinstance(value, dict):
        return False
    entries = cast(dict[object, object], value)
    return all(isinstance(key, str) for key in entries)


def _is_string_list(value: object) -> TypeGuard[list[str]]:
    if not isinstance(value, list):
        return False
    items = cast(list[object], value)
    return all(isinstance(item, str) for item in items)


def _is_string_mapping(value: object) -> TypeGuard[dict[str, str]]:
    if not isinstance(value, dict):
        return False
    entries = cast(dict[object, object], value)
    return all(isinstance(key, str) and isinstance(item, str) for key, item in entries.items())


def list_bodies() -> list[dict[str, str]]:
    ids_value: object = json.loads((adapters.BODIES_DIR / "index.json").read_text("utf-8"))
    if not _is_string_list(ids_value):
        raise ValueError("app/bodies/index.json must contain a list of body IDs")
    ids = ids_value
    return [{"id": i, "name": adapters.load_body(i)["name"]} for i in ids]


def body_ids() -> list[str]:
    return [b["id"] for b in list_bodies()]


def sources_report(body_id: str) -> SourcesReport:
    body = adapters.load_body(body_id)

    def check(source: adapters.Source) -> adapters.SourceCheck:
        return adapters.check_source(body, source)

    with ThreadPoolExecutor(max(1, len(body["sources"]))) as ex:
        checks = list(ex.map(check, body["sources"]))
    for c in checks:
        c["prepared"] = (DATA_DIR / body_id / adapters.layer_file(c["id"])).is_file()
    return {"body": body_id, "checks": checks}


def prepare(body_id: str, layers: list[str] | None, overrides: dict[str, str] | None) -> tuple[int, PrepareResponse]:
    """Prepare selected layers that are missing or overridden. Returns (status, payload)."""
    body = adapters.load_body(body_id)
    layers, overrides = list(layers or []), dict(overrides or {})
    if "elevation" not in layers:
        return 400, {"ok": False, "errors": {"elevation": "elevation must be selected"}}
    out = DATA_DIR / body_id
    by_id: dict[str, adapters.Source] = {s["id"]: s for s in body["sources"]}
    result: dict[str, bool] = {}
    errors: dict[str, str] = {}
    used: dict[str, str] = {}
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
        except Exception as e:  # noqa: BLE001 - report per-source failures while preparing other layers
            result[sid], errors[sid] = False, str(e)[:300]
    manifest = adapters.write_manifest(out, body_id, result, {k: v for k, v in used.items() if result.get(k)})
    if not manifest["layers"]["elevation"]:
        return 400, {"ok": False, "manifest": manifest, "errors": errors}
    adapters.write_status(out, body_id, checked=False)
    notes = {k: SKIP_DETAIL for k in manifest["overrides"]}  # similarity test is a stub that always passes
    return 200, {"ok": not errors, "manifest": manifest, "errors": errors, "notes": notes}


LOCKS: dict[str, threading.Lock] = {}


def refresh(body_id: str) -> tuple[int, dict[str, object]]:
    """Re-query NASA for the prepared layers (once per cooldown, one at a time per body) and replace changed
    files. Returns (status, payload)."""
    if body_id not in body_ids():
        return 404, {"error": "unknown body"}
    out = DATA_DIR / body_id
    if not (out / "manifest.json").is_file():
        return 409, {"error": "body not prepared"}
    with LOCKS.setdefault(body_id, threading.Lock()):  # a waiter finds lastCheckAt fresh -> throttled
        if not (out / "status.json").is_file():
            adapters.write_status(out, body_id, checked=False)
        status = json.loads((out / "status.json").read_text("utf-8"))
        last = status["lastCheckAt"] and calendar.timegm(time.strptime(status["lastCheckAt"], "%Y-%m-%dT%H:%M:%SZ"))
        if last and time.time() - last < status["cooldownSeconds"]:
            return 200, {"throttled": True, "status": status, "changed": [], "errors": {},
                         "nextCheckAt": adapters.utc_iso(last + status["cooldownSeconds"])}
        manifest = json.loads((out / "manifest.json").read_text("utf-8"))
        body = adapters.load_body(body_id)
        by_id, errors, changed = {s["id"]: s for s in body["sources"]}, {}, []
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for sid in adapters.SOURCE_IDS:
                if not manifest["layers"].get(sid):
                    continue
                try:
                    adapters.prepare_source(body, by_id[sid], tmp, manifest["overrides"].get(sid))
                except Exception as e:  # noqa: BLE001 - keep the previous file for a failed source
                    errors[sid] = str(e)[:300]
            adapters.write_manifest(tmp, body_id, manifest["layers"], manifest["overrides"])  # normalise meta.json
            for name in adapters.package_files(out):
                new = tmp / name
                if new.is_file() and (not (out / name).is_file() or new.read_bytes() != (out / name).read_bytes()):
                    shutil.copyfile(new, out / name)
                    changed.append(name)
        status = adapters.write_status(out, body_id, checked=True)
        last = calendar.timegm(time.strptime(status["lastCheckAt"], "%Y-%m-%dT%H:%M:%SZ"))
        return 200, {"throttled": False, "status": status, "changed": changed, "errors": errors,
                     "nextCheckAt": adapters.utc_iso(last + status["cooldownSeconds"])}


class Handler(SimpleHTTPRequestHandler):
    # Windows may map .js to text/plain via the registry, and browsers refuse ES modules with that type.

    def guess_type(self, path: str | os.PathLike[str]) -> str:
        if os.fspath(path).endswith(".js"):
            return "text/javascript"
        return super().guess_type(path)

    def send_json(self, status: int, payload: object) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        u = urlparse(self.path)
        if u.path == "/api/bodies":
            return self.send_json(200, list_bodies())
        if u.path == "/api/sources":
            bid = (parse_qs(u.query).get("body") or [""])[0]
            if bid not in body_ids():
                return self.send_json(404, {"error": "unknown body"})
            return self.send_json(200, sources_report(bid))
        return super().do_GET()

    def send_head(self) -> BytesIO | BinaryIO | None:
        # "/" redirects to the app, keeping the query string (GET and HEAD)
        url = urlparse(self.path)
        if url.path == "/":
            self.send_response(302)
            self.send_header("Location", "/app/" + ("?" + url.query if url.query else ""))
            self.end_headers()
            return None
        return super().send_head()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path not in ("/api/prepare", "/api/refresh"):
            return self.send_json(404, {"error": "not found"})
        try:
            req_value: object = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except (ValueError, KeyError, TypeError):
            return self.send_json(400, {"error": "invalid request"})
        if not _is_json_object(req_value):
            return self.send_json(400, {"error": "invalid request"})
        bid = req_value.get("body")
        raw_layers = req_value.get("layers")
        raw_overrides = req_value.get("overrides", {})
        if (
            not isinstance(bid, str)
            or (raw_layers is not None and not _is_string_list(raw_layers))
            or not _is_string_mapping(raw_overrides)
        ):
            return self.send_json(400, {"error": "invalid request"})
        if bid not in body_ids():
            return self.send_json(404, {"error": "unknown body"})
        if path == "/api/refresh":
            return self.send_json(*refresh(bid))
        status, payload = prepare(bid, raw_layers, raw_overrides)
        self.send_json(status, payload)


def make_server(port: int = 0) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("", port), functools.partial(Handler, directory=str(ROOT)))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Serving {ROOT} on http://localhost:{port}/")
    make_server(port).serve_forever()
