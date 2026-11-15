"""Assemble the prepared static app for Vercel.

Usage: python tools/build_vercel.py [--out dist/vercel]
Packages are read from app/data/<body>/; prepare them first with tools/prepare_data.py.
"""
import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _package_layers(data: Path) -> dict[str, bool]:
    meta_path = data / "meta.json"
    elevation_path = data / "elev.txt"
    if not meta_path.is_file() or not elevation_path.is_file():
        raise ValueError(f"{data} is missing meta.json or elev.txt")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("schema") != 1:
        raise ValueError(f"{meta_path} must use schema 1")
    available = meta.get("layers", {})
    layer_files = {
        "optical": available.get("image"),
        "hillshade": available.get("hillshade"),
        "thermal": available.get("thermal"),
        "traverse": available.get("traverse"),
    }
    crism = available.get("crism")
    if crism:
        if not isinstance(crism, dict) or set(crism) != {"hyd", "phy", "car", "tru"}:
            raise ValueError(f"{meta_path} must declare all four CRISM images")
        layer_files["minerals"] = list(crism.values())
    else:
        layer_files["minerals"] = None
    for source, files in layer_files.items():
        if files is None:
            continue
        for filename in files if isinstance(files, list) else [files]:
            if not (data / filename).is_file():
                raise ValueError(f"{data} is missing {filename} declared for {source}")
    return {
        "elevation": True,
        "optical": bool(layer_files["optical"]),
        "hillshade": bool(layer_files["hillshade"]),
        "thermal": bool(layer_files["thermal"]),
        "minerals": bool(layer_files["minerals"]),
        "traverse": bool(layer_files["traverse"]),
    }


def build(app: Path = ROOT / "app", out: Path = ROOT / "dist" / "vercel") -> list[str]:
    """Copy the app and each complete prepared body package to the static output directory."""
    app, out = Path(app), Path(out)
    body_ids = json.loads((app / "bodies" / "index.json").read_text(encoding="utf-8"))
    packages = []
    for body_id in body_ids:
        data = app / "data" / body_id
        if not data.exists():
            continue
        layers = _package_layers(data)
        if not layers["elevation"]:
            continue
        profile = json.loads((app / "bodies" / f"{body_id}.json").read_text(encoding="utf-8"))
        packages.append((body_id, profile["name"], layers, data))
    if not packages:
        raise ValueError("No complete body packages found; prepare at least one body first.")

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(app, out, ignore=shutil.ignore_patterns("data"))
    (out / "data").mkdir()
    for body_id, _, _, data in packages:
        shutil.copytree(data, out / "data" / body_id)
    deployment = {
        "mode": "static",
        "bodies": [{"id": body_id, "name": name, "layers": layers}
                   for body_id, name, layers, _ in packages],
    }
    (out / "deployment.json").write_text(json.dumps(deployment, indent=2) + "\n", encoding="utf-8")
    return [body_id for body_id, _, _, _ in packages]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "vercel")
    args = parser.parse_args()
    bodies = build(out=args.out)
    print(f"Built {len(bodies)} body package(s) for Vercel: {', '.join(bodies)}")
