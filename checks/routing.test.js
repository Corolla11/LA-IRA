import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrain, doseAt, llOf } from '../app/js/terrain.js';
import { astar, computeBlock, effective, planRoute, schedule, stepTime } from '../app/js/route.js';
import { dstarLite } from '../app/js/dstar-lite.js';
import { loadData } from '../app/js/data.js';
import { DEFAULT_PARAMS } from '../app/js/config.js';

function terrain() {
  const N = 8;
  const elev = Float32Array.from({ length: N * N }, (_, i) =>
    Math.sin(i % N) * 0.1 + Math.cos(Math.floor(i / N)) * 0.15);
  return buildTerrain({ meta: { N, body: { name: 'Moon', radius: 1737400 }, lonW: 0, lonE: 0.001, latS: 0, latN: 0.001 }, elev });
}

test('topography works without thermal or radiation, and all algorithms agree', () => {
  const grid = terrain(), eff = effective(DEFAULT_PARAMS);
  assert.equal(grid.SAND, null);
  assert.equal(doseAt(grid, 0), null);
  computeBlock(grid, eff);
  for (const [start, goal] of [[0, 63], [63, 0], [8, 39], [25, 25]]) {
    const a = astar(grid, start, goal, eff);
    const d = astar(grid, start, goal, eff, false);
    const lite = dstarLite(grid, start, goal, eff, stepTime);
    assert.ok(Math.abs(a.time - d.time) < 1e-8);
    assert.ok(Math.abs(lite.time - d.time) < 1e-8);
    assert.equal(lite.path[0], start);
    assert.equal(lite.path.at(-1), goal);
  }
});

test('all algorithms report an unreachable destination', () => {
  const grid = terrain(), eff = effective(DEFAULT_PARAMS);
  computeBlock(grid, eff);
  for (let i = 0; i < grid.N; i++) grid.BLOCK[3 * grid.N + i] = 1;
  assert.equal(astar(grid, 0, 63, eff).path, null);
  assert.equal(astar(grid, 0, 63, eff, false).path, null);
  assert.equal(dstarLite(grid, 0, 63, eff, stepTime).path, null);
});

test('D* Lite agrees with Dijkstra on varied directed terrain and obstacles', () => {
  let seed = 41;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let trial = 0; trial < 30; trial++) {
    const grid = terrain(), eff = effective(DEFAULT_PARAMS);
    computeBlock(grid, eff);
    for (let i = 1; i < grid.BLOCK.length - 1; i++) grid.BLOCK[i] = random() < 0.18 ? 1 : 0;
    for (const [start, goal] of [[0, 63], [63, 0]]) {
      const d = astar(grid, start, goal, eff, false);
      const lite = dstarLite(grid, start, goal, eff, stepTime);
      if (!Number.isFinite(d.time)) assert.equal(lite.path, null);
      else assert.ok(Math.abs(lite.time - d.time) < 1e-8);
    }
  }
});

test('algorithm changes invalidate the leg cache and absent dose stays unavailable', async () => {
  const grid = terrain(), cache = { sig: '', map: new Map() };
  const points = [0, 63].map(c => {
    const [lat, lng] = llOf(grid, c);
    return { lat, lng, work: 1 };
  });
  const a = await planRoute(grid, points, { ...DEFAULT_PARAMS, optimize: false }, cache);
  const d = await planRoute(grid, points, { ...DEFAULT_PARAMS, algorithm: 'dijkstra', optimize: false }, cache);
  assert.ok(a.runsNew > 0 && d.runsNew > 0);
  assert.equal(schedule(grid, d).dose, null);
  assert.equal(d.segs[0].stats.sand, null);
});

test('loader accepts a topography-only package and rejects invalid elevation', async () => {
  const meta = { schema: 1, body: { name: 'Moon', radius: 1737400 }, N: 2, lonW: 0, lonE: 1, latS: 0, latN: 1 };
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) view.setFloat32(i * 4, i, true);
  let encoded = Buffer.from(bytes).toString('base64');
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, json: async () => meta, text: async () => encoded });
  try {
    const data = await loadData('data/');
    assert.deepEqual(Array.from(data.elev), [0, 1, 2, 3]);
    assert.equal(data.themis, null);
    assert.deepEqual(data.trav, []);
    encoded = 'AA==';
    await assert.rejects(loadData('data/'), /Elevation size/);
  } finally { globalThis.fetch = oldFetch; }
});

test('declared thermal and radiation data enable their models', () => {
  const N = 250, meta = {
    N, body: { name: 'Mars', radius: 3396190 },
    lonW: 0, lonE: 0.01, latS: 0, latN: 0.01, themisSize: 2,
    radiation: { rate: 6.55, lat: 0.005, lng: 0.005 }
  };
  const themis = { data: Uint8ClampedArray.from([0, 0, 0, 255, 40, 40, 40, 255, 80, 80, 80, 255, 160, 160, 160, 255]) };
  const grid = buildTerrain({ meta, elev: new Float32Array(N * N), themis });
  assert.ok(grid.SAND.some(value => value === 1));
  assert.ok(Math.abs(doseAt(grid, 0) - 6.55) < 1e-5);
  assert.ok(Math.abs(grid.doseMax - grid.doseMin) < 1e-5);
  assert.throws(() => buildTerrain({ meta: { ...meta, radiation: { ...meta.radiation, lat: NaN } }, elev: new Float32Array(N * N), themis }), /Radiation requires/);
});
