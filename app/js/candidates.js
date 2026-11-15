/*
 * candidates.js - suggested points of interest. DOM-free.
 *
 * Input : grid (terrain.js) and crism = { hyd, ... } ImageData from data.js.
 * Output: buildCandidates() -> ordered list [{ key, name, src, lat, lng }] used by the "+" button and the default route.
 * Used by: main.js and tests/route.test.html.
 */
import { RAD_POINT, HAB_PX } from './config.js';
import { cellOf, pxToLL } from './terrain.js';

// Points suggested by CRISM: local maxima of the sulfate signal (HYD), spaced ~200 m apart
export function crismCandidates(grid, crism, channel) {
  var id = crism.hyd, w = id.width, h = id.height, d = id.data, v = new Float32Array(w * h), out = [];
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var s = 0, n = 0;
    for (var b = -2; b <= 2; b++) for (var a = -2; a <= 2; a++) { var xx = x + a, yy = y + b; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; s += d[(yy * w + xx) * 4 + channel]; n++; }
    v[y * w + x] = s / n;
  }
  var idx = []; for (var q = 0; q < w * h; q++) idx.push(q);
  idx.sort(function (p, r) { return v[r] - v[p]; });
  var cb = grid.meta.crism;
  for (var k = 0; k < idx.length && out.length < 8; k++) {
    var qx = idx[k] % w, qy = (idx[k] / w) | 0;
    if (qx < 8 || qy < 8 || qx > w - 9 || qy > h - 9) continue;
    if (out.some(function (o) { return Math.hypot(o.x - qx, o.y - qy) < 12; })) continue;
    var lat = cb.latN - (qy + 0.5) / h * (cb.latN - cb.latS), lng = cb.lonW + (qx + 0.5) / w * (cb.lonE - cb.lonW);
    var c = cellOf(grid, lat, lng); if (c < 0 || grid.SLOPE[c] > 22) continue;
    out.push({ x: qx, y: qy, lat: lat, lng: lng, val: v[idx[k]] });
  }
  return out;
}

// Ordered list of suggested points: fixed targets, then the 8 strongest sulfate signals
// of each type, from nearest to farthest from the default habitat
export function buildCandidates(grid, crism) {
  var hab = pxToLL(grid, HAB_PX[0], HAB_PX[1]), cos = Math.cos(hab.lat * Math.PI / 180);
  function dist(p) { return Math.hypot((p.lat - hab.lat), (p.lng - hab.lng) * cos); }
  var CANDS = [
    Object.assign({ key: 'boxwork', name: 'Boxwork ridge network (north)', src: 'HiRISE' }, pxToLL(grid, 1960, 1711)),
    { key: 'msl4670', name: 'Curiosity point, sol 4670', src: 'Curiosity / RAD', lat: RAD_POINT.lat, lng: RAD_POINT.lng },
    Object.assign({ key: 'mesa', name: 'Edge of the pale mesa (layers)', src: 'HiRISE' }, pxToLL(grid, 1682, 2358))
  ];
  var cr = crismCandidates(grid, crism, 0).map(function (c) { return { kind: 'poly', c: c }; })
    .concat(crismCandidates(grid, crism, 1).map(function (c) { return { kind: 'mono', c: c }; }));
  cr.sort(function (a, b) { return dist(a.c) - dist(b.c); });
  var cnt = { poly: 0, mono: 0 }, seen = [];
  cr.forEach(function (o) {
    if (seen.some(function (s) { return dist({ lat: s.lat - o.c.lat + hab.lat, lng: s.lng - o.c.lng + hab.lng }) < 0.0025; })) return; // ~150 m
    seen.push(o.c); cnt[o.kind]++;
    CANDS.push({
      key: o.kind + cnt[o.kind], lat: o.c.lat, lng: o.c.lng,
      name: (o.kind === 'poly' ? 'Polyhydrated sulfate ' : 'Monohydrated sulfate ') + cnt[o.kind],
      src: o.kind === 'poly' ? 'CRISM SINDEX2' : 'CRISM BD2100'
    });
  });
  return CANDS;
}
