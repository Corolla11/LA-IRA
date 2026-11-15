"""Vercel function returning the latest Curiosity waypoints inside the planner area."""
import json
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import requests

from tools.traverse import latest_traverse

ROOT = Path(__file__).resolve().parent.parent


class handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        body_id = (parse_qs(urlparse(self.path).query).get("body") or [""])[0]
        if body_id != "mars":
            self.send_json(404, {"error": "unknown or unsupported body"})
            return
        try:
            profile: Any = json.loads((ROOT / "app" / "bodies" / "mars.json").read_text(encoding="utf-8"))
            area = profile["area"]
            points = latest_traverse(area["lonW"], area["latS"], area["lonE"], area["latN"])
        except (requests.RequestException, KeyError, TypeError, ValueError) as error:
            self.send_json(502, {"error": "NASA traverse is unavailable", "detail": str(error)[:160]})
            return
        self.send_json(200, points)
