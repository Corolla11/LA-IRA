"""Build dist/artifact/: app/ as a multi-file publish (index.html without the document wrapper).

Usage: uv run tools/build_artifact.py (requires app/data from tools/prepare_data.py).
The claude.ai artifact adds its own <!doctype>/<head>/<body>, so only the body content of app/index.html
is published. All other files under app/ are copied unchanged. files.json maps each published path
(relative to app/) to its source path in the repo. Elevation stays base64 (elev.txt) because the
artifact does not serve .bin files."""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def strip_wrapper(html: bytes) -> bytes:
    """Return the bytes between the <body ...> tag (plus its line break) and the last </body>, with
    trailing whitespace replaced by one LF. Note: <title> and <link>/<style> placed in <head> must
    therefore live inside <body> in app/index.html (tests/test_artifact.py expects it to start with <title>)."""
    start = re.search(rb"<body[^>]*>\r?\n?", html, re.I).end()
    end = html.rindex(b"</body>")
    return html[start:end].rstrip() + b"\n"


def build(app: Path = ROOT / "app", out: Path = ROOT / "dist" / "artifact") -> dict:
    """Rebuild `out` from `app` (deleting `out` first); exit with a message if data files are missing.
    Returns the files.json mapping {published path: repo-relative source path}."""
    meta_path = app / "data" / "meta.json"
    if not meta_path.is_file():
        sys.exit("app/data/meta.json is missing")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("schema") != 1:
        sys.exit("app/data/meta.json must use schema 1")
    layers = meta.get("layers", {})
    data_files = ["elev.txt"]
    data_files.extend(layers[key] for key in ("image", "hillshade", "thermal", "traverse") if key in layers)
    data_files.extend(layers.get("crism", {}).values())
    missing = [f for f in data_files if not (app / "data" / f).is_file()]
    if missing:
        sys.exit(f"app/data is missing {', '.join(missing)}: run `uv run tools/prepare_data.py --out app/data` first")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    files = {}
    for p in sorted(app.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(app).as_posix()
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if rel == "index.html":
            dest.write_bytes(strip_wrapper(p.read_bytes()))
        else:
            shutil.copyfile(p, dest)
        files[rel] = p.relative_to(app.parent).as_posix()
    (out / "files.json").write_text(json.dumps(files, indent=2), encoding="utf-8")
    return files


if __name__ == "__main__":
    files = build()
    print(f"{len(files)} files in {ROOT / 'dist' / 'artifact'}", file=sys.stderr)
