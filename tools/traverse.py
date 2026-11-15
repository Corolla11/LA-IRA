"""Fetch and filter current rover waypoints for a geographic area."""
from typing import TypeGuard, cast

import requests

if __package__ == "tools":
    from .geometry import ps_6dec
else:
    from geometry import ps_6dec

WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"


def _is_json_object(value: object) -> TypeGuard[dict[str, object]]:
    if not isinstance(value, dict):
        return False
    entries = cast(dict[object, object], value)
    return all(isinstance(key, str) for key in entries)


def _is_object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise TypeError("waypoint coordinate is not numeric")
    return float(value)


def latest_traverse(lon_w: float, lat_s: float, lon_e: float, lat_n: float) -> list[list[int | float]]:
    response = requests.get(WAYPOINTS_URL, timeout=45)
    response.raise_for_status()
    payload: object = response.json()
    if not _is_json_object(payload):
        raise TypeError("NASA waypoint response must be a JSON object")
    raw_features = payload.get("features")
    if not _is_object_list(raw_features):
        raise TypeError("NASA waypoint response must contain a features array")
    points: list[tuple[int, float, float]] = []
    for raw_feature in raw_features:
        if not _is_json_object(raw_feature):
            continue
        properties = raw_feature.get("properties")
        if not _is_json_object(properties):
            continue
        try:
            points.append((
                round(_number(properties.get("sol"))),
                _number(properties.get("lat")),
                _number(properties.get("lon")),
            ))
        except (OverflowError, TypeError, ValueError):
            continue
    points = sorted(
        (point for point in points
         if lat_s <= point[1] <= lat_n and lon_w <= point[2] <= lon_e),
        key=lambda point: point[0],
    )
    return [[sol, lat, lon] for sol, lat, lon in points]


def format_traverse(points: list[list[int | float]]) -> bytes:
    """Serialize waypoints in the stable package format used for hash comparisons."""
    text = "[" + ",".join(f"[{sol},{ps_6dec(lat)},{ps_6dec(lon)}]" for sol, lat, lon in points) + "]\n"
    return text.encode()
