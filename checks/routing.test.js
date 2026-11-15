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

test('loader accepts elevation stored as raw bytes in the browser cache', async () => {
  const meta = { schema: 1, body: { name: 'Moon', radius: 1737400 }, N: 2,
    lonW: 0, lonE: 1, latS: 0, latN: 1 };
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer), oldFetch = globalThis.fetch;
  for (let i = 0; i < 4; i++) view.setFloat32(i * 4, i + 1, true);
  globalThis.fetch = async url => url === 'data/meta.json'
    ? { ok: true, json: async () => meta }
    : { ok: true, arrayBuffer: async () => bytes.buffer };
  try {
    const data = await loadData('data/');
    assert.deepEqual(Array.from(data.elev), [1, 2, 3, 4]);
  } finally { globalThis.fetch = oldFetch; }
});

test('loader does not persist cached blobs under the deployed package hash', async () => {
  const meta = { schema: 1, body: { name: 'Moon', radius: 1737400 }, N: 2,
    lonW: 0, lonE: 1, latS: 0, latN: 1 };
  const urls = {
    'meta.json': URL.createObjectURL(new Blob([JSON.stringify(meta)])),
    'elev.txt': URL.createObjectURL(new Blob([new Uint8Array(16)]))
  };
  const persisted = [];
  try {
    const data = await loadData('data/', null, null, name => urls[name], name => persisted.push(name));
    assert.equal(data.elev.length, 4);
    assert.deepEqual(persisted, []);
  } finally { Object.values(urls).forEach(url => URL.revokeObjectURL(url)); }
});

test('loader only uses layers selected for the deployment', async () => {
  const meta = {
    schema: 1, body: { name: 'Mars', radius: 3396190 }, N: 2,
    lonW: 0, lonE: 1, latS: 0, latN: 1,
    layers: { image: 'map.jpg', hillshade: 'hillshade.jpg', thermal: 'thermal.png',
      traverse: 'traverse.json', crism: { hyd: 'hyd.png', phy: 'phy.png', car: 'car.png', tru: 'tru.png' } }
  };
  const bytes = new Uint8Array(16), oldFetch = globalThis.fetch, requested = [];
  globalThis.fetch = async url => {
    requested.push(url);
    return { ok: true, json: async () => meta, text: async () => Buffer.from(bytes).toString('base64') };
  };
  try {
    const data = await loadData('data/', {
      elevation: true, optical: false, hillshade: false, thermal: false, traverse: false, minerals: false
    });
    assert.deepEqual(data.meta.layers, {});
    assert.equal(data.themis, null);
    assert.deepEqual(data.trav, []);
    assert.deepEqual(data.crism, {});
    assert.deepEqual(requested, ['data/meta.json', 'data/elev.txt']);
  } finally { globalThis.fetch = oldFetch; }
});

function liveMeta() {
  return {
    schema: 1, body: { name: 'Mars', radius: 3396190 }, N: 2,
    lonW: 0, lonE: 1, latS: 0, latN: 1, layers: { traverse: 'traverse.json' },
    radiation: { rate: 6.55, lat: 0.4, lng: 0.4 }
  };
}

test('live loader requests NASA-backed endpoints for every layer, bypassing caches', async () => {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer), oldFetch = globalThis.fetch, requested = [], caches = [];
  for (let i = 0; i < 4; i++) view.setFloat32(i * 4, 10 + i, true);
  const current = { rate: 6.4, lat: 0.5, lng: 0.6, sol: 4841, firstSol: 4839, lastSol: 4843 };
  globalThis.fetch = async (url, options) => {
    requested.push(url);
    if (url.startsWith('/api/')) caches.push(options && options.cache);
    if (url.startsWith('/api/layer?body=mars&name=elevation&t=')) return { ok: true, arrayBuffer: async () => bytes.buffer };
    if (url.startsWith('/api/traverse?body=mars&t=')) return { ok: true, json: async () => [[5073, -4.8, 137.38]] };
    if (url.startsWith('/api/radiation?body=mars&t=')) return { ok: true, json: async () => current };
    return { ok: true, json: async () => liveMeta() };
  };
  try {
    const data = await loadData('data/', { elevation: true, traverse: true }, 'mars');
    assert.deepEqual(Array.from(data.elev), [10, 11, 12, 13]);
    assert.deepEqual(data.trav, [[5073, -4.8, 137.38]]);
    assert.deepEqual(data.meta.radiation, { rate: 6.4, lat: 0.5, lng: 0.6 });
    assert.deepEqual(data.meta.radiationLive, { sol: 4841, firstSol: 4839, lastSol: 4843 });
    assert.deepEqual(data.fallbacks, []);
    assert.ok(!requested.includes('data/elev.txt') && !requested.includes('data/traverse.json'));
    assert.equal(caches.length, 3);
    assert.ok(caches.every(mode => mode === 'no-store'));
  } finally { globalThis.fetch = oldFetch; }
});

test('live loader falls back to the packaged snapshot when NASA is unavailable', async () => {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer), oldFetch = globalThis.fetch;
  for (let i = 0; i < 4; i++) view.setFloat32(i * 4, i, true);
  const warn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async url => {
    if (url.startsWith('/api/')) return { ok: false, status: 502 };
    if (url === 'data/traverse.json') return { ok: true, json: async () => [[4670, -4.8, 137.38]] };
    return { ok: true, json: async () => liveMeta(), text: async () => Buffer.from(bytes).toString('base64') };
  };
  try {
    const data = await loadData('data/', { elevation: true, traverse: true }, 'mars');
    assert.deepEqual(Array.from(data.elev), [0, 1, 2, 3]);
    assert.deepEqual(data.trav, [[4670, -4.8, 137.38]]);
    assert.deepEqual(data.meta.radiation, { rate: 6.55, lat: 0.4, lng: 0.4 });
    assert.equal(data.meta.radiationLive, undefined);
    assert.deepEqual(data.fallbacks.slice().sort(), ['elevation', 'radiation', 'traverse']);
  } finally { globalThis.fetch = oldFetch; console.warn = warn; }
});

test('live Moon loader retains the packaged radiation reference without querying RAD', async () => {
  const bytes = new Uint8Array(16), oldFetch = globalThis.fetch, requested = [];
  const meta = { ...liveMeta(), body: { name: 'Moon', radius: 1737400 }, layers: {},
    radiation: { rate: 5.1, lat: 0.4, lng: 0.4 } };
  globalThis.fetch = async url => {
    requested.push(url);
    if (url === 'data/meta.json') return { ok: true, json: async () => meta };
    if (url.startsWith('/api/layer?body=moon&name=elevation')) {
      return { ok: true, arrayBuffer: async () => bytes.buffer };
    }
    throw new Error('Unexpected request: ' + url);
  };
  try {
    const data = await loadData('data/', { elevation: true }, 'moon');
    assert.deepEqual(data.meta.radiation, { rate: 5.1, lat: 0.4, lng: 0.4 });
    assert.deepEqual(data.fallbacks, []);
    assert.ok(!requested.some(url => url.startsWith('/api/radiation')));
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
