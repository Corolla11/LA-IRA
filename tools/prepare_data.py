"""Build the data package (elev.txt, meta.json, ...) from NASA services.
Usage: uv run tools/prepare_data.py --out DIR [--only elev,meta]

Overall flow:
    NASA services (Mars Trek, PDS Geosciences, MMGIS)
      -> tools/prepare_data.py (this file; one step_* function per output file)
      -> app/data/ (generated, gitignored, never edited by hand)
      -> app/js/data.js  (loadData(): fetches meta.json, elev.txt, traverse.json, themis.png, crism_*.png)
      -> app/js/terrain.js (grid, slope, THEMIS sand), route.js (A*), candidates.js (CRISM candidates)
      -> app/js/map.js / ui.js (Leaflet layers, panels)
    hirise.jpg and hillshade.jpg are not decoded by data.js: map.js uses them directly as
    L.imageOverlay('data/hirise.jpg' / 'data/hillshade.jpg').

Map area: 15x15 zoom-16 tiles centred on tile row 34518 / column 115554 (see bbox()),
i.e. lon 137.3593..137.4005, lat -4.8285..-4.7873 (about 2.46 x 2.46 km).

Output files (all written into --out):
    elev.txt      base64 text of 1000*1000 little-endian float32 metres (row-major, north row first)
    meta.json     bbox, grid size N, THEMIS crop size, CRISM crop bounds (indent=2, UTF-8, no BOM, LF)
    hirise.jpg    3840x3840 RGB JPEG q78
    hillshade.jpg 2000x2000 JPEG as rendered by the server
    themis.png    30x30 RGBA PNG
    crism_{phy,hyd,car,tru}.png  137x137 RGBA PNG each
    traverse.json one line: [[sol,lat,lon],...] sorted by sol
"""
import argparse
import base64
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import requests

if __package__ == "tools":
    from .geometry import bbox, bbox_str, crism_crop, ps_6dec, themis_crop, tile_origin
    from .traverse import latest_traverse
else:
    from geometry import bbox, bbox_str, crism_crop, ps_6dec, themis_crop, tile_origin
    from traverse import latest_traverse

from PIL import Image

N = 1000  # elevation grid is N x N cells (~2.4 m each over the 2.46 km area); also meta.json "N"
# Mars Trek WMTS tile root (equirectangular, 256 px tiles): <layer>/1.0.0/default/default028mm/<z>/<row>/<col>.png
TILES = "https://trek.nasa.gov/tiles/Mars/EQ/"
# 1 m Gale DTM (Mars Trek ArcGIS ImageServer); used for elevation (exportImage bsq F32) and hillshade
IMAGE_SERVER = "https://trek.nasa.gov/mars/trekarcgis/rest/services/Gale_DEM_SMG_1m/ImageServer"
# CRISM MTRDR browse products of observation FRT0000B6F1 (PDS Geosciences); suffixes: hydj_mtr3.lbl,
# {phy,hyd,car,tru}j_mtr3.png
CRISM_BASE = ("https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/"
              "browse/2008/2008_191/frt0000b6f1/frt0000b6f1_07_br")


def fetch_crism_label() -> list[float]:
    """Download the PDS label hydj_mtr3.lbl (same map projection for all four browse products) and
    parse three PDS3 keywords with a regex: MAP_RESOLUTION (px/deg), WESTERNMOST_LONGITUDE (deg E),
    MAXIMUM_LATITUDE (deg). Returns [res, cW, cN] as floats."""
    text = requests.get(CRISM_BASE + "hydj_mtr3.lbl", timeout=60).text
    values: list[float] = []
    for name in ("MAP_RESOLUTION", "WESTERNMOST_LONGITUDE", "MAXIMUM_LATITUDE"):
        match = re.search(name + r"\s*=\s*([-\d.]+)", text, re.IGNORECASE)
        if match is None:
            raise ValueError(f"CRISM label is missing {name}")
        values.append(float(match.group(1)))
    return values


def build_meta(res: float, cW: float, cN: float) -> dict[str, object]:
    """Content of meta.json. Top level: lonW/lonE/latN/latS (map bbox, used by terrain.js and map.js for
    the grid and the HiRISE/hillshade/THEMIS overlays), N (grid size), themisSize (THEMIS crop side in px,
    used by terrain.js). "crism": product name, real crop bounds lonW/lonE/latN/latS and w/h in px
    (used by candidates.js and map.js to georeference the CRISM overlays)."""
    lonW, latS, lonE, latN = bbox()
    x0, y0, w, h = crism_crop(lonW, lonE, latN, latS, res, cW, cN)
    crism: dict[str, str | float | int] = {
        "product": "FRT0000B6F1_07 MTRDR", "lonW": cW + x0 / res, "lonE": cW + (x0 + w) / res,
        "latN": cN - y0 / res, "latS": cN - (y0 + h) / res, "w": w, "h": h,
    }
    return {"schema": 1, "body": {"name": "Mars", "radius": 3396190}, "name": "Mount Sharp, Gale crater",
            "lonW": lonW, "lonE": lonE, "latN": latN, "latS": latS, "N": N,
            "themisSize": themis_crop(lonW, lonE, latN)[2], "crism": crism,
            "layers": {"image": "hirise.jpg", "hillshade": "hillshade.jpg", "thermal": "themis.png",
                       "traverse": "traverse.json", "crism": {k: f"crism_{k}.png" for k in ("phy", "hyd", "car", "tru")}},
            "radiation": {"rate": 6.55, "lat": -4.8082, "lng": 137.3811},
            "example": "gale"}


def step_elev(out: Path) -> None:
    """elev.txt: elevation of the bbox from the 1 m Gale DTM.
    Source: {IMAGE_SERVER}/exportImage with bbox=<bbox_str()>, bboxSR=104905 (Mars 2000 geographic),
    size=1000,1000, format=bsq, pixelType=F32, interpolation=RSP_BilinearInterpolation, f=image.
    Response (bsq): 1000*1000 little-endian float32 values (metres), followed by a 1-bit validity mask
    that is discarded (r.content[:N*N*4]). Output: those 4,000,000 bytes base64-encoded, 5,333,336
    ASCII characters, no newline. Base64 text because the claude.ai artifact does not serve .bin files.
    The bbox in the URL must be formatted with ps_num (15 significant digits, ties away from zero);
    any other formatting changes the request and the bytes returned are no longer identical.
    Consumer: app/js/data.js (atob -> Float32Array) -> terrain.js (grid, slope, route costs)."""
    url = (f"{IMAGE_SERVER}/exportImage?bbox={bbox_str()}&bboxSR=104905&size={N},{N}&format=bsq"
           "&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image")
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    (out / "elev.txt").write_bytes(base64.b64encode(r.content[:N * N * 4]))  # drop 1-bit mask


def step_meta(out: Path) -> None:
    """meta.json: bbox + CRISM crop bounds (see build_meta). Needs the CRISM label (one HTTP request).
    Format: json.dumps(indent=2) + LF, UTF-8 without BOM. Consumer: app/js/data.js (loaded first), then
    terrain.js, map.js, candidates.js."""
    res, cW, cN = fetch_crism_label()
    meta = build_meta(res, cW, cN)
    (out / "meta.json").write_bytes((json.dumps(meta, indent=2) + "\n").encode())


def get_image(url: str) -> Image.Image:
    """GET an image URL and open it with Pillow (raises on HTTP errors)."""
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content))


def step_hirise(out: Path) -> None:
    """hirise.jpg: HiRISE image of the area.
    Source: Mars Trek WMTS layer curiosity_hirise_mosaic, zoom 16:
    {TILES}curiosity_hirise_mosaic/1.0.0/default/default028mm/16/<row>/<col>.png
    for the 15x15 tiles starting at tile_origin() (225 requests, 8 in parallel). Each 256x256 tile is
    pasted at (col*256, row*256) into a 3840x3840 canvas (transparent black where a tile has no data),
    flattened to RGB and saved as JPEG quality 78 (size vs. detail trade-off for publishing).
    Consumer: app/js/map.js, directly as L.imageOverlay('data/hirise.jpg') over the bbox."""
    row0, col0 = tile_origin()
    url = TILES + "curiosity_hirise_mosaic/1.0.0/default/default028mm/16/{}/{}.png"
    cells: list[tuple[int, int]] = [(r, c) for r in range(15) for c in range(15)]
    def load_tile(rc: tuple[int, int]) -> Image.Image:
        return get_image(url.format(row0 + rc[0], col0 + rc[1])).convert("RGBA")

    with ThreadPoolExecutor(8) as ex:
        tiles = list(ex.map(load_tile, cells))
    big = Image.new("RGBA", (3840, 3840), (0, 0, 0, 0))
    for (r, c), t in zip(cells, tiles):
        big.paste(t, (c * 256, r * 256))
    big.convert("RGB").save(out / "hirise.jpg", quality=78)


def step_hillshade(out: Path) -> None:
    """hillshade.jpg: shaded relief rendered server-side from the same 1 m DTM.
    Source: {IMAGE_SERVER}/exportImage with bbox=<bbox_str()>, bboxSR=104905, size=2000,2000, format=jpg,
    f=image and renderingRule = URL-encoded JSON {"rasterFunction":"Hillshade","rasterFunctionArguments":
    {"Azimuth":315,"Altitude":45,"ZFactor":1}} (light from the NW, 45 deg elevation, no vertical exaggeration).
    The JPEG is stored byte-for-byte as returned. Consumer: app/js/map.js, as a semi-transparent
    L.imageOverlay('data/hillshade.jpg') over the bbox."""
    rule = quote('{"rasterFunction":"Hillshade","rasterFunctionArguments":{"Azimuth":315,"Altitude":45,"ZFactor":1}}', safe="")
    r = requests.get(f"{IMAGE_SERVER}/exportImage?bbox={bbox_str()}&bboxSR=104905&size=2000,2000&format=jpg&f=image"
                     f"&renderingRule={rule}", timeout=300)
    r.raise_for_status()
    (out / "hillshade.jpg").write_bytes(r.content)


def step_themis(out: Path) -> None:
    """themis.png: night-time infrared brightness (thermal inertia proxy) over the bbox.
    Source: Mars Trek WMTS layer THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018, single tile
    zoom 9, row 269, col 902 (256x256 px, ~100 m/px). Cropped to x 182..211, y 158..187 (30x30 px, see
    themis_crop) with Image.crop (exact copy, no resampling) and saved as RGBA PNG.
    Consumer: app/js/data.js (ImageData) -> terrain.js, which treats the coldest 30% of pixels as sand
    (cost x1.5); map.js also draws it as an overlay."""
    lonW, _, lonE, latN = bbox()
    x0, y0, w = themis_crop(lonW, lonE, latN)
    tile = get_image(TILES + "THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018/1.0.0/default/default028mm/9/269/902.png")
    tile.convert("RGBA").crop((x0, y0, x0 + w, y0 + w)).save(out / "themis.png")


def step_traverse(out: Path) -> None:
    """traverse.json: Curiosity waypoints inside the map.
    Source: NASA MMGIS waypoint GeoJSON; each feature has properties sol, lat, lon. Features that are
    malformed are skipped. All reported sols inside the bbox are kept, so newer waypoints are included.
    Sorted by sol (stable).
    Format: a single line "[[sol,lat,lon],...]\\n", sol rounded to an integer, lat/lon formatted by
    ps_6dec (at most 6 decimals, no trailing zeros), UTF-8 without BOM.
    Consumer: app/js/data.js (JSON.parse) -> map.js draws the traverse; ui.js derives the sol range."""
    lonW, latS, lonE, latN = bbox()
    pts = latest_traverse(lonW, latS, lonE, latN)
    text = "[" + ",".join(f"[{s},{ps_6dec(la)},{ps_6dec(lo)}]" for s, la, lo in pts) + "]\n"
    (out / "traverse.json").write_bytes(text.encode())


def step_crism(out: Path) -> None:
    """crism_{phy,hyd,car,tru}.png: CRISM MTRDR mineral browse products (phyllosilicates, hydrated
    minerals, carbonates, true colour) of observation FRT0000B6F1_07.
    Source: {CRISM_BASE}{phy|hyd|car|tru}j_mtr3.png (equirectangular) plus the label hydj_mtr3.lbl for
    the georeferencing (see fetch_crism_label / crism_crop). Each image is converted to RGBA and cropped
    with Image.crop (exact copy, no resampling) to the 137x137 box that covers the bbox; saved as PNG.
    If pixels ever differ from the reference, check first whether only alpha/transparent pixels differ.
    Consumer: app/js/data.js (ImageData per key) -> candidates.js (candidate sites from 'hyd'),
    map.js (renderCrism overlays, bounds from meta.json "crism")."""
    lonW, latS, lonE, latN = bbox()
    res, cW, cN = fetch_crism_label()
    x0, y0, w, h = crism_crop(lonW, lonE, latN, latS, res, cW, cN)
    for k in ("phy", "hyd", "car", "tru"):
        img = get_image(f"{CRISM_BASE}{k}j_mtr3.png").convert("RGBA")
        img.crop((x0, y0, x0 + w, y0 + h)).save(out / f"crism_{k}.png")


STEPS = {"elev": step_elev, "meta": step_meta, "hirise": step_hirise, "hillshade": step_hillshade,
         "themis": step_themis, "traverse": step_traverse, "crism": step_crism}


def main() -> None:
    """CLI: --out DIR (Mars; created if missing), --only a,b (subset of STEPS, default all, run in order).
    --body ID prepares every source of app/bodies/<ID>.json into app/data/<ID>/ and writes manifest.json
    and a schema 1 meta.json (see tools/adapters.py)."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--body")
    ap.add_argument("--only", default=",".join(STEPS))
    a = ap.parse_args()
    if a.body:
        import adapters
        body = adapters.load_body(a.body)
        out = Path(a.out) if a.out else Path(__file__).resolve().parent.parent / "app" / "data" / a.body
        layers: dict[str, bool] = {}
        for src in body["sources"]:
            try:
                adapters.prepare_source(body, src, out)
                layers[src["id"]] = True
                print(src["id"], "ok")
            except Exception as e:  # noqa: BLE001 - report this source and continue building other layers
                layers[src["id"]] = False
                print(src["id"], "FAILED:", e)
        adapters.write_manifest(out, body["id"], layers, {})
        return
    if not a.out:
        ap.error("--out or --body is required")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name in a.only.split(","):
        STEPS[name](out)
        print(name, "ok")


if __name__ == "__main__":
    main()
