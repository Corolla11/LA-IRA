"""Vercel function serving a map layer fetched from NASA: /api/layer?body=mars&name=elevation."""
import requests

from tools.live import render_layer
from tools.responses import ApiHandler


class handler(ApiHandler):
    def do_GET(self) -> None:
        try:
            layer = render_layer(self.query("body"), self.query("name"))
        except LookupError as error:
            self.send_json(404, {"error": str(error)})
            return
        except (requests.RequestException, OSError, ValueError, RuntimeError) as error:
            self.send_json(502, {"error": "NASA layer is unavailable", "detail": str(error)[:160]})
            return
        self.send_bytes(200, layer.data, layer.content_type)
