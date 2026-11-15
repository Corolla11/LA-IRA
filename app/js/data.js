/*
 * data.js - loads every generated file from app/data/ into memory.
 *
 * Input : base URL of the data folder ('data/' for the app, '../app/data/' for tests).
 * Output: loadData(base) resolves to { meta, elev, trav, themis, crism }.
 * Used by: main.js (start) and tests/route.test.html. terrain.js turns the result into the grid.
 *
 * Files fetched from app/data (all produced by tools/prepare_data.py, never edited by hand):
 *  - meta.json     JSON object. Keys: N (grid side, 1000), latN/latS/lonW/lonE (bbox of the area, degrees),
 *                  themisSize (side in pixels of the THEMIS crop, ~30), crism {latN, latS, lonW, lonE}
 *                  (bbox of the CRISM crop, which is larger/offset from the area). Used to map cell <-> lat/lon.
 *  - elev.txt      Base64 text of N*N 32-bit floats (1000x1000 = 4,000,000 bytes), little-endian, row-major,
 *                  rows ordered north -> south and columns west -> east (index = row*N + col), in meters.
 *                  It is base64 (not .bin) because the claude.ai artifact cannot serve binary files.
 *                  Decoded here with atob() into a Uint8Array, then viewed as a Float32Array (no copy; this
 *                  relies on the browser being little-endian, which holds for every supported platform).
 *  - traverse.json JSON array of [sol, lat, lon]: Curiosity waypoints inside the area up to the reference sol.
 *  - themis.png    THEMIS night IR crop (grayscale PNG). Decoded to ImageData through a canvas (imageData()).
 *  - crism_hyd.png, crism_phy.png, crism_car.png, crism_tru.png
 *                  CRISM browse products (RGB composites; hyd = sulfates, phy = clays, car = carbonates,
 *                  tru = approximate true color). Also decoded to ImageData via canvas.
 *  - hirise.jpg, hillshade.jpg
 *                  NOT loaded here: map.js hands their URLs straight to Leaflet as image overlays over the
 *                  area bounds, so the browser fetches and draws them itself.
 */
// Resolves once the image has loaded (PNG files are same-origin, so the canvas is not tainted)
function loadImage(src) {
  return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = src; });
}
// Draws the image on an offscreen canvas and returns its RGBA pixels (Uint8ClampedArray, 4 bytes per pixel)
export function imageData(im) {
  var cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
  var cx = cv.getContext('2d'); cx.drawImage(im, 0, 0); return cx.getImageData(0, 0, cv.width, cv.height);
}

export async function loadData(base) {
  base = base || 'data/';
  // Sequential awaits keep the code simple; the files are local and small except elev.txt (~5.3 MB of base64)
  var meta = await (await fetch(base + 'meta.json')).json();
  var b64 = await (await fetch(base + 'elev.txt')).text(), bin = atob(b64.trim()), raw = new Uint8Array(bin.length);
  for (var bi = 0; bi < bin.length; bi++) raw[bi] = bin.charCodeAt(bi);
  var elev = new Float32Array(raw.buffer);   // N*N floats, meters; length must be N*N
  var trav = await (await fetch(base + 'traverse.json')).json();
  var themis = imageData(await loadImage(base + 'themis.png'));
  var crism = {}, keys = ['hyd', 'phy', 'car', 'tru'];
  for (var ki = 0; ki < keys.length; ki++) crism[keys[ki]] = imageData(await loadImage(base + 'crism_' + keys[ki] + '.png'));
  return { meta: meta, elev: elev, trav: trav, themis: themis, crism: crism };
}
