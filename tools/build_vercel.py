"""Assemble the prepared static app for Vercel.

Usage: python tools/build_vercel.py [--out dist/vercel]
Packages are read from app/data/<body>/; prepare them first with tools/prepare_data.py.
"""
import argparse
import json
import shutil
from pathlib import Path
from typing import TypedDict, TypeGuard, cast

ROOT = Path(__file__).resolve().parent.parent

type LayerFile = str | list[str] | None


class DeploymentBody(TypedDict):
    id: str
    name: str
    layers: dict[str, bool]


class Deployment(TypedDict):
    mode: str
    bodies: list[DeploymentBody]


def _is_json_object(value: object) -> TypeGuard[dict[str, object]]:
    if not isinstance(value, dict):
        return False
    items = cast(dict[object, object], value)
    return all(isinstance(key, str) for key in items)


def _is_string_list(value: object) -> TypeGuard[list[str]]:
    if not isinstance(value, list):
        return False
    items = cast(list[object], value)
    return all(isinstance(item, str) for item in items)


def _read_json_object(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not _is_json_object(value):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _read_body_ids(path: Path) -> list[str]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not _is_string_list(value):
        raise ValueError(f"{path} must contain a JSON list of body IDs")
    return value


def _declared_file(data: Path, meta_path: Path, source: str, filename: object) -> str | None:
    if filename is None:
        return None
    if not isinstance(filename, str):
        raise TypeError(f"{meta_path} has an invalid filename for {source}")
    if not (data / filename).is_file():
        raise ValueError(f"{data} is missing {filename} declared for {source}")
    return filename


def _package_layers(data: Path) -> dict[str, bool]:
    meta_path = data / "meta.json"
    elevation_path = data / "elev.txt"
    if not meta_path.is_file() or not elevation_path.is_file():
        raise ValueError(f"{data} is missing meta.json or elev.txt")
    meta = _read_json_object(meta_path)
    if meta.get("schema") != 1:
        raise ValueError(f"{meta_path} must use schema 1")
    raw_layers = meta.get("layers", {})
    if not _is_json_object(raw_layers):
        raise ValueError(f"{meta_path} must contain a layers object")
    available = raw_layers
    layer_files: dict[str, LayerFile] = {
        "optical": _declared_file(data, meta_path, "optical", available.get("image")),
        "hillshade": _declared_file(data, meta_path, "hillshade", available.get("hillshade")),
        "thermal": _declared_file(data, meta_path, "thermal", available.get("thermal")),
        "traverse": _declared_file(data, meta_path, "traverse", available.get("traverse")),
    }
    crism = available.get("crism")
    if crism is not None:
        if not _is_json_object(crism) or set(crism) != {"hyd", "phy", "car", "tru"}:
            raise ValueError(f"{meta_path} must declare all four CRISM images")
        crism_files = [
            _declared_file(data, meta_path, f"CRISM {key}", crism[key])
            for key in ("hyd", "phy", "car", "tru")
        ]
        if any(filename is None for filename in crism_files):
            raise ValueError(f"{meta_path} must declare all four CRISM images")
        layer_files["minerals"] = [filename for filename in crism_files if filename is not None]
    else:
        layer_files["minerals"] = None
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
    body_ids = _read_body_ids(app / "bodies" / "index.json")
    packages: list[tuple[str, str, dict[str, bool], Path]] = []
    for body_id in body_ids:
        data = app / "data" / body_id
        if not data.exists():
            continue
        layers = _package_layers(data)
        if not layers["elevation"]:
            continue
        profile = _read_json_object(app / "bodies" / f"{body_id}.json")
        name = profile.get("name")
        if not isinstance(name, str):
            raise TypeError(f"app/bodies/{body_id}.json must define a body name")
        packages.append((body_id, name, layers, data))
    if not packages:
        raise ValueError("No complete body packages found; prepare at least one body first.")

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(app, out, ignore=shutil.ignore_patterns("data"))
    (out / "data").mkdir()
    for body_id, _, _, data in packages:
        shutil.copytree(data, out / "data" / body_id)
    deployment: Deployment = {
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
