"""Vercel function returning the latest RAD dose rate and where it was measured: /api/radiation?body=mars."""
import hashlib
import json

import requests

from tools.live import current_radiation
from tools.responses import ApiHandler


class handler(ApiHandler):
    def do_GET(self) -> None:
        try:
            radiation = current_radiation(self.query("body"))
        except LookupError as error:
            self.send_json(404, {"error": str(error)})
            return
        except (requests.RequestException, OSError, ValueError, RuntimeError) as error:
            self.send_json(502, {"error": "NASA radiation data is unavailable", "detail": str(error)[:160]})
            return
        data = json.dumps(radiation).encode("utf-8")
        self.send_hashed_bytes(data, "application/json", hashlib.sha256(data).hexdigest())
