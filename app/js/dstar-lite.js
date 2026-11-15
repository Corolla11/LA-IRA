import { DI, DJ, TOBLER_MAX } from './config.js';

// D* Lite's backward search. Each leg starts with a fresh search state; dynamic
// edge updates and state reuse between replans are not exposed by this app.
export function dstarLite(grid, start, goal, eff, stepTime) {
  const N = grid.N, count = N * N;
  const g = new Float64Array(count).fill(Infinity);
  const rhs = new Float64Array(count).fill(Infinity);
  const version = new Uint32Array(count);
  const heap = [];
  let expanded = 0;
  function less(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }
  function key(u) {
    const best = Math.min(g[u], rhs[u]);
    const dx = (u % N - start % N) * grid.dxm;
    const dy = (Math.floor(u / N) - Math.floor(start / N)) * grid.dym;
    return [best + Math.hypot(dx, dy) / (eff.v * TOBLER_MAX), best];
  }
  function push(u) {
    const entry = { u: u, key: key(u), version: ++version[u] };
    let i = heap.length;
    heap.push(entry);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(entry.key, heap[p].key)) break;
      heap[i] = heap[p]; i = p;
    }
    heap[i] = entry;
  }
  function pop() {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let c = i * 2 + 1;
        if (c + 1 < heap.length && less(heap[c + 1].key, heap[c].key)) c++;
        if (!less(heap[c].key, last.key)) break;
        heap[i] = heap[c]; i = c;
      }
      heap[i] = last;
    }
    return top;
  }
  function neighbours(u, fn) {
    const x = u % N, y = Math.floor(u / N);
    for (let k = 0; k < 8; k++) {
      const nx = x + DI[k], ny = y + DJ[k];
      if (nx >= 0 && nx < N && ny >= 0 && ny < N) fn(ny * N + nx, k);
    }
  }
  function update(u) {
    if (u !== goal) {
      let best = Infinity;
      neighbours(u, (v, k) => { best = Math.min(best, stepTime(grid, u, v, k, eff) + g[v]); });
      rhs[u] = best;
    }
    version[u]++;
    if (g[u] !== rhs[u]) push(u);
  }
  rhs[goal] = 0; push(goal);
  while (heap.length) {
    if (heap[0].version !== version[heap[0].u]) { pop(); continue; }
    if (!less(heap[0].key, key(start)) && rhs[start] === g[start]) break;
    const entry = pop(), u = entry.u, current = key(u);
    if (less(entry.key, current)) { push(u); continue; }
    expanded++;
    if (g[u] > rhs[u]) {
      g[u] = rhs[u];
      neighbours(u, v => update(v));
    } else {
      g[u] = Infinity;
      update(u);
      neighbours(u, v => update(v));
    }
  }
  if (!Number.isFinite(g[start])) return { path: null, time: Infinity, expanded: expanded };
  const path = [start];
  let u = start;
  while (u !== goal) {
    let best = Infinity, next = -1;
    neighbours(u, (v, k) => {
      const cost = stepTime(grid, u, v, k, eff) + g[v];
      if (cost < best) { best = cost; next = v; }
    });
    if (next < 0 || path.length > count) throw new Error('D* Lite could not reconstruct the route.');
    path.push(next); u = next;
  }
  return { path: path, time: g[start], expanded: expanded };
}
