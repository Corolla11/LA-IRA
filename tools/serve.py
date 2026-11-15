"""Static server for the repo root on http://localhost:8765/ (forces .js to text/javascript).

Usage: uv run tools/serve.py [PORT]   then open http://localhost:8765/app/
Needed because opening app/index.html from disk cannot fetch data files or load ES modules.
Serving the repo root (not app/) also lets tests/route.test.html reach ../app/js.
"""
import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
    # Windows may map .js to text/plain via the registry, and browsers refuse ES modules with that type.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Serving {ROOT} on http://localhost:{port}/")
    ThreadingHTTPServer(("", port), functools.partial(Handler, directory=str(ROOT))).serve_forever()