"""Vercel function returning the latest Curiosity waypoints inside the planner area."""
import hashlib
import json
from pathlib import Path
from typing import Any

import requests

from tools.traverse import format_traverse
from tools.responses import ApiHandler
from tools.traverse import latest_traverse

ROOT = Path(__file__).resolve().parent.parent


class handler(ApiHandler):
    def do_GET(self) -> None:
        if self.query("body") != "mars":
            self.send_json(404, {"error": "unknown or unsupported body"})
            return
        try:
            profile: Any = json.loads((ROOT / "app" / "bodies" / "mars.json").read_text(encoding="utf-8"))
            area = profile["area"]
            points = latest_traverse(area["lonW"], area["latS"], area["lonE"], area["latN"])
        except (requests.RequestException, KeyError, TypeError, ValueError) as error:
            self.send_json(502, {"error": "NASA traverse is unavailable", "detail": str(error)[:160]})
            return
        data = format_traverse(points)
        self.send_hashed_bytes(data, "application/json", hashlib.sha256(data).hexdigest())
