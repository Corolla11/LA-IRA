/*
 * map.js - Leaflet map and all overlays.
 *
 * Input : grid, traverse list, CRISM ImageData and route plans from main.js; layer checkboxes in index.html.
 * Output: Leaflet layers (hirise/hillshade as image overlays from data/*.jpg; slope, return time, radiation,
 *         THEMIS and CRISM drawn into canvases and shown as image overlays), route polylines and draggable pins.
 * Used by: main.js (initMap, toggleLayer, render*), ui.js (tok). Uses the global L (Leaflet, loaded in index.html).
 */
import { RM, CRISM_LEGEND } from './config.js';
import { llOf } from './terrain.js';

var $ = function (s) { return document.querySelector(s); };
export function tok(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

var map, bounds, crismBounds, layers = {}, markers = [];

// Puts a canvas on the map as an image (replaces the previous one, keeping the checkbox state)
function canvasOverlay(cv, key, toggle, opacity, bnds) {
  cv.toBlob(function (blob) {
    var url = URL.createObjectURL(blob);
    var vis = $(toggle).checked, old = layers[key];
    layers[key] = L.imageOverlay(url, bnds || bounds, { pane: 'ovl', opacity: opacity });
    if (old) { map.removeLayer(old); if (old._url) URL.revokeObjectURL(old._url); }
    if (vis) layers[key].addTo(map);
  });
}

function colorizeThemis(tv, S) {
  var stops = [[0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84], [0.75, 249, 142, 9], [1, 252, 255, 164]];
  var mn = Infinity, mx = -Infinity; tv.forEach(function (v) { mn = Math.min(mn, v); mx = Math.max(mx, v); });
  var cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  var cx = cv.getContext('2d'), img = cx.createImageData(S, S);
  for (var q = 0; q < S * S; q++) {
    var t = (tv[q] - mn) / (mx - mn || 1), k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    var f = (t - stops[k][0]) / (stops[k + 1][0] - stops[k][0]);
    for (var c = 0; c < 3; c++) img.data[q * 4 + c] = stops[k][c + 1] + (stops[k + 1][c + 1] - stops[k][c + 1]) * f;
    img.data[q * 4 + 3] = 255;
  }
  cx.putImageData(img, 0, 0); return cv;
}

// handlers = { onMove(latlng), onClick(latlng) }
export function initMap(grid, trav, crism, handlers) {
  var META = grid.meta;
  bounds = L.latLngBounds([META.latS, META.lonW], [META.latN, META.lonE]);
  if (META.crism) crismBounds = L.latLngBounds([META.crism.latS, META.crism.lonW], [META.crism.latN, META.crism.lonE]);
  map = L.map('map', { crs: L.CRS.EPSG4326, zoomSnap: 0.25, minZoom: 0, maxZoom: 20, maxBounds: bounds.pad(0.4), maxBoundsViscosity: 0.8 });
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution(META.example === 'gale' ? 'NASA/JPL-Caltech/UArizona/JHUAPL/ASU · NASA Mars Trek, PDS · Leaflet' : 'Leaflet');
  map.fitBounds(bounds);
  requestAnimationFrame(function () { map.invalidateSize(); map.fitBounds(bounds); });
  map.createPane('ovl').style.zIndex = 410;
  map.createPane('routes').style.zIndex = 450;

  var available = META.layers || {};
  if (available.image) layers.hirise = L.imageOverlay('data/' + available.image, bounds).addTo(map);
  else {
    var cv = document.createElement('canvas'); cv.width = grid.N; cv.height = grid.N;
    var cx = cv.getContext('2d'), pixels = cx.createImageData(grid.N, grid.N), min = Infinity, max = -Infinity;
    grid.ELEV.forEach(function (z) { min = Math.min(min, z); max = Math.max(max, z); });
    grid.ELEV.forEach(function (z, i) { var v = 40 + 190 * (z - min) / (max - min || 1); pixels.data[i * 4] = v; pixels.data[i * 4 + 1] = v; pixels.data[i * 4 + 2] = v; pixels.data[i * 4 + 3] = 255; });
    cx.putImageData(pixels, 0, 0);
    layers.hirise = L.imageOverlay(cv.toDataURL(), bounds).addTo(map);
  }
  if (available.hillshade) layers.hill = L.imageOverlay('data/' + available.hillshade, bounds, { opacity: 0.5, pane: 'ovl' });
  layers.slope = null; layers.ret = null; layers.crism = null; layers.rad = null; layers.themis = null;
  layers.route = L.layerGroup().addTo(map);

  if (grid.TV) canvasOverlay(colorizeThemis(grid.TV, META.themisSize), 'themis', '#lThemis', 0.65, bounds);
  if (grid.DOSE) renderRadiation(grid);
  if (crism.hyd) renderCrism(crism);
  [['#lHill', !!available.hillshade], ['#lThemis', !!grid.TV], ['#lRad', !!grid.DOSE], ['#lCrism', !!crism.hyd], ['#lTrav', !!available.traverse]]
    .forEach(function (pair) { $(pair[0]).disabled = !pair[1]; if (!pair[1]) $(pair[0]).checked = false; });
  $('#crismSel').disabled = !crism.hyd;
  $('#pSand').disabled = !grid.SAND;

  var tl = trav.map(function (p) { return [p[1], p[2]]; });
  layers.trav = L.layerGroup([
    L.polyline(tl, { pane: 'routes', color: tok('--traverse'), weight: 2.5, dashArray: '6 5', opacity: 0.95 })
  ].concat(trav.map(function (p) {
    return L.circleMarker([p[1], p[2]], { pane: 'routes', radius: 3, color: tok('--traverse'), weight: 1, fillOpacity: 0.9 })
      .bindTooltip((META.example === 'gale' ? 'Curiosity' : 'Traverse') + ' · sol ' + p[0], { direction: 'top' });
  }))).addTo(map);

  map.on('mousemove', function (e) { handlers.onMove(e.latlng); });
  map.on('click', function (e) { handlers.onClick(e.latlng); });
}

export function toggleLayer(key, on) {
  var l = layers[key]; if (!l) return;
  if (on) l.addTo(map); else map.removeLayer(l);
}
export function setCursor(c) { map.getContainer().style.cursor = c; }

export function renderSlope(grid, eff) {
  var N = grid.N, SLOPE = grid.SLOPE;
  var cv = document.createElement('canvas'); cv.width = N; cv.height = N;
  var cx = cv.getContext('2d'), img = cx.createImageData(N, N), d = img.data;
  var w = tok('--slope-warn').split(',').map(Number), b = tok('--slope-bad').split(',').map(Number);
  for (var q = 0; q < N * N; q++) {
    var s = SLOPE[q], o = q * 4;
    if (s > eff.maxSlope) { d[o] = b[0]; d[o + 1] = b[1]; d[o + 2] = b[2]; d[o + 3] = 175; }
    else if (s > 15) { d[o] = w[0]; d[o + 1] = w[1]; d[o + 2] = w[2]; d[o + 3] = 95; }
  }
  cx.putImageData(img, 0, 0);
  canvasOverlay(cv, 'slope', '#lSlope', 1);
}

export function renderReturn(grid, retMap) {
  if (!retMap) return;
  var N = grid.N;
  var cv = document.createElement('canvas'); cv.width = N; cv.height = N;
  var cx = cv.getContext('2d'), img = cx.createImageData(N, N), d = img.data;
  var c = tok('--ret').split(',').map(Number);
  for (var q = 0; q < N * N; q++) {
    var t = retMap.T[q] / 60, o = q * 4, a = 0;
    if (t <= 30) a = 110; else if (t <= 60) a = 70; else if (t <= 90) a = 35;
    if (a) { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = a; }
  }
  cx.putImageData(img, 0, 0);
  canvasOverlay(cv, 'ret', '#lRet', 1);
}

function renderRadiation(grid) {
  var DOSE = grid.DOSE, doseMin = grid.doseMin, doseMax = grid.doseMax;
  var cv = document.createElement('canvas'); cv.width = RM; cv.height = RM;
  var cx = cv.getContext('2d'), img = cx.createImageData(RM, RM), d = img.data;
  var lo = tok('--rad-low').split(',').map(Number), hi = tok('--rad-high').split(',').map(Number);
  var reference = grid.meta.radiation.rate;
  var span = Math.max(doseMax - reference, reference - doseMin) || 1;
  for (var q = 0; q < RM * RM; q++) {
    var t = (DOSE[q] - reference) / span, col = t < 0 ? lo : hi, a = Math.min(1, Math.abs(t)), o = q * 4;
    d[o] = 244 + (col[0] - 244) * a; d[o + 1] = 244 + (col[1] - 244) * a; d[o + 2] = 244 + (col[2] - 244) * a; d[o + 3] = 70 + 140 * a;
  }
  cx.putImageData(img, 0, 0);
  canvasOverlay(cv, 'rad', '#lRad', 0.85);
}

export function renderCrism(crism) {
  var k = $('#crismSel').value, src = crism[k], d = new Uint8ClampedArray(src.data);
  if (k !== 'tru') for (var q = 0; q < d.length; q += 4) { var m = Math.max(d[q], d[q + 1], d[q + 2]); d[q + 3] = Math.min(255, m * 2.2); }
  var cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  cv.getContext('2d').putImageData(new ImageData(d, src.width, src.height), 0, 0);
  canvasOverlay(cv, 'crism', '#lCrism', 0.85, crismBounds);
  $('#crismLegend').textContent = CRISM_LEGEND[k];
}

function smooth(lls) {
  if (lls.length < 7) return lls;
  var out = [lls[0]], w = 3;
  for (var q = 1; q < lls.length - 1; q++) {
    var a = Math.max(0, q - w), b = Math.min(lls.length - 1, q + w), sl = 0, sg = 0;
    for (var r = a; r <= b; r++) { sl += lls[r][0]; sg += lls[r][1]; }
    out.push([sl / (b - a + 1), sg / (b - a + 1)]);
  }
  out.push(lls[lls.length - 1]);
  return out;
}

function pinIcon(cls, label) {
  return L.divIcon({ className: '', html: '<div class="pin ' + cls + '">' + label + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
}

// onDrag(pi, latlng) is called when a marker is dropped over the area
export function renderRoute(grid, P, onDrag) {
  layers.route.clearLayers();
  markers.forEach(function (m) { map.removeLayer(m); }); markers = [];
  P.segs.forEach(function (sg) {
    if (!sg.res || !sg.res.path) return;
    var lls = smooth(sg.res.path.map(function (c) { return llOf(grid, c); }));
    L.polyline(lls, { pane: 'routes', color: tok('--route-casing'), weight: 7, opacity: 0.7 }).addTo(layers.route);
    L.polyline(lls, { pane: 'routes', color: tok('--route'), weight: 3.5, opacity: 1 }).addTo(layers.route);
  });
  var visit = {}; P.seq.slice(1, -1).forEach(function (pi, k) { visit[pi] = k + 1; });
  P.pts.forEach(function (pt, pi) {
    var unreachable = P.unreach.indexOf(pi) >= 0;
    var icon = pi === 0 ? pinIcon('h', 'H') : pinIcon(unreachable ? 'bad' : '', unreachable ? '!' : visit[pi]);
    var m = L.marker([pt.lat, pt.lng], { icon: icon, draggable: true, keyboard: true, title: pt.name }).addTo(map);
    m.bindTooltip(pt.name + (pt.src ? ' · ' + pt.src : ''), { direction: 'top', offset: [0, -12] });
    m.on('dragend', function (e) { onDrag(pi, e.target.getLatLng()); });
    markers.push(m);
  });
}
