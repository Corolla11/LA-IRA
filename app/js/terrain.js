/*
 * terrain.js - turns the raw files from data.js into the routing/analysis grid. DOM-free.
 *
 * Input : raw = { meta, elev (Float32Array N*N), themis (ImageData | null) } from loadData(), and the body profile
 *         (radius_m, doseRate, radPoint).
 * Output: grid = { meta, N, RF, ELEV, SLOPE (deg), GX, GY (gradients, m/m), SAND (0/1), TV (THEMIS values),
 *                  dxm, dym, ddiag (cell sizes in m), DOSE (RM x RM), doseMin, doseMax, doseRate }.
 *         Without thermal data SAND is all 0 and TV is null.
 * Used by: main.js, candidates.js, route.js, map.js, ui.js. Also exports cell <-> lat/lon helpers.
 * Cell index c = row*N + col; row 0 is the north edge, col 0 the west edge.
 */
import { RM } from './config.js';

// lat/lon -> cell index (row*N + col), or -1 outside the area. The grid is linear in lat/lon.
export function cellOf(grid, lat, lng) {
  var META = grid.meta, N = grid.N;
  var i = Math.floor((lng - META.lonW) / (META.lonE - META.lonW) * N);
  var j = Math.floor((META.latN - lat) / (META.latN - META.latS) * N);
  if (i < 0 || j < 0 || i >= N || j >= N) return -1;
  return j * N + i;
}
// Cell index -> [lat, lon] of the cell center
export function llOf(grid, c) {
  var META = grid.meta, N = grid.N, i = c % N, j = (c / N) | 0;
  return [META.latN - (j + 0.5) * (META.latN - META.latS) / N, META.lonW + (i + 0.5) * (META.lonE - META.lonW) / N];
}
export function pxToLL(grid, X, Y) { // HiRISE mosaic pixel, 3840x3840
  var META = grid.meta;
  return { lat: META.latN - Y / 3840 * (META.latN - META.latS), lng: META.lonW + X / 3840 * (META.lonE - META.lonW) };
}
// Dose of a cell: the radiation grid is coarser (RM x RM), so index it with the reduction factor RF = N/RM
export function doseAt(grid, c) {
  if (c < 0) return grid.doseRate;
  var N = grid.N, RF = grid.RF, i = (c % N / RF) | 0, j = (((c / N) | 0) / RF) | 0;
  return grid.DOSE[j * RM + i];
}

// raw = { meta, elev (Float32Array), themis (ImageData | null) }, body = profile json
export function buildTerrain(raw, body) {
  var M_PER_DEG = Math.PI * body.radius_m / 180;
  var META = raw.meta, ELEV = raw.elev, N = META.N, RF = N / RM;
  var latC = (META.latN + META.latS) / 2 * Math.PI / 180;
  var dxm = (META.lonE - META.lonW) / N * M_PER_DEG * Math.cos(latC);
  var dym = (META.latN - META.latS) / N * M_PER_DEG;
  var ddiag = Math.hypot(dxm, dym);

  // Slope by Horn method (3x3 window, weights 1-2-1, edges clamped). GX/GY are kept because stepTime uses them
  // for the cross slope (slope perpendicular to the direction of travel).
  var SLOPE = new Float32Array(N * N), GX = new Float32Array(N * N), GY = new Float32Array(N * N);
  function z(i, j) { i = i < 0 ? 0 : i >= N ? N - 1 : i; j = j < 0 ? 0 : j >= N ? N - 1 : j; return ELEV[j * N + i]; }
  for (var j = 0; j < N; j++) {
    for (var i = 0; i < N; i++) {
      var a = z(i - 1, j - 1), b = z(i, j - 1), c = z(i + 1, j - 1), d = z(i - 1, j), f = z(i + 1, j), g = z(i - 1, j + 1), h = z(i, j + 1), k = z(i + 1, j + 1);
      var gx = ((c + 2 * f + k) - (a + 2 * d + g)) / (8 * dxm);   // per meter, eastward
      var gy = ((g + 2 * h + k) - (a + 2 * b + c)) / (8 * dym);   // per meter, southward
      var idx = j * N + i;
      GX[idx] = gx; GY[idx] = gy;
      SLOPE[idx] = Math.atan(Math.sqrt(gx * gx + gy * gy)) * 180 / Math.PI;
    }
  }

  // Thermal: night THEMIS (~30x30 px, ~100 m) resampled to the NxN grid with bilinear interpolation.
  // Cold at night = low thermal inertia = sand/dust, so sand = coldest 30%. The threshold is taken from a
  // sparse sample (every 97th cell) to avoid sorting a million values.
  var SAND = new Uint8Array(N * N), TV = null, q;
  if (raw.themis) {
  var S = META.themisSize, px = raw.themis.data; TV = new Float32Array(S * S);
  for (q = 0; q < S * S; q++) TV[q] = (px[q * 4] + px[q * 4 + 1] + px[q * 4 + 2]) / 3;
  var TH = new Float32Array(N * N);
  for (j = 0; j < N; j++) {
    var v = (j + 0.5) / N * S - 0.5; v = Math.max(0, Math.min(S - 1.001, v)); var v0 = Math.floor(v), fv = v - v0;
    for (i = 0; i < N; i++) {
      var u = (i + 0.5) / N * S - 0.5; u = Math.max(0, Math.min(S - 1.001, u)); var u0 = Math.floor(u), fu = u - u0;
      var t00 = TV[v0 * S + u0], t10 = TV[v0 * S + u0 + 1], t01 = TV[(v0 + 1) * S + u0], t11 = TV[(v0 + 1) * S + u0 + 1];
      TH[j * N + i] = (t00 * (1 - fu) + t10 * fu) * (1 - fv) + (t01 * (1 - fu) + t11 * fu) * fv;
    }
  }
  var sample = []; for (q = 0; q < N * N; q += 97) sample.push(TH[q]);
  sample.sort(function (x, y) { return x - y; });
  var thr = sample[Math.floor(sample.length * 0.3)];
  for (q = 0; q < N * N; q++) SAND[q] = TH[q] < thr ? 1 : 0;
  }

  var grid = { meta: META, N: N, RF: RF, ELEV: ELEV, SLOPE: SLOPE, GX: GX, GY: GY, SAND: SAND, TV: TV, dxm: dxm, dym: dym, ddiag: ddiag, doseRate: body.doseRate || 0 };
  var r = computeRadiation(grid, body.radPoint);
  grid.DOSE = r.DOSE; grid.doseMin = r.doseMin; grid.doseMax = r.doseMax;
  return grid;
}

// Estimated radiation: reference dose rate of the body (grid.doseRate, valid at radPoint) x visible sky fraction (relative to the measured point).
// Works on an RM x RM grid (block-averaged elevation) for speed: for each cell, scan 16 directions up to 40 steps
// and keep the steepest horizon tangent mt; the sky fraction in that direction is cos^2 of the horizon angle = 1/(1+mt^2).
function computeRadiation(grid, radPoint) {
  var N = grid.N, RF = grid.RF, ELEV = grid.ELEV, dxm = grid.dxm, dym = grid.dym;
  var Z = new Float32Array(RM * RM), I, J, a, b;
  for (J = 0; J < RM; J++) for (I = 0; I < RM; I++) {
    var s = 0; for (b = 0; b < RF; b++) for (a = 0; a < RF; a++) s += ELEV[(J * RF + b) * N + I * RF + a];
    Z[J * RM + I] = s / (RF * RF);
  }
  var csz = (dxm + dym) / 2 * RF, ND = 16, STEPS = 40, cs = [], sn = [];
  for (var dd = 0; dd < ND; dd++) { cs.push(Math.cos(dd * 2 * Math.PI / ND)); sn.push(Math.sin(dd * 2 * Math.PI / ND)); }
  var SVF = new Float32Array(RM * RM);
  for (J = 0; J < RM; J++) for (I = 0; I < RM; I++) {
    var z0 = Z[J * RM + I], acc = 0;
    for (dd = 0; dd < ND; dd++) {
      var mt = 0;
      for (var st = 1; st <= STEPS; st++) {
        var x = Math.round(I + cs[dd] * st), y = Math.round(J + sn[dd] * st);
        if (x < 0 || y < 0 || x >= RM || y >= RM) break;
        var t = (Z[y * RM + x] - z0) / (st * csz); if (t > mt) mt = t;
      }
      acc += 1 / (1 + mt * mt);   // cos² of the horizon angle
    }
    SVF[J * RM + I] = acc / ND;
  }
  var rc = cellOf(grid, radPoint.lat, radPoint.lng), ref = SVF[(((rc / N) | 0) / RF | 0) * RM + ((rc % N) / RF | 0)];
  var DOSE = new Float32Array(RM * RM), doseMin = Infinity, doseMax = -Infinity;
  for (var q = 0; q < RM * RM; q++) { DOSE[q] = grid.doseRate * SVF[q] / ref; if (DOSE[q] < doseMin) doseMin = DOSE[q]; if (DOSE[q] > doseMax) doseMax = DOSE[q]; }
  return { DOSE: DOSE, doseMin: doseMin, doseMax: doseMax };
}
