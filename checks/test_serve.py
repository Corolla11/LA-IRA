import functools
import http.client
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from tools.serve import Handler


class ServerTest(unittest.TestCase):
    def test_root_redirect_and_existing_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "app").mkdir()
            (root / "app" / "index.html").write_text("application", encoding="utf-8")
            (root / "sample.js").write_text("export {};", encoding="utf-8")
            server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=temp))
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                conn = http.client.HTTPConnection(*server.server_address)
                for method in ("GET", "HEAD"):
                    conn.request(method, "/?example=1")
                    response = conn.getresponse()
                    self.assertEqual(response.status, 302)
                    self.assertEqual(response.getheader("Location"), "/app/?example=1")
                    response.read()
                conn.request("GET", "/app/")
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b"application")
                conn.request("GET", "/sample.js")
                response = conn.getresponse()
                self.assertEqual(response.getheader("Content-Type"), "text/javascript")
                response.read()
                conn.close()
            finally:
                server.shutdown()
                thread.join()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
