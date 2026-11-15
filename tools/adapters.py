"""Source adapters: check / download / convert one data source of a body profile into app/data/<body>/.

Profiles live in app/bodies/<id>.json (read by Python and JS). Adapter names:
    mars:<step>            calls prepare_data.STEPS[step] unchanged (keeps Mars bytes identical)
    imageserver-dem        ArcGIS ImageServer exportImage, bsq F32 -> elev.txt + meta.json
    imageserver-hillshade  ArcGIS ImageServer Hillshade rendering rule -> hillshade.jpg
    wmts                   equirectangular WMTS tiles stitched and cropped to the area -> hirise.jpg
"""
import base64
import io
import json
import math
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import prepare_data  # noqa: E402

BODIES_DIR = ROOT / "app" / "bodies"
SOURCE_IDS = ("elevation", "optical", "hillshade", "thermal", "minerals", "traverse")
LAYER_FILES = {"elevation": "elev.txt", "optical": "hirise.jpg", "hillshade": "hillshade.jpg",
               "thermal": "themis.png", "minerals": "crism_hyd.png", "traverse": "traverse.json"}
HILLSHADE_RULE = '{"rasterFunction":"Hillshade","rasterFunctionArguments":{"Azimuth":315,"Altitude":45,"ZFactor":1}}'


def load_body(body_id):
    """Read app/bodies/<id>.json."""
    return json.loads((BODIES_DIR / f"{body_id}.json").read_text("utf-8"))


def layer_file(source_id):
    """File whose presence in app/data/<body>/ means the layer is prepared."""
    return LAYER_FILES[source_id]


def tile_for(lat, lng, z):
    """(row, col) of the equirectangular tile covering lat/lng at zoom z."""
    return math.floor((90 - lat) / 180 * 2 ** z), math.floor((lng + 180) / 360 * 2 ** (z + 1))


def centre_tile(body, z):
    a = body["area"]
    return tile_for((a["latN"] + a["latS"]) / 2, (a["lonW"] + a["lonE"]) / 2, z)


def fill_url(body, src, url):
    """Fill {z}/{row}/{col} with the tile covering the area centre."""
    if "{" not in url:
        return url
    z = src.get("zoom", 15)
    row, col = centre_tile(body, z)
    return url.replace("{z}", str(z)).replace("{row}", str(row)).replace("{col}", str(col))


def check_source(body, src, url=None):
    """Health test: GET (15 s timeout), read 1 byte. Returns {id,label,required,ok,detail}."""
    res = {"id": src["id"], "label": src["label"], "required": bool(src.get("required")), "ok": False, "detail": ""}
    target = fill_url(body, src, url or src.get("check") or src["url"])
    try:
        req = urllib.request.Request(target, headers={"User-Agent": "ares-check"})
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read(1)
            res["ok"] = 200 <= r.status < 300
            res["detail"] = f"HTTP {r.status}"
    except Exception as e:  # network error, timeout or HTTP error status
        res["detail"] = str(e)[:160]
    return res


def _bbox(body):
    a = body["area"]
    return f"{a['lonW']},{a['latS']},{a['lonE']},{a['latN']}"


def _export(base, params):
    """exportImage GET; ArcGIS reports some errors as HTTP 200 JSON, so require a non-JSON body."""
    r = requests.get(f"{base.split('?')[0].rstrip('/')}/exportImage?{params}", timeout=300)
    r.raise_for_status()
    if r.content[:1] == b"{":
        raise RuntimeError("ImageServer error: " + r.content[:200].decode("utf-8", "replace"))
    return r.content


def _dem(body, src, out, url):
    n, a = body["N"], body["area"]
    data = _export(url or src["url"], f"bbox={_bbox(body)}&bboxSR={src['sr']}&size={n},{n}&format=bsq&pixelType=F32"
                   "&interpolation=RSP_BilinearInterpolation&f=image")
    if len(data) < n * n * 4:
        raise RuntimeError(f"DEM response too short: {len(data)} bytes")
    (out / "elev.txt").write_bytes(base64.b64encode(data[:n * n * 4]))  # drop 1-bit mask
    meta = {"lonW": a["lonW"], "lonE": a["lonE"], "latN": a["latN"], "latS": a["latS"], "N": n}
    (out / "meta.json").write_bytes((json.dumps(meta, indent=2) + "\n").encode())


def _hillshade(body, src, out, url):
    data = _export(url or src["url"], f"bbox={_bbox(body)}&bboxSR={src['sr']}&size=2000,2000&format=jpg&f=image"
                   f"&renderingRule={quote(HILLSHADE_RULE, safe='')}")
    Image.open(io.BytesIO(data)).verify()
    (out / "hillshade.jpg").write_bytes(data)


def _wmts(body, src, out, url):
    a, z = body["area"], src.get("zoom", 15)
    tpl = url or src["url"]
    scale = 256 * 2 ** z  # pixels spanning 180 degrees of latitude
    x0, x1 = (a["lonW"] + 180) / 360 * 2 * scale, (a["lonE"] + 180) / 360 * 2 * scale
    y0, y1 = (90 - a["latN"]) / 180 * scale, (90 - a["latS"]) / 180 * scale
    c0, c1, r0, r1 = int(x0 // 256), int(x1 // 256), int(y0 // 256), int(y1 // 256)
    cells = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]

    def get(rc):
        u = tpl.replace("{z}", str(z)).replace("{row}", str(rc[0])).replace("{col}", str(rc[1]))
        return prepare_data.get_image(u).convert("RGBA")

    with ThreadPoolExecutor(8) as ex:
        tiles = list(ex.map(get, cells))
    big = Image.new("RGBA", ((c1 - c0 + 1) * 256, (r1 - r0 + 1) * 256), (0, 0, 0, 0))
    for (r, c), t in zip(cells, tiles):
        big.paste(t, ((c - c0) * 256, (r - r0) * 256))
    box = tuple(round(v) for v in (x0 - c0 * 256, y0 - r0 * 256, x1 - c0 * 256, y1 - r0 * 256))
    big.crop(box).resize((3840, 3840), Image.LANCZOS).convert("RGB").save(out / "hirise.jpg", quality=78)


def prepare_source(body, src, out, url=None):
    """Download/convert one source into `out` (raises on failure). For `mars:*` adapters an override URL
    is ignored (the step functions are fixed to the Mars services)."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    ad = src["adapter"]
    if ad.startswith("mars:"):
        if not (out / "meta.json").is_file():
            prepare_data.STEPS["meta"](out)
        prepare_data.STEPS[ad.split(":", 1)[1]](out)
    elif ad == "imageserver-dem":
        _dem(body, src, out, url)
    elif ad == "imageserver-hillshade":
        _hillshade(body, src, out, url)
    elif ad == "wmts":
        _wmts(body, src, out, url)
    else:
        raise ValueError(f"unknown adapter {ad}")


def write_manifest(out, body_id, layers, overrides):
    """Write app/data/<body>/manifest.json with all 6 layer ids; returns the manifest."""
    manifest = {"body": body_id, "layers": {i: bool(layers.get(i)) for i in SOURCE_IDS},
                "overrides": dict(overrides or {})}
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps(manifest) + "\n", "utf-8")
    if (out / "meta.json").is_file():
        write_meta(out, load_body(body_id), manifest["layers"])
    return manifest


# Source id -> entry of meta.json "layers" (schema 1, read by app/js/data.js). elevation is always elev.txt.
META_LAYERS = {"optical": ("image", "hirise.jpg"), "hillshade": ("hillshade", "hillshade.jpg"),
               "thermal": ("thermal", "themis.png"), "traverse": ("traverse", "traverse.json"),
               "minerals": ("crism", {k: f"crism_{k}.png" for k in ("phy", "hyd", "car", "tru")})}


def write_meta(out, body, layers):
    """Rewrite app/data/<body>/meta.json as schema 1 (the package format of app/js/data.js): body name and
    radius, area name, radiation reference from the profile, and only the layers the user selected
    (layers[id] true). Area bounds, N, themisSize and crism bounds already in the file are kept."""
    out = Path(out)
    meta = json.loads((out / "meta.json").read_text("utf-8"))
    meta.update({"schema": 1, "name": body.get("subtitle", body["name"]).split(" · ")[0],
                 "body": {"name": body["name"].split(" · ")[0], "radius": body["radius_m"]},
                 "layers": {META_LAYERS[i][0]: META_LAYERS[i][1] for i in META_LAYERS if layers.get(i)}})
    if body.get("doseRate"):
        meta["radiation"] = {"rate": body["doseRate"], "lat": body["radPoint"]["lat"], "lng": body["radPoint"]["lng"]}
    else:
        meta.pop("radiation", None)
    if body["id"] == "mars":
        meta["example"] = "gale"
    (out / "meta.json").write_bytes((json.dumps(meta, indent=2) + "\n").encode())
    return meta
