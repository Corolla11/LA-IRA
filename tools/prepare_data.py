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
import math
import re
from concurrent.futures import ThreadPoolExecutor
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from urllib.parse import quote

import requests
from PIL import Image

N = 1000  # elevation grid is N x N cells (~2.4 m each over the 2.46 km area); also meta.json "N"
MAX_SOL = 4670  # reference sol; keep equal to tests/compare_data.py
# Mars Trek WMTS tile root (equirectangular, 256 px tiles): <layer>/1.0.0/default/default028mm/<z>/<row>/<col>.png
TILES = "https://trek.nasa.gov/tiles/Mars/EQ/"
# Curiosity waypoints (GeoJSON FeatureCollection; properties sol/lat/lon), grows with every sol
WAYPOINTS = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
THEMIS_TILE = (9, 269, 902)  # zoom, row, col
# 1 m Gale DTM (Mars Trek ArcGIS ImageServer); used for elevation (exportImage bsq F32) and hillshade
IMAGE_SERVER = "https://trek.nasa.gov/mars/trekarcgis/rest/services/Gale_DEM_SMG_1m/ImageServer"
# CRISM MTRDR browse products of observation FRT0000B6F1 (PDS Geosciences); suffixes: hydj_mtr3.lbl,
# {phy,hyd,car,tru}j_mtr3.png
CRISM_BASE = ("https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/"
              "browse/2008/2008_191/frt0000b6f1/frt0000b6f1_07_br")


def tile_origin():
    """(row0, col0) of the 15x15 zoom-16 tile block centred on tile 34518/115554."""
    return 34518 - 7, 115554 - 7


def bbox():
    """(lonW, latS, lonE, latN) of the map area.
    Tile grid: column = floor((lon+180)/360 * 2^(z+1)), row = floor((90-lat)/180 * 2^z); at z=16 one tile
    spans 180/2^16 degrees both ways, so the 15x15 block edges are exact binary fractions."""
    d16 = 180 / 2 ** 16
    row0, col0 = tile_origin()
    return (col0 * d16 - 180, 90 - (row0 + 15) * d16, (col0 + 15) * d16 - 180, 90 - row0 * d16)


def ps_num(v):
    """Format like Windows PowerShell 5.1: 15 significant digits, ties rounded away from zero
    (Python's '.15g' rounds ties to even: 137.4005126953125 -> ...312 instead of ...313)."""
    d = Decimal(v)
    q = Decimal(1).scaleb(d.adjusted() - 14)
    return format(d.quantize(q, rounding=ROUND_HALF_UP).normalize(), "f")


def bbox_str():
    """bbox as 'lonW,latS,lonE,latN' for the ImageServer 'bbox' parameter, via ps_num so the request
    URL (and therefore the returned elevation bytes) matches the original PowerShell pipeline."""
    return ",".join(ps_num(v) for v in bbox())


def themis_crop(lonW, lonE, latN):
    """(x0, y0, size) in pixels of THEMIS tile 9/269/902 covering the map bbox (expected 182, 158, 30).
    A zoom-9 tile spans 180/512 degrees over 256 px (px = degrees per pixel, ~0.00137 deg ~ 100 m).
    Offsets are measured from the tile's west edge (lon = tcol*180/512 - 180) and north edge
    (lat = 90 - trow*180/512); the crop is square, sized from the longitude span."""
    _, trow, tcol = THEMIS_TILE
    px = (180 / 512) / 256
    x0 = round((lonW + 180 - tcol * (180 / 512)) / px)
    y0 = round((90 - latN - trow * (180 / 512)) / px)
    return x0, y0, round((lonE - lonW) / px)


def crism_crop(lonW, lonE, latN, latS, res, cW, cN):
    """(x0, y0, w, h) of the CRISM browse crop (expected w = h = 137).
    The browse PNGs are equirectangular: res pixels per degree (3293.04), top-left corner at
    (cW = WESTERNMOST_LONGITUDE, cN = MAXIMUM_LATITUDE). Pixel = (lon - cW)*res, (cN - lat)*res.
    The crop is floor/ceil-rounded outwards so it fully covers the bbox; build_meta() then records the
    real (slightly larger) bounds of the crop so the app can place the overlay exactly."""
    x0 = math.floor((lonW - cW) * res)
    x1 = math.ceil((lonE - cW) * res)
    y0 = math.floor((cN - latN) * res)
    y1 = math.ceil((cN - latS) * res)
    return x0, y0, x1 - x0, y1 - y0


def fetch_crism_label():
    """Download the PDS label hydj_mtr3.lbl (same map projection for all four browse products) and
    parse three PDS3 keywords with a regex: MAP_RESOLUTION (px/deg), WESTERNMOST_LONGITUDE (deg E),
    MAXIMUM_LATITUDE (deg). Returns [res, cW, cN] as floats."""
    text = requests.get(CRISM_BASE + "hydj_mtr3.lbl", timeout=60).text
    return [float(re.search(n + r"\s*=\s*([-\d.]+)", text, re.I).group(1))
            for n in ("MAP_RESOLUTION", "WESTERNMOST_LONGITUDE", "MAXIMUM_LATITUDE")]


def build_meta(res, cW, cN):
    """Content of meta.json. Top level: lonW/lonE/latN/latS (map bbox, used by terrain.js and map.js for
    the grid and the HiRISE/hillshade/THEMIS overlays), N (grid size), themisSize (THEMIS crop side in px,
    used by terrain.js). "crism": product name, real crop bounds lonW/lonE/latN/latS and w/h in px
    (used by candidates.js and map.js to georeference the CRISM overlays)."""
    lonW, latS, lonE, latN = bbox()
    x0, y0, w, h = crism_crop(lonW, lonE, latN, latS, res, cW, cN)
    crism = {"product": "FRT0000B6F1_07 MTRDR", "lonW": cW + x0 / res, "lonE": cW + (x0 + w) / res,
             "latN": cN - y0 / res, "latS": cN - (y0 + h) / res, "w": w, "h": h}
    return {"lonW": lonW, "lonE": lonE, "latN": latN, "latS": latS, "N": N,
            "themisSize": themis_crop(lonW, lonE, latN)[2], "crism": crism}


def step_elev(out):
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


def step_meta(out):
    """meta.json: bbox + CRISM crop bounds (see build_meta). Needs the CRISM label (one HTTP request).
    Format: json.dumps(indent=2) + LF, UTF-8 without BOM. Consumer: app/js/data.js (loaded first), then
    terrain.js, map.js, candidates.js."""
    meta = build_meta(*fetch_crism_label())
    (out / "meta.json").write_bytes((json.dumps(meta, indent=2) + "\n").encode())


def get_image(url):
    """GET an image URL and open it with Pillow (raises on HTTP errors)."""
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content))


def step_hirise(out):
    """hirise.jpg: HiRISE image of the area.
    Source: Mars Trek WMTS layer curiosity_hirise_mosaic, zoom 16:
    {TILES}curiosity_hirise_mosaic/1.0.0/default/default028mm/16/<row>/<col>.png
    for the 15x15 tiles starting at tile_origin() (225 requests, 8 in parallel). Each 256x256 tile is
    pasted at (col*256, row*256) into a 3840x3840 canvas (transparent black where a tile has no data),
    flattened to RGB and saved as JPEG quality 78 (size vs. detail trade-off for publishing).
    Consumer: app/js/map.js, directly as L.imageOverlay('data/hirise.jpg') over the bbox."""
    row0, col0 = tile_origin()
    url = TILES + "curiosity_hirise_mosaic/1.0.0/default/default028mm/16/{}/{}.png"
    cells = [(r, c) for r in range(15) for c in range(15)]
    with ThreadPoolExecutor(8) as ex:
        tiles = list(ex.map(lambda rc: get_image(url.format(row0 + rc[0], col0 + rc[1])).convert("RGBA"), cells))
    big = Image.new("RGBA", (3840, 3840), (0, 0, 0, 0))
    for (r, c), t in zip(cells, tiles):
        big.paste(t, (c * 256, r * 256))
    big.convert("RGB").save(out / "hirise.jpg", quality=78)


def step_hillshade(out):
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


def step_themis(out):
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


def ps_6dec(v):
    """Like .NET ToString('0.######'): 6 decimals, no trailing zeros."""
    s = format(Decimal(ps_num(v)).quantize(Decimal("1e-6"), rounding=ROUND_HALF_UP), "f").rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def step_traverse(out):
    """traverse.json: Curiosity waypoints inside the map.
    Source: WAYPOINTS (MMGIS GeoJSON; each feature has properties sol, lat, lon). Features that are
    malformed are skipped. Kept: sol <= MAX_SOL (the live file keeps growing; 4670 is the reference sol,
    so the output is reproducible) and lat/lon inside the bbox. Sorted by sol (stable).
    Format: a single line "[[sol,lat,lon],...]\\n", sol rounded to an integer, lat/lon formatted by
    ps_6dec (at most 6 decimals, no trailing zeros), UTF-8 without BOM.
    Consumer: app/js/data.js (JSON.parse) -> map.js draws the traverse; ui.js derives the sol range."""
    lonW, latS, lonE, latN = bbox()
    feats = requests.get(WAYPOINTS, timeout=120).json()["features"]
    pts = []
    for p in (f.get("properties") or {} for f in feats):
        try:  # skip malformed features, as the .ps1 Where-Object did
            pts.append((round(float(p["sol"])), float(p["lat"]), float(p["lon"])))
        except (KeyError, TypeError, ValueError):
            continue
    pts = sorted((p for p in pts if p[0] <= MAX_SOL and latS <= p[1] <= latN and lonW <= p[2] <= lonE),
                 key=lambda p: p[0])
    text = "[" + ",".join(f"[{s},{ps_6dec(la)},{ps_6dec(lo)}]" for s, la, lo in pts) + "]\n"
    (out / "traverse.json").write_bytes(text.encode())


def step_crism(out):
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


def main():
    """CLI: --out DIR (Mars; created if missing), --only a,b (subset of STEPS, default all, run in order).
    --body ID prepares every source of app/bodies/<ID>.json into app/data/<ID>/ and writes manifest.json."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--body")
    ap.add_argument("--only", default=",".join(STEPS))
    a = ap.parse_args()
    if a.body:
        import adapters
        body = adapters.load_body(a.body)
        out = Path(a.out) if a.out else Path(__file__).resolve().parent.parent / "app" / "data" / a.body
        layers = {}
        for src in body["sources"]:
            try:
                adapters.prepare_source(body, src, out)
                layers[src["id"]] = True
                print(src["id"], "ok")
            except Exception as e:
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
