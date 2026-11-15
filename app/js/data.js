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
  return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = function () { rej(new Error('Cannot load image ' + src)); }; im.src = src; });
}
// Draws the image on an offscreen canvas and returns its RGBA pixels (Uint8ClampedArray, 4 bytes per pixel)
export function imageData(im) {
  var cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
  var cx = cv.getContext('2d'); cx.drawImage(im, 0, 0); return cx.getImageData(0, 0, cv.width, cv.height);
}

export async function loadData(base, selectedLayers, liveBody) {
  base = base || 'data/';
  async function get(name) {
    var response = await fetch(base + name);
    if (!response.ok) throw new Error('Cannot load ' + name + ': HTTP ' + response.status);
    return response;
  }
  var meta = await (await get('meta.json')).json();
  if (meta.schema !== 1 || !meta.body || typeof meta.body.name !== 'string' ||
      !Number.isFinite(meta.body.radius) || meta.body.radius <= 0 ||
      !Number.isInteger(meta.N) || meta.N < 2 ||
      ![meta.lonW, meta.lonE, meta.latS, meta.latN].every(Number.isFinite) ||
      meta.lonW >= meta.lonE || meta.latS >= meta.latN ||
      meta.latS < -90 || meta.latN > 90 || meta.lonW < -180 || meta.lonE > 180) {
    throw new Error('Invalid metadata: schema 1, body radius, grid size and geographic bounds are required.');
  }
  if (selectedLayers) {
    var available = meta.layers || {}, selected = {};
    if (selectedLayers.optical && available.image) selected.image = available.image;
    if (selectedLayers.hillshade && available.hillshade) selected.hillshade = available.hillshade;
    if (selectedLayers.thermal && available.thermal) selected.thermal = available.thermal;
    if (selectedLayers.traverse && available.traverse) selected.traverse = available.traverse;
    if (selectedLayers.minerals && available.crism) selected.crism = available.crism;
    meta.layers = selected;
  }
  var b64 = await (await get('elev.txt')).text(), bin = atob(b64.trim()), raw = new Uint8Array(bin.length);
  if (bin.length !== meta.N * meta.N * 4) throw new Error('Elevation size does not match the grid.');
  for (var bi = 0; bi < bin.length; bi++) raw[bi] = bin.charCodeAt(bi);
  var view = new DataView(raw.buffer), elev = new Float32Array(meta.N * meta.N);
  for (bi = 0; bi < elev.length; bi++) {
    elev[bi] = view.getFloat32(bi * 4, true);
    if (!Number.isFinite(elev[bi])) throw new Error('Elevation contains missing or invalid values.');
  }
  var layers = meta.layers || {};
  if (layers.image) await loadImage(base + layers.image);
  if (layers.hillshade) await loadImage(base + layers.hillshade);
  var trav = [];
  if (layers.traverse) {
    if (liveBody) {
      var traverseResponse = await fetch('/api/traverse?body=' + encodeURIComponent(liveBody));
      if (!traverseResponse.ok) throw new Error('Cannot load current traverse: HTTP ' + traverseResponse.status);
      trav = await traverseResponse.json();
      if (!Array.isArray(trav)) throw new Error('Current traverse response is invalid.');
    } else trav = await (await get(layers.traverse)).json();
  }
  var themis = layers.thermal ? imageData(await loadImage(base + layers.thermal)) : null;
  if (themis && (themis.width !== meta.themisSize || themis.height !== meta.themisSize || meta.themisSize < 2)) {
    throw new Error('Thermal image dimensions do not match themisSize.');
  }
  var crism = {}, keys = Object.keys(layers.crism || {});
  if (keys.length && (!meta.crism ||
      ![meta.crism.lonW, meta.crism.lonE, meta.crism.latS, meta.crism.latN].every(Number.isFinite) ||
      meta.crism.lonW >= meta.crism.lonE || meta.crism.latS >= meta.crism.latN)) throw new Error('Valid CRISM bounds are required.');
  if (keys.length && !['hyd', 'phy', 'car', 'tru'].every(function (key) { return layers.crism[key]; })) {
    throw new Error('The CRISM layer requires hyd, phy, car and tru images.');
  }
  for (var ki = 0; ki < keys.length; ki++) crism[keys[ki]] = imageData(await loadImage(base + layers.crism[keys[ki]]));
  return { meta: meta, elev: elev, trav: trav, themis: themis, crism: crism };
}
