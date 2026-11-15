import io
import unittest

from tools.responses import ApiHandler


class CapturedResponse(ApiHandler):
    def __init__(self, path: str):
        self.path = path
        self.status = None
        self.headers: dict[str, str] = {}
        self.wfile = io.BytesIO()

    def send_response(self, status: int, message: str | None = None) -> None:
        self.status = status

    def send_header(self, name: str, value: str) -> None:
        self.headers[name] = value

    def end_headers(self) -> None:
        pass


class HashedResponseTests(unittest.TestCase):
    def test_matching_hash_returns_bodyless_not_modified_response(self):
        response = CapturedResponse("/api/layer?have=abc")
        response.send_hashed_bytes(b"data", "image/jpeg", "abc")

        self.assertEqual(response.status, 304)
        self.assertEqual(response.headers["X-Sha256"], "abc")
        self.assertNotIn("Content-Length", response.headers)
        self.assertEqual(response.wfile.getvalue(), b"")

    def test_changed_hash_returns_content_and_hash_header(self):
        response = CapturedResponse("/api/layer?have=old")
        response.send_hashed_bytes(b"data", "image/jpeg", "new")

        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["X-Sha256"], "new")
        self.assertEqual(response.wfile.getvalue(), b"data")


if __name__ == "__main__":
    unittest.main()
