/*
 * data.js - loads every generated file from app/data/ into memory.
 *
 * Input : base URL of the data folder ('data/' for the app, '../app/data/' for tests); optional resolve(name) from cache.js.
 * Output: loadData(base, layers, liveBody, resolve) resolves to { meta, elev, trav, themis, crism, fallbacks }.
 *         With liveBody (a live deployment) each layer is requested from /api/layer, /api/traverse and /api/radiation
 *         every time the planner opens or is updated, and the packaged files below are the fallback (listed in
 *         `fallbacks`).
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
// N*N little-endian float32 values from raw bytes; validates the size and that every value is finite
function floatsFrom(buffer, N) {
  if (buffer.byteLength !== N * N * 4) throw new Error('Elevation size does not match the grid.');
  var view = new DataView(buffer), elev = new Float32Array(N * N);
  for (var i = 0; i < elev.length; i++) {
    elev[i] = view.getFloat32(i * 4, true);
    if (!Number.isFinite(elev[i])) throw new Error('Elevation contains missing or invalid values.');
  }
  return elev;
}

// resolve(name) -> url (cache.js object URLs); without it packaged files come from base + name
export async function loadData(base, selectedLayers, liveBody, resolve) {
  base = base || 'data/';
  var file = function (name) { return resolve ? resolve(name) : base + name; };
  async function get(name) {
    var response = await fetch(file(name));
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
  var layers = meta.layers || {};
  var crismKeys = Object.keys(layers.crism || {});
  if (crismKeys.length && (!meta.crism ||
      ![meta.crism.lonW, meta.crism.lonE, meta.crism.latS, meta.crism.latN].every(Number.isFinite) ||
      meta.crism.lonW >= meta.crism.lonE || meta.crism.latS >= meta.crism.latN)) throw new Error('Valid CRISM bounds are required.');
  if (crismKeys.length && !['hyd', 'phy', 'car', 'tru'].every(function (key) { return layers.crism[key]; })) {
    throw new Error('The CRISM layer requires hyd, phy, car and tru images.');
  }

  // In a live deployment every layer is requested from the NASA-backed functions each time the planner opens or is
  // updated; the snapshot packaged at deploy time is only the fallback, and each fallback is reported in `fallbacks`.
  var fallbacks = [], urls = {};
  // The timestamp makes each request unique, so neither the browser nor a CDN can answer from a stored copy.
  var stamp = Date.now();
  function endpoint(path) { return '/api/' + path + (path.indexOf('?') < 0 ? '?' : '&') + 't=' + stamp; }
  function layerUrl(name) { return endpoint('layer?body=' + encodeURIComponent(liveBody) + '&name=' + encodeURIComponent(name)); }
  async function fresh(label, live, snapshot) {
    if (!liveBody) return snapshot();
    try { return await live(); } catch (err) {
      console.warn('NASA ' + label + ' unavailable, using the deployed snapshot:', err);
      if (fallbacks.indexOf(label) < 0) fallbacks.push(label);
      return snapshot();
    }
  }
  async function fetchLive(path, kind) {
    var response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + path);
    return kind === 'buffer' ? response.arrayBuffer() : response.json();
  }
  // Resolves { url, image } from the NASA-backed function, or from the packaged file
  function picture(label, liveName, packaged) {
    return fresh(label, async function () {
      var url = layerUrl(liveName);
      return { url: url, image: await loadImage(url) };
    }, async function () {
      var url = file(packaged);
      return { url: url, image: await loadImage(url) };
    });
  }
  // Map overlays (HiRISE, hillshade) are not awaited: Leaflet loads them itself and map.js switches to the
  // packaged file if the NASA one fails, so the slow HiRISE mosaic never delays opening the planner.
  function overlay(liveName, packaged) {
    if (!liveBody) return loadImage(file(packaged)).then(function () { return { url: file(packaged) }; });
    return Promise.resolve({ url: layerUrl(liveName), snapshot: file(packaged) });
  }
  var jobs = {
    elev: fresh('elevation', async function () {
      return floatsFrom(await fetchLive(layerUrl('elevation'), 'buffer'), meta.N);
    }, async function () {
      var bin = atob((await (await get('elev.txt')).text()).trim()), raw = new Uint8Array(bin.length);
      for (var bi = 0; bi < bin.length; bi++) raw[bi] = bin.charCodeAt(bi);
      return floatsFrom(raw.buffer, meta.N);
    }),
    image: layers.image ? overlay('optical', layers.image) : null,
    hillshade: layers.hillshade ? overlay('hillshade', layers.hillshade) : null,
    thermal: layers.thermal ? picture('thermal', 'thermal', layers.thermal) : null,
    trav: layers.traverse ? fresh('traverse', async function () {
      var points = await fetchLive(endpoint('traverse?body=' + encodeURIComponent(liveBody)));
      if (!Array.isArray(points)) throw new Error('Current traverse response is invalid.');
      return points;
    }, async function () { return (await get(layers.traverse)).json(); }) : null,
    radiation: liveBody && meta.radiation ? fresh('radiation', async function () {
      var current = await fetchLive(endpoint('radiation?body=' + encodeURIComponent(liveBody)));
      if (![current.rate, current.lat, current.lng].every(Number.isFinite) || current.rate <= 0) {
        throw new Error('Current radiation response is invalid.');
      }
      return current;
    }, async function () { return null; }) : null,
    crism: Promise.all(crismKeys.map(function (key) { return picture('minerals', 'minerals-' + key, layers.crism[key]); }))
  };
  var loaded = await Promise.all([jobs.elev, jobs.image, jobs.hillshade, jobs.thermal, jobs.trav, jobs.radiation, jobs.crism]);
  var elev = loaded[0], image = loaded[1], hillshade = loaded[2], thermal = loaded[3], trav = loaded[4] || [];
  var radiation = loaded[5], crismPictures = loaded[6];
  if (image) urls.image = image;
  if (hillshade) urls.hillshade = hillshade;
  if (liveBody) meta.urls = urls;
  if (radiation) {
    meta.radiation = { rate: radiation.rate, lat: radiation.lat, lng: radiation.lng };
    meta.radiationLive = { sol: radiation.sol, firstSol: radiation.firstSol, lastSol: radiation.lastSol };
  }
  var themis = thermal ? imageData(thermal.image) : null;
  if (themis && (themis.width !== meta.themisSize || themis.height !== meta.themisSize || meta.themisSize < 2)) {
    throw new Error('Thermal image dimensions do not match themisSize.');
  }
  var crism = {};
  crismKeys.forEach(function (key, index) { crism[key] = imageData(crismPictures[index].image); });
  return { meta: meta, elev: elev, trav: trav, themis: themis, crism: crism, fallbacks: fallbacks };
}
