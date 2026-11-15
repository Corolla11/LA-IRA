/*
 * route.js - route planning on the terrain grid. DOM-free.
 *
 * Input : grid from terrain.js, points [habitat, ...stops] (lat/lng), params (state.p in main.js).
 * Output: planRoute() -> { pts, cells, seq, segs, eff, M, snapM, unreach, sig, runs*, expandedNew };
 *         returnMap() -> { T } return time in seconds from every cell to the habitat; schedule() -> timeline.
 * Used by: main.js (planRoute, returnMap, nextFrame), ui.js (schedule), tests/route.test.html.
 *
 * Model summary:
 *  - Step cost is TIME (s) between 8-connected cells: normalized Tobler speed on the 3D distance.
 *  - Cells above the max slope are blocked; steeper cross slope blocks a move; caution band and sand add penalties.
 *  - A* finds each leg; Dijkstra with reversed edges from the habitat gives return times to every cell.
 *  - Stop order is brute force over permutations (up to 6 stops); legs are cached by cell pair and limits.
 *  - Do not "clean up" Heap, astar or stepTime: A* tie-breaking depends on heap and neighbour order,
 *    and tests/golden.json relies on it.
 */
import { DI, DJ, TOBLER_MAX } from './config.js';
import { cellOf, doseAt } from './terrain.js';

export function nextFrame() { return new Promise(function (r) { setTimeout(r, 0); }); }

// ---------- Binary min-heap (cell index, key) ----------
export function Heap(cap) { this.idx = new Int32Array(cap); this.key = new Float64Array(cap); this.n = 0; }
Heap.prototype.push = function (i, k) {
  if (this.n >= this.idx.length) {
    var ni = new Int32Array(this.idx.length * 2); ni.set(this.idx); this.idx = ni;
    var nk = new Float64Array(this.key.length * 2); nk.set(this.key); this.key = nk;
  }
  var p = this.n++;
  while (p > 0) { var q = (p - 1) >> 1; if (this.key[q] <= k) break; this.idx[p] = this.idx[q]; this.key[p] = this.key[q]; p = q; }
  this.idx[p] = i; this.key[p] = k;
};
Heap.prototype.pop = function () {
  var top = this.idx[0], n = --this.n;
  if (n > 0) {
    var li = this.idx[n], lk = this.key[n], p = 0;
    for (;;) {
      var c = 2 * p + 1; if (c >= n) break;
      if (c + 1 < n && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= lk) break;
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c]; p = c;
    }
    this.idx[p] = li; this.key[p] = lk;
  }
  return top;
};

// Routing workspace, stored on the grid itself and reused by every A*/Dijkstra run (avoids reallocating ~1M-cell arrays).
// BLOCK = blocked cells, G = best cost so far, PAR = parent cell, CLOSED = finished cells.
function ensureWork(grid) {
  if (grid.BLOCK) return;
  var NN = grid.N * grid.N;
  grid.BLOCK = new Uint8Array(NN);
  grid.G = new Float64Array(NN); grid.PAR = new Int32Array(NN); grid.CLOSED = new Uint8Array(NN);
  grid.heap = new Heap(1 << 20);
}

// ---------- Cost model ----------
// Converts UI parameters to effective limits. Carrying equipment: limits -5 deg and speed x0.8.
// v is in m/s (UI is km/h, /3.6); tanMax/tanCross are tangents so steps compare slopes without trig.
export function effective(p) {
  var carry = p.carry;
  var maxS = p.maxSlope - (carry ? 5 : 0), maxC = p.maxCross - (carry ? 5 : 0);
  return {
    v: p.v0 * (carry ? 0.8 : 1) / 3.6, maxSlope: maxS,
    tanMax: Math.tan(maxS * Math.PI / 180), tanCross: Math.tan(maxC * Math.PI / 180), sand: p.sand
  };
}
export function computeBlock(grid, eff) {
  ensureWork(grid);
  var N = grid.N, SLOPE = grid.SLOPE, BLOCK = grid.BLOCK;
  for (var q = 0; q < N * N; q++) BLOCK[q] = SLOPE[q] > eff.maxSlope ? 1 : 0;
}

// Time (s) to go from cell u to neighbor v, in direction k (index into DI/DJ). Infinity = not allowed.
// Checks, in order: blocked cell (slope > limit), step slope > limit, cross slope > limit; then the cost is
// 3D distance / Tobler speed, x(1+2(theta-15)/10) for slopes 15 deg..limit, x sand factor on sand.
export function stepTime(grid, u, v, k, eff) {
  var BLOCK = grid.BLOCK, ELEV = grid.ELEV, GX = grid.GX, GY = grid.GY, SLOPE = grid.SLOPE, SAND = grid.SAND;
  var dxm = grid.dxm, dym = grid.dym, ddiag = grid.ddiag;
  if (BLOCK[v]) return Infinity;
  var di = DI[k], dj = DJ[k];
  var dh = (di !== 0 && dj !== 0) ? ddiag : (di !== 0 ? dxm : dym);
  var dz = ELEV[v] - ELEV[u], s = dz / dh;
  if (Math.abs(s) > eff.tanMax) return Infinity;
  var ux = di * dxm / dh, uy = dj * dym / dh;
  if (Math.abs(GX[v] * uy - GY[v] * ux) > eff.tanCross) return Infinity;  // cross slope
  var ratio = Math.exp(-3.5 * Math.abs(s + 0.05) + 0.175);                 // normalized Tobler: v/v0 = e^(-3.5|s+0.05|+0.175), peak at ~-3 deg downhill (ratio TOBLER_MAX)
  var t = Math.sqrt(dh * dh + dz * dz) / (eff.v * ratio);
  var th = SLOPE[v]; if (th > 15) t *= 1 + 2 * (th - 15) / 10;              // caution band
  if (SAND[v]) t *= eff.sand;
  return t;
}

// ---------- A* ----------
// Cell-to-cell A*. The heuristic is straight-line distance at the maximum possible speed (v0*TOBLER_MAX),
// so it never overestimates (admissible). Stale heap entries are skipped through CLOSED (lazy deletion).
export function astar(grid, s, t, eff) {
  ensureWork(grid);
  var N = grid.N, dxm = grid.dxm, dym = grid.dym, G = grid.G, PAR = grid.PAR, CLOSED = grid.CLOSED, heap = grid.heap;
  G.fill(Infinity); CLOSED.fill(0); heap.n = 0;
  var ti = t % N, tj = (t / N) | 0, vmax = eff.v * TOBLER_MAX;
  function h(c) { var a = (c % N - ti) * dxm, b = (((c / N) | 0) - tj) * dym; return Math.sqrt(a * a + b * b) / vmax; }
  G[s] = 0; heap.push(s, h(s));
  var expanded = 0;
  while (heap.n) {
    var u = heap.pop();
    if (CLOSED[u]) continue;
    CLOSED[u] = 1; expanded++;
    if (u === t) break;
    var ui = u % N, uj = (u / N) | 0;
    for (var k = 0; k < 8; k++) {
      var vi = ui + DI[k], vj = uj + DJ[k];
      if (vi < 0 || vj < 0 || vi >= N || vj >= N) continue;
      var v = vj * N + vi;
      if (CLOSED[v]) continue;
      var c = stepTime(grid, u, v, k, eff);
      if (c === Infinity) continue;
      var g = G[u] + c;
      if (g < G[v]) { G[v] = g; PAR[v] = u; heap.push(v, g + h(v)); }
    }
  }
  if (!isFinite(G[t])) return { path: null, time: Infinity, expanded: expanded };
  var path = [], x = t; while (x !== s) { path.push(x); x = PAR[x]; } path.push(s); path.reverse();
  return { path: path, time: G[t], expanded: expanded };
}

// ---------- Dijkstra from the habitat (reversed edges = return time) ----------
// Expands from the habitat using the cost of moving v -> u (opposite direction (k+4)%8), so T[c] is the time
// to walk from c BACK to the habitat. Feeds the return-time layer, the map readout and "longest return".
export function returnMap(grid, hcell, eff) {
  ensureWork(grid);
  var N = grid.N, CLOSED = grid.CLOSED, heap = grid.heap;
  var T = new Float32Array(N * N).fill(Infinity);
  CLOSED.fill(0); heap.n = 0; T[hcell] = 0; heap.push(hcell, 0);
  while (heap.n) {
    var u = heap.pop();
    if (CLOSED[u]) continue;
    CLOSED[u] = 1;
    var ui = u % N, uj = (u / N) | 0;
    for (var k = 0; k < 8; k++) {
      var vi = ui + DI[k], vj = uj + DJ[k];
      if (vi < 0 || vj < 0 || vi >= N || vj >= N) continue;
      var v = vj * N + vi;
      if (CLOSED[v]) continue;
      var c = stepTime(grid, v, u, (k + 4) % 8, eff);   // cost from v to u
      if (c === Infinity) continue;
      var g = T[u] + c;
      if (g < T[v]) { T[v] = g; heap.push(v, g); }
    }
  }
  return { T: T };
}

// Stop on a blocked cell: uses the nearest reachable cell (up to ~25 m)
export function snapCell(grid, c) {
  var N = grid.N, BLOCK = grid.BLOCK, dxm = grid.dxm, dym = grid.dym;
  if (c < 0 || !BLOCK[c]) return { cell: c, moved: 0 };
  var ci = c % N, cj = (c / N) | 0, best = -1, bd = Infinity;
  for (var r = 1; r <= 10 && best < 0; r++) {
    for (var dj = -r; dj <= r; dj++) for (var di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      var i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
      var v = j * N + i; if (BLOCK[v]) continue;
      var d = Math.hypot(di * dxm, dj * dym); if (d < bd) { bd = d; best = v; }
    }
  }
  return best < 0 ? { cell: c, moved: 0 } : { cell: best, moved: bd };
}

// All orderings of arr (brute force; at most 6! = 720 for 6 stops)
function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  var out = [];
  arr.forEach(function (x, i) {
    var rest = arr.slice(0, i).concat(arr.slice(i + 1));
    permutations(rest).forEach(function (p) { out.push([x].concat(p)); });
  });
  return out;
}

// Per-leg statistics along a path: 3D distance, climb/descent, max slope, meters in caution band and on sand,
// dose (time on each cell x local dose rate) and cumulative times.
export function segStats(grid, path, eff) {
  var N = grid.N, ELEV = grid.ELEV, SLOPE = grid.SLOPE, SAND = grid.SAND, dxm = grid.dxm, dym = grid.dym, ddiag = grid.ddiag;
  var dist = 0, climb = 0, desc = 0, maxSl = 0, caution = 0, sand = 0, dose = 0, times = [0];
  for (var q = 1; q < path.length; q++) {
    var u = path[q - 1], v = path[q];
    var di = (v % N) - (u % N), dj = ((v / N) | 0) - ((u / N) | 0);
    var k = 0; for (; k < 8; k++) if (DI[k] === di && DJ[k] === dj) break;
    var dh = (di !== 0 && dj !== 0) ? ddiag : (di !== 0 ? dxm : dym);
    var dz = ELEV[v] - ELEV[u], d3 = Math.sqrt(dh * dh + dz * dz), st = stepTime(grid, u, v, k, eff);
    dist += d3; if (dz > 0) climb += dz; else desc -= dz;
    if (SLOPE[v] > maxSl) maxSl = SLOPE[v];
    if (SLOPE[v] > 15) caution += d3;
    if (SAND[v]) sand += d3;
    dose += st / 3600 * doseAt(grid, v);
    times.push(times[q - 1] + st);
  }
  return { dist: dist, climb: climb, desc: desc, maxSlope: maxSl, caution: caution, sand: sand, dose: dose, times: times };
}

// ---------- Schedule (instant: duration, reserve and stop times) ----------
// Builds the timeline from the legs already computed: travel events + work events, total time and dose.
export function schedule(grid, P) {
  var ev = [], t = 0, dose = 0, missing = false;
  P.segs.forEach(function (sg, k) {
    var tt = sg.stats ? sg.res.time : 0; if (!sg.stats) missing = true;
    ev.push({ type: 'travel', start: t, dur: tt, k: k }); t += tt; dose += sg.stats ? sg.stats.dose : 0;
    if (k < P.segs.length - 1) {
      var pi = P.seq[k + 1], wk = (P.pts[pi].work || 0) * 60;
      ev.push({ type: 'work', start: t, dur: wk, pi: pi, n: k + 1 });
      dose += wk / 3600 * doseAt(grid, P.cells[pi]); t += wk;
    }
  });
  return { events: ev, total: t, dose: dose, missing: missing };
}

// ---------- Route planning (only runs when geometry or limits change) ----------
// pts = [habitat, ...stops]; params = state.p; cache = { sig: '', map: Map } (mutated, reused across calls).
// The cache is keyed by 'cellA>cellB' and wiped when speed, slope limits or sand factor change (sig).
// onProgress(n) is called for each new A*; returning false cancels (planRoute returns null).
export async function planRoute(grid, pts, params, cache, onProgress) {
  var N = grid.N;
  await nextFrame();
  var eff = effective(params); computeBlock(grid, eff);
  var sig = [eff.v, eff.maxSlope, eff.tanCross, eff.sand].join('|');
  if (sig !== cache.sig) { cache.map = new Map(); cache.sig = sig; }
  var snapM = [];
  var cells = pts.map(function (p) { var r = snapCell(grid, cellOf(grid, p.lat, p.lng)); snapM.push(r.moved); return r.cell; });
  var n = pts.length, M = [], expandedNew = 0, runsNew = 0, runsCached = 0;
  for (var a = 0; a < n; a++) M.push(new Array(n).fill(null));

  // M[a][b] = result of the leg a->b. A* with cache: each cell pair is computed once for the same limits
  async function seg(a, b) {
    if (M[a][b]) return M[a][b];
    var key = cells[a] + '>' + cells[b], hit = cache.map.get(key);
    if (hit) { runsCached++; M[a][b] = hit; return hit; }
    runsNew++; if (onProgress) onProgress(runsNew);
    await nextFrame();
    if (onProgress && onProgress(runsNew) === false) throw 'cancelled';
    var r = (cells[a] < 0 || cells[b] < 0) ? { path: null, time: Infinity, expanded: 0 } : astar(grid, cells[a], cells[b], eff);
    expandedNew += r.expanded; cache.map.set(key, r); M[a][b] = r; return r;
  }

  // Habitat <-> stop legs first: a stop with no path both ways is unreachable and is dropped from the order.
  var idxs = [], reach = [], order;
  for (a = 1; a < n; a++) idxs.push(a);
  try {
    for (var q = 0; q < idxs.length; q++) { await seg(0, idxs[q]); await seg(idxs[q], 0); }
    reach = idxs.filter(function (p) { return isFinite(M[0][p].time) && isFinite(M[p][0].time); });
    if (params.optimize && reach.length > 1) {
      for (q = 0; q < reach.length; q++) for (var w = 0; w < reach.length; w++) if (q !== w) await seg(reach[q], reach[w]);
      var best = Infinity, bestOrder = reach.slice();
      permutations(reach).forEach(function (perm) {
        var sq = [0].concat(perm, [0]), tot = 0;
        for (var s = 0; s < sq.length - 1; s++) tot += M[sq[s]][sq[s + 1]].time;
        if (tot < best) { best = tot; bestOrder = perm; }
      });
      order = bestOrder;
    } else {
      order = reach.slice();
      for (q = 0; q < order.length - 1; q++) await seg(order[q], order[q + 1]);
    }
  } catch (e) { return null; }

  var seq = [0].concat(order, [0]), segs = [];
  for (var s = 0; s < seq.length - 1; s++) {
    var res = M[seq[s]][seq[s + 1]];
    segs.push({ from: seq[s], to: seq[s + 1], res: res, stats: res && res.path ? segStats(grid, res.path, eff) : null });
  }
  var unreach = idxs.filter(function (p) { return reach.indexOf(p) < 0; });
  return { pts: pts, cells: cells, seq: seq, segs: segs, eff: eff, M: M, snapM: snapM, unreach: unreach, sig: sig, runsNew: runsNew, runsCached: runsCached, expandedNew: expandedNew };
}
