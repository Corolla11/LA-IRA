"""Render map layers and the current radiation reference from NASA services on demand."""
import base64
import io
import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NamedTuple, TypedDict

from tools import adapters
from tools.radiation import latest_dose
from tools.traverse import latest_traverse

# layer name -> (source id in the body profile, file written by the adapter, content type served)
LAYERS = {
    "elevation": ("elevation", "elev.txt", "application/octet-stream"),
    "optical": ("optical", "hirise.jpg", "image/jpeg"),
    "hillshade": ("hillshade", "hillshade.jpg", "image/jpeg"),
    "thermal": ("thermal", "themis.png", "image/png"),
}
MINERALS_PREFIX = "minerals-"


class Rendered(NamedTuple):
    data: bytes
    content_type: str


class CurrentRadiation(TypedDict):
    rate: float
    lat: float
    lng: float
    sol: int
    firstSol: int
    lastSol: int
    observations: int


def _profile(body_id: str) -> adapters.BodyProfile:
    known: object = json.loads((adapters.BODIES_DIR / "index.json").read_text("utf-8"))
    if not isinstance(known, list) or body_id not in known:
        raise LookupError("unknown body")
    return adapters.load_body(body_id)


def render_layer(body_id: str, name: str) -> Rendered:
    """Fetch the layer from its NASA source and return it ready to serve. Elevation is raw little-endian
    float32 (N x N, metres) instead of the base64 text of the packaged elev.txt, so it stays under the
    4.5 MB function response limit."""
    body = _profile(body_id)
    sources = {source["id"]: source for source in body["sources"]}
    if name.startswith(MINERALS_PREFIX):
        source = sources.get("minerals")
        if source is None or source["adapter"] != "mars:crism":
            raise LookupError("unknown layer")
        buffer = io.BytesIO()
        adapters.prepare_data.crism_image(name.removeprefix(MINERALS_PREFIX)).save(buffer, format="PNG")
        return Rendered(buffer.getvalue(), "image/png")
    layer = LAYERS.get(name)
    if layer is None or layer[0] not in sources:
        raise LookupError("unknown layer")
    source_id, filename, content_type = layer
    with tempfile.TemporaryDirectory() as temp:
        out = Path(temp)
        adapters.prepare_source(body, sources[source_id], out, with_meta=False)
        data = (out / filename).read_bytes()
    if name == "elevation":
        data = base64.b64decode(data)
    return Rendered(data, content_type)


def current_radiation(body_id: str) -> CurrentRadiation:
    """Latest RAD dose rate and the Curiosity position it was measured at (last in-area waypoint of that period)."""
    body = _profile(body_id)
    if body_id != "mars":
        raise LookupError("no live radiation source for this body")
    area = body["area"]
    with ThreadPoolExecutor(2) as pool:
        dose_job = pool.submit(latest_dose)
        traverse_job = pool.submit(latest_traverse, area["lonW"], area["latS"], area["lonE"], area["latN"])
        dose = dose_job.result()
        points = traverse_job.result()
    during = [point for point in points if dose["firstSol"] <= point[0] <= dose["lastSol"]]
    if not during:
        raise ValueError("Curiosity was outside the planner area during the latest RAD sols")
    sol, lat, lng = during[-1]
    return {
        "rate": dose["rate"], "lat": float(lat), "lng": float(lng), "sol": int(sol),
        "firstSol": dose["firstSol"], "lastSol": dose["lastSol"], "observations": dose["observations"],
    }
