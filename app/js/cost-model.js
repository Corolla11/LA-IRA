import { DI, DJ } from './config.js';
import { ensureWork } from './grid-workspace.js';

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

export function stepTime(grid, u, v, k, eff) {
  var BLOCK = grid.BLOCK, ELEV = grid.ELEV, GX = grid.GX, GY = grid.GY, SLOPE = grid.SLOPE, SAND = grid.SAND;
  var dxm = grid.dxm, dym = grid.dym, ddiag = grid.ddiag;
  if (BLOCK[v]) return Infinity;
  var di = DI[k], dj = DJ[k];
  var dh = (di !== 0 && dj !== 0) ? ddiag : (di !== 0 ? dxm : dym);
  var dz = ELEV[v] - ELEV[u], s = dz / dh;
  if (Math.abs(s) > eff.tanMax) return Infinity;
  var ux = di * dxm / dh, uy = dj * dym / dh;
  if (Math.abs(GX[v] * uy - GY[v] * ux) > eff.tanCross) return Infinity;
  var ratio = Math.exp(-3.5 * Math.abs(s + 0.05) + 0.175);
  var t = Math.sqrt(dh * dh + dz * dz) / (eff.v * ratio);
  var th = SLOPE[v]; if (th > 15) t *= 1 + 2 * (th - 15) / 10;
  if (SAND && SAND[v]) t *= eff.sand;
  return t;
}
