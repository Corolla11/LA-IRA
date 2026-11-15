<div align="center">
  <img width="200" height="200" src="A-IRA.png" alt="A-IRA">
  <h1>LA-IRA
  <br>
  LunarAres - Integrated route assistant
  </h1>
</div>
EVA (extravehicular walk) planning tool for astronauts, built for the NASA Space Apps challenge. Two bodies are included: Mars (a 2.46 x 2.46 km area around the Mount Sharp boxwork formations in Gale crater, explored by Curiosity in 2025) and the Moon (the Apollo 17 landing site in the Taurus-Littrow valley, with only topography and optical imagery). Data sources are modular: on load the app checks every source and the user picks which layers feed the planner.

## What it does

- Startup screen: pick the body, see which data sources respond (OK / FAIL), choose the layers used by
  the planner and optionally paste your own source URL (ArcGIS ImageServer or WMTS). Topography is
  required; if it fails the planner cannot be opened. The URL "similarity" check is a placeholder that
  always passes for now.
- HiRISE map (~0.6 m/pixel) with toggleable layers:
  - slope from the HiRISE DTM (caution and blocked);
  - CRISM minerals (sulfates, clays, carbonates);
  - estimated radiation;
  - THEMIS night thermal;
  - return time to the habitat;
  - real Curiosity traverse.
- A* route over a 1000 x 1000 cell grid (~2.4 m), with walking-time cost:
  - speed from an adapted Tobler function;
  - slope limits along the step and sideways;
  - penalty on caution slopes and sand.
- Optimized visiting order between stops, with an A* cache so only new legs are recomputed.
- EVA timeline with editable time per stop, EVA duration and safety reserve.
- 1 to 6 points of interest, suggested from HiRISE, Curiosity and the strongest CRISM sulfate signals.
- Works offline once loaded (data and Leaflet are local).

Routing can use A*, Dijkstra or D* Lite. D* Lite currently starts a fresh
backward search for each leg; it does not yet reuse search state for dynamic
terrain updates. Dijkstra and D* Lite can take considerably longer than A*
on the full grid.

## Requirements

Python 3.12 and [uv](https://docs.astral.sh/uv/). No Node, no bundler.

## Run

```
uv sync
uv run tools/serve.py                         # http://localhost:8765/
```

The startup screen downloads and converts the selected sources on demand into `app/data/<body>/`.
To prepare a body from the command line instead: `uv run tools/prepare_data.py --body mars` (or `moon`).

Open http://localhost:8765/; it redirects to `/app/`. Opening `index.html` from disk does not work (the app fetches data and ES modules). `tools/serve.py` is used instead of `python -m http.server` because Windows may serve `.js` as `text/plain`.

## Bodies and data sources

Each body is described by `app/bodies/<id>.json` (listed in `app/bodies/index.json`): area bounds, grid
size `N`, radius, base walking speed `v0`, radiation reference (`doseRate`, `radPoint`), default habitat,
fixed suggested targets, texts, and its `sources`. A source has an id (`elevation` (required), `optical`,
`hillshade`, `thermal`, `minerals`, `traverse`), a label, an `adapter` and a `url`. Adapters live in
`tools/adapters.py`:

| Adapter | What it does |
|---|---|
| `imageserver-dem` | ArcGIS ImageServer `exportImage` as raw float32 -> `elev.txt` + `meta.json` |
| `imageserver-hillshade` | Same ImageServer with the `Hillshade` raster function -> `hillshade.jpg` |
| `wmts` | Stitches WMTS tiles over the area and crops them -> `hirise.jpg` |
| `mars:<step>` | Calls the existing Gale step of `tools/prepare_data.py` (Mars output stays byte-identical) |

`tools/serve.py` exposes `GET /api/bodies`, `GET /api/sources?body=<id>` (one live check per source) and
`POST /api/prepare` (`{"body", "layers", "overrides"}`), which writes `app/data/<id>/manifest.json` and a
schema 1 `meta.json` (below) that lists only the selected layers.

Moon (Apollo 17): topography `NAC_DTM_APOLLO17` (LROC NAC DTM, 5 m) and optical `A17_60x60km.eq`
(LROC NAC mosaic) from NASA Moon Trek. Radiation reference 5.1 µGy/h in silicon, derived from LRO CRaTER
in 50 km orbit (Mazur et al. 2011, Space Weather, doi:10.1029/2010SW000641): /0.7 to open space and x0.5
because the Moon blocks half the sky. `v0` = 2.0 km/h is an assumption; the Tobler walking function is an
Earth model, not calibrated for suited walking in low gravity. Lunar south-pole sites were not used: the
equirectangular polar DEMs on Moon Trek have gaps or are stretched near the pole.

## Bring your own terrain

The NASA downloader is specific to the Gale crater example; it is not a
generic planetary data downloader. To use another body, supply a prepared
package in `app/data/<body>/` (or add a body profile and let the adapters build it) containing:

- `meta.json`, with the schema below. `body.radius` is the spherical radius
  in metres; longitude and latitude are degrees in an equirectangular grid.
  The map cannot cross the antimeridian. The radius is used for distances.
- `elev.txt`, containing exactly `N * N` finite little-endian float32
  elevations in metres, encoded as base64. Rows go north to south, columns
  west to east. The grid must be square and have no missing cells.

For example:

```json
{
  "schema": 1,
  "name": "Example area",
  "body": {"name": "Moon", "radius": 1737400},
  "N": 100,
  "lonW": 10.0, "lonE": 10.1, "latS": 0.0, "latN": 0.1
}
```

With only elevation, the map uses a grayscale elevation image. Place the
habitat and stops on the map. Sand classification and radiation dose are
shown as unavailable, not zero. The walking model and limits remain user
assumptions, not validated predictions for the selected body.

Optional `layers` entries reference files relative to the package folder: `image`
and `hillshade` are images covering the grid bounds; `thermal` is a square
THEMIS-style night-thermal image and requires the `themisSize` pixel width.
Thermal classification is a regional heuristic, not a measured sand map.
`traverse` is a JSON array of `[sol, lat, lon]`. The optional `crism` object
must contain `hyd`, `phy`, `car`, and `tru` image filenames and requires
`crism` bounds (`lonW`, `lonE`, `latS`, `latN`) in the metadata. These
products and their legends are CRISM-specific, not a general spectral
interpreter. Do not supply unrelated spectral images under those names.

Optional `radiation` contains `rate` in µGy/h and reference `lat` and `lng`
inside the area. It enables the existing sky-view estimate; it is not a
general radiation model. This estimate currently requires `N` to be a
multiple of 250. More data does not automatically make the model more
accurate: input provenance, calibration, registration and model validity
must be checked for each body.

The old generated `meta.json` has no schema or body radius. Regenerate it
with `uv run tools/prepare_data.py --body mars` before using this version;
an existing package without schema 1 is rejected rather than silently
interpreted as Mars.

## Publish as an artifact

```
uv run tools/build_artifact.py
```

Writes `dist/artifact/` (`index.html` without the document wrapper, the other files, and `files.json`).

## Deploy to Vercel

The planner opens with the deployed package or the browser's IndexedDB copy. On opening, it checks
NASA in the background through the Python functions in `api/`; the status indicator shows when a
check is running. **Update data** starts a check or joins one already in progress. The browser
compares SHA-256 hashes, displays changes for review, and saves verified files when **Apply** is
selected. Unchanged files receive a bodyless HTTP 304 response.

| Endpoint | Returns |
| --- | --- |
| `/api/layer?body=mars&name=elevation` | 1000 x 1000 float32 DTM, raw little-endian (kept under Vercel's 4.5 MB response limit) |
| `/api/layer?body=mars&name=optical` | HiRISE mosaic (225 tile requests, ~20 s) |
| `/api/layer?body=mars&name=hillshade` / `thermal` / `minerals-hyd` (`phy`, `car`, `tru`) | hillshade, THEMIS crop, CRISM products |
| `/api/traverse?body=mars` | Curiosity waypoints inside the area, up to the latest sol |
| `/api/radiation?body=mars` | mean RAD E dose of the newest 5 sols and the position of Curiosity at that time |

The RAD products are ~70 MB per sol, so the function reads only the dose values with HTTP range
requests. Only Mars has a live radiation source; the Moon uses its packaged CRaTER-based reference.
If a check fails, the previously saved or deployed data remains in use and the error is
reported. Custom source URLs are unavailable in this deployment. The local development server
also checks in the background, subject to its existing 10-minute NASA-check cooldown.

Connect the repository to Vercel with the project root set to the repository root. `vercel.json`
selects the `Other` framework preset, configures the build output, and keeps the local development
server from being mistaken for a production Python entrypoint.

## How the data flows

```
NASA services ──► tools/prepare_data.py ──► app/data/ ──► app/js/data.js ──► terrain.js / route.js / candidates.js ──► map.js / ui.js
```

1. **Fetch** (`tools/prepare_data.py`, ~1 min, needs internet; shared geometry is in `tools/geometry.py`). Each step downloads one product for the map area (lat -4.8285 to -4.7873, lon 137.3593 to 137.4005):
   - **Elevation:** one `exportImage` call to the Mars Trek ImageServer `Gale_DEM_SMG_1m`, returning 1000 x 1000 raw little-endian float32 values (metres, bilinear resampling to ~2.46 m) followed by a 1-bit mask, which is dropped. The bbox in the URL is formatted exactly as the original PowerShell did (`ps_num()`), so the result is byte-identical.
   - **HiRISE:** 15 x 15 WMTS tiles at zoom 16, pasted into one 3840 x 3840 mosaic.
   - **Hillshade:** same ImageServer with the `Hillshade` raster function, 2000 x 2000.
   - **THEMIS night IR:** one zoom-9 tile, cropped to the 30 x 30 pixels over the area.
   - **CRISM:** the MTRDR label gives the projection; the four browse PNGs are cropped 1:1 (no resampling) to 137 x 137.
   - **Traverse:** Curiosity waypoints inside the map, including the latest sol available from NASA.
2. **Store** (`app/data/`): elevation is written as base64 text (`elev.txt`) because the claude.ai artifact cannot serve binary files; images stay PNG/JPEG; `meta.json` holds the bbox and CRISM geometry the app needs.
3. **Load** (`app/js/data.js`): decodes `elev.txt` back into a `Float32Array`, reads PNGs into pixel arrays through a canvas, and loads the JSON files.
4. **Model** (`terrain.js`, `route.js`, `candidates.js`, no DOM): slope (Horn), sand mask (30% coldest THEMIS), radiation (sky-view fraction), walking cost (Tobler), A* legs, Dijkstra return times and CRISM-based suggested stops.
5. **Show** (`map.js`, `ui.js`, `main.js`): Leaflet layers, route, timeline and tables.

Every source file has comments explaining its step in detail. Generated data (`app/data/`, `dist/`) is not versioned: run `tools/prepare_data.py` to create it.

The routing cost model is separated into `cost-model.js`; the reusable search
workspace is in `grid-workspace.js` and D* Lite is in `dstar-lite.js`.
`route.js` orchestrates leg searches, stop ordering and the timeline.

## Technical and mathematical model

The planner treats the elevation raster as an 8-connected grid. A 3 × 3 Horn
gradient estimates terrain slope at each cell:

```text
theta_deg = atan(sqrt(gx^2 + gy^2)) * 180 / pi
```

For a step with horizontal length `d` and elevation change `dz`, its along-track
grade is `s = dz / d`. The adapted Tobler model estimates speed in m/s:

```text
v(s) = (v0 / 3.6) * exp(-3.5 * abs(s + 0.05) + 0.175)
t_step = sqrt(d^2 + dz^2) / v(s)
```

Moves are rejected when terrain, along-track slope or cross-slope exceed their
limits. Above 15° local slope, travel time is multiplied by
`1 + 2 * (theta_deg - 15) / 10`; cells classified as sand receive the configured
sand multiplier. Carrying a load reduces base speed by 20% and tightens both
slope limits by 5°. These are planning assumptions, not suit-performance
measurements.

A* is the default leg search; Dijkstra and D* Lite are also available. A*
uses straight-line distance divided by the maximum Tobler speed as an
admissible heuristic. The planner tests visit orders for up to six reachable
stops and minimizes total travel time, then adds stop-work durations to the
timeline. A reverse-edge Dijkstra search computes return time from every cell
to the habitat. The reserve budget is
`EVA duration * (1 - reserve percentage / 100)`.

The radiation estimate scales the RAD reference rate by relative sky visibility:
`dose(cell) = RAD rate * SVF(cell) / SVF(reference)`. `SVF` averages
`1 / (1 + horizon_tangent^2)` over 16 directions, scanning up to 40 steps on a
coarser 250 × 250 elevation grid. Route dose is the sum of local dose rate
multiplied by time spent in each cell, including work stops. It is an estimate,
not a full radiation-transport model.

Focused checks: `node --experimental-default-type=module --test checks/routing.test.js`
and `python -m unittest discover -s checks -p test_artifact.py`.

## Data

| File | Source | Use |
|---|---|---|
| `hirise.jpg` | Mars Trek, `curiosity_hirise_mosaic`, zoom 16 (15 x 15 tiles) | Base map |
| `elev.txt` | Mars Trek ImageServer, `Gale_DEM_SMG_1m` (float32 in base64) | Elevation, slope, route, radiation |
| `hillshade.jpg` | Same DTM, Hillshade function | Shaded relief |
| `themis.png` | Mars Trek, `THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018`, zoom 9 | Night thermal and sand |
| `crism_*.png` | PDS Geosciences, CRISM MTRDR `FRT0000B6F1_07` (HYD, PHY, CAR, TRU browse) | Minerals and suggested points |
| `traverse.json` | `mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json` (inside the map; latest available sols) | Curiosity traverse |

The packaged 6.55 uGy/h dose rate comes from Curiosity RAD (PDS PPI, `MSL-M-RAD-3-RDR-V1.0`, E dose of sols 4669 to 4673). On Vercel the background check compares it with the newest value from `/api/radiation`; after an update is applied the saved value is used on subsequent openings.

## Measured vs assumed

| Measured (source data) | Derived by A-IRA | Assumed (editable) | Not modelled |
|---|---|---|---|
| NASA terrain and optical products (HiRISE DTM and mosaic, or LROC NAC on the Moon); THEMIS night IR; CRISM browse products; Curiosity waypoints; RAD dose observations | Slope from the DTM, a regional sand mask (coldest 30% of THEMIS pixels), sky-view dose estimate, walking-time costs, routes and return-time map | Base walking speed, slope limits (25° along the step and 20° sideways), sand penalty, 6-hour EVA, 30% reserve and 20 minutes per stop | Rocks and steps smaller than ~3 m, dust storms, solar particle events, oxygen use and position error |

“Measured” describes the source observation, not a direct measurement of every cell. For example, the radiation layer extrapolates a point measurement using terrain visibility, and the sand mask is a regional heuristic rather than a measured sand map. Source-card `OK` / `FAIL` indicators report availability; they do not certify a model output as measured.

## Known limitations

- The ~2.4 m grid cannot represent rocks and steps smaller than ~3 m.
- Tobler's function is an Earth hiking model, not calibrated for suited walking in 0.38 g.
- Radiation is RAD measured at one point scaled by sky visibility; it is an estimate, not a radiation map.
- CRISM is 18 m/pixel and its alignment with HiRISE is approximate; THEMIS is ~100 m/pixel.
- D* Lite restarts for each leg, and Dijkstra and D* Lite can be slow on the full grid.
- Custom-source similarity checking is a placeholder.

## Use of AI

- Claude was used for most of the coding.
- GitHub Copilot assisted with debugging, lint and loading issues, the Moon landing visualization, Vercel preparation and this documentation, based on the project's recent work history.
- The team remains responsible for the site, data sources, safety assumptions and final review.
- AI-generated media was used in the project submission.

## Credits

Images and data: NASA/JPL-Caltech/University of Arizona (HiRISE), NASA/JPL-Caltech/JHUAPL (CRISM), NASA/JPL-Caltech/ASU (THEMIS), NASA/JPL-Caltech/SwRI (RAD), via NASA Mars Trek and NASA PDS. Map: [Leaflet](https://leafletjs.com) 1.9.4.
Imagens e dados: NASA/JPL-Caltech/University of Arizona (HiRISE), NASA/JPL-Caltech/JHUAPL (CRISM), NASA/JPL-Caltech/ASU (THEMIS), NASA/JPL-Caltech/SwRI (RAD), via NASA Mars Trek e NASA PDS. Mapa: [Leaflet](https://leafletjs.com) 1.9.4.
