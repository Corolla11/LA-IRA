# Ares - Integrated route assistant
<img width="420" height="420" alt="logo" src="https://github.com/user-attachments/assets/7b92f441-1325-4500-ad66-0a714569ba3d" />

EVA (extravehicular walk) planning tool for an astronaut on Mars, built for the NASA Space Apps challenge. It covers a 2.46 x 2.46 km area around the Mount Sharp boxwork formations in Gale crater, explored by Curiosity in 2025.

## What it does

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

## Requirements

Python 3.12 and [uv](https://docs.astral.sh/uv/). No Node, no bundler.

## Run

```
uv sync
uv run tools/prepare_data.py --out app/data   # downloads and crops the NASA data
uv run tools/serve.py                         # http://localhost:8765/
```

Open http://localhost:8765/app/. Opening `index.html` from disk does not work (the app fetches data and ES modules). `tools/serve.py` is used instead of `python -m http.server` because Windows may serve `.js` as `text/plain`.

## Publish as an artifact

```
uv run tools/build_artifact.py
```

Writes `dist/artifact/` (`index.html` without the document wrapper, the other files, and `files.json`).

## How the data flows

```
NASA services ──► tools/prepare_data.py ──► app/data/ ──► app/js/data.js ──► terrain.js / route.js / candidates.js ──► map.js / ui.js
```

1. **Fetch** (`tools/prepare_data.py`, ~1 min, needs internet). Each step downloads one product for the map area (lat -4.8285 to -4.7873, lon 137.3593 to 137.4005):
   - **Elevation:** one `exportImage` call to the Mars Trek ImageServer `Gale_DEM_SMG_1m`, returning 1000 x 1000 raw little-endian float32 values (metres, bilinear resampling to ~2.46 m) followed by a 1-bit mask, which is dropped. The bbox in the URL is formatted exactly as the original PowerShell did (`ps_num()`), so the result is byte-identical.
   - **HiRISE:** 15 x 15 WMTS tiles at zoom 16, pasted into one 3840 x 3840 mosaic.
   - **Hillshade:** same ImageServer with the `Hillshade` raster function, 2000 x 2000.
   - **THEMIS night IR:** one zoom-9 tile, cropped to the 30 x 30 pixels over the area.
   - **CRISM:** the MTRDR label gives the projection; the four browse PNGs are cropped 1:1 (no resampling) to 137 x 137.
   - **Traverse:** Curiosity waypoints, kept only inside the map and up to sol 4670.
2. **Store** (`app/data/`): elevation is written as base64 text (`elev.txt`) because the claude.ai artifact cannot serve binary files; images stay PNG/JPEG; `meta.json` holds the bbox and CRISM geometry the app needs.
3. **Load** (`app/js/data.js`): decodes `elev.txt` back into a `Float32Array`, reads PNGs into pixel arrays through a canvas, and loads the JSON files.
4. **Model** (`terrain.js`, `route.js`, `candidates.js`, no DOM): slope (Horn), sand mask (30% coldest THEMIS), radiation (sky-view fraction), walking cost (Tobler), A* legs, Dijkstra return times and CRISM-based suggested stops.
5. **Show** (`map.js`, `ui.js`, `main.js`): Leaflet layers, route, timeline and tables.

Every source file has comments explaining its step in detail. Generated data (`app/data/`, `dist/`) is not versioned: run `tools/prepare_data.py` to create it.

## Data

| File | Source | Use |
|---|---|---|
| `hirise.jpg` | Mars Trek, `curiosity_hirise_mosaic`, zoom 16 (15 x 15 tiles) | Base map |
| `elev.txt` | Mars Trek ImageServer, `Gale_DEM_SMG_1m` (float32 in base64) | Elevation, slope, route, radiation |
| `hillshade.jpg` | Same DTM, Hillshade function | Shaded relief |
| `themis.png` | Mars Trek, `THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018`, zoom 9 | Night thermal and sand |
| `crism_*.png` | PDS Geosciences, CRISM MTRDR `FRT0000B6F1_07` (HYD, PHY, CAR, TRU browse) | Minerals and suggested points |
| `traverse.json` | `mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json` (inside the map, up to sol 4670) | Curiosity traverse |

The 6.55 uGy/h dose rate comes from Curiosity RAD (PDS PPI, `MSL-M-RAD-3-RDR-V1.0`, E dose of sols 4669 to 4673).

## Assumptions and limits

- Suit speed, slope limits (25 deg along the step, 20 deg sideways), sand factor, EVA duration (6 h), reserve (30%) and time per stop (20 min) are adjustable in the app.
- ~2.4 m cells: rocks and steps smaller than ~3 m do not appear.
- The radiation map is an estimate: the dose measured by RAD at one point, scaled by the sky fraction computed from the DTM.
- CRISM is 18 m/pixel and its alignment with HiRISE is approximate.
- THEMIS is ~100 m/pixel; sand classification is regional.

## Credits

Images and data: NASA/JPL-Caltech/University of Arizona (HiRISE), NASA/JPL-Caltech/JHUAPL (CRISM), NASA/JPL-Caltech/ASU (THEMIS), NASA/JPL-Caltech/SwRI (RAD), via NASA Mars Trek and NASA PDS. Map: [Leaflet](https://leafletjs.com) 1.9.4.
