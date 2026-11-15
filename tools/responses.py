"""Shared response helpers for the Vercel functions in api/.

Every response is sent with `Cache-Control: no-store`: each request from the planner must reach NASA again."""
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

NO_STORE = "no-store"


class ApiHandler(BaseHTTPRequestHandler):
    def query(self, name: str) -> str:
        return (parse_qs(urlparse(self.path).query).get(name) or [""])[0]

    def send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", NO_STORE)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload: object) -> None:
        self.send_bytes(status, json.dumps(payload).encode("utf-8"), "application/json")
