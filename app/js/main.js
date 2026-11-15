/*
 * main.js - entry point (loaded as a module by index.html). Owns the app state and wires everything together.
 *
 * Flow: loadData -> buildTerrain -> buildCandidates -> initMap -> bindParams -> plan().
 * plan() runs A* (route.js) only when geometry or limits change; EVA duration, reserve and stop time
 * only call refresh() (schedule), without rerunning A*.
 */
import { DEFAULT_PARAMS, HAB_PX, MAX_STOPS } from './config.js';
import { loadData } from './data.js';
import { buildTerrain, cellOf, pxToLL, doseAt } from './terrain.js';
import { planRoute, returnMap, nextFrame } from './route.js';
import { buildCandidates } from './candidates.js';
import { initMap, setCursor, toggleLayer, renderSlope, renderReturn, renderCrism, renderRoute } from './map.js';
import { $, nf, fmtMin, setStatus, setRadRange, setSolRange, setModeUI, refreshTimes, renderSegments, drawProfile, bindParams } from './ui.js';

var grid, raw, CANDS = [], cache = { sig: '', map: new Map() };
var runToken = 0, lastPlan = null, retMap = null, retKey = '';
var state = { habitat: null, stops: [], mode: null, p: Object.assign({}, DEFAULT_PARAMS) };

function refresh() {
  if (!lastPlan) return;
  refreshTimes(grid, lastPlan, state.p, retMap, state.stops, CANDS, {
    onWork: function (pi, v) { state.stops[pi - 1].work = v; refresh(); },
    onRemove: function (pi) { state.stops.splice(pi - 1, 1); plan(); }
  });
}
function drawRoute() { renderRoute(grid, lastPlan, onDrag); }
function onDrag(pi, ll) {
  if (cellOf(grid, ll.lat, ll.lng) < 0) { drawRoute(); return; }
  if (pi === 0) { state.habitat.lat = ll.lat; state.habitat.lng = ll.lng; }
  else { state.stops[pi - 1].lat = ll.lat; state.stops[pi - 1].lng = ll.lng; }
  plan();
}

// Only runs when geometry or limits change; a new call cancels the previous one
async function plan() {
  var token = ++runToken;
  setStatus('Calculating route…', 'info');
  $('#feasible').className = 'pill info'; $('#feasible').textContent = 'Calculating…';
  var P = await planRoute(grid, [state.habitat].concat(state.stops), state.p, cache, function (n) {
    setStatus('A*: segment ' + n, 'info'); return token === runToken;
  });
  if (!P || token !== runToken) return;
  lastPlan = P;
  $('#astarInfo').textContent = 'A*: ' + P.runsNew + ' segment(s) computed now (' + nf(P.expandedNew) + ' cells expanded), ' + P.runsCached + ' reused from cache.';
  renderSlope(grid, P.eff);
  drawRoute();
  renderSegments(P);
  drawProfile(grid, P);
  refresh();

  // Return map (Dijkstra), recomputed only if the habitat or limits change
  var rk = P.cells[0] + '|' + P.sig;
  if (rk !== retKey) {
    retMap = null; refresh();
    setStatus('Calculating return times…', 'info');
    await nextFrame();
    if (token !== runToken) return;
    retMap = P.cells[0] >= 0 ? returnMap(grid, P.cells[0], P.eff) : null;
    retKey = rk;
    renderReturn(grid, retMap);
  }
  refresh();
  setStatus('Route calculated', 'ok');
}

function setMode(m) {
  state.mode = m; setModeUI(m); setCursor(m ? 'crosshair' : '');
}
function defaults() {
  state.habitat = Object.assign({ name: 'Habitat' }, pxToLL(grid, HAB_PX[0], HAB_PX[1]));
  state.stops = CANDS.slice(0, 4).map(function (c) { return Object.assign({}, c, { work: state.p.work }); });
}

function onMove(ll) {
  var c = cellOf(grid, ll.lat, ll.lng);
  if (c < 0) return;
  var txt = ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5) + ' · elev ' + nf(grid.ELEV[c]) + ' m · slope ' + nf(grid.SLOPE[c], 1) + '°' +
    (grid.SAND[c] ? ' · sand' : ' · rock') + ' · dose ~' + nf(doseAt(grid, c), 2) + ' µGy/h';
  if (retMap && isFinite(retMap.T[c])) txt += ' · return ' + fmtMin(retMap.T[c]);
  $('#readout').textContent = txt;
}
function onClick(ll) {
  if (cellOf(grid, ll.lat, ll.lng) < 0) return;
  if (state.mode === 'add') {
    if (state.stops.length >= MAX_STOPS) { setMode(null); return; }
    var n = state.stops.filter(function (s) { return s.src === 'manual'; }).length + 1;
    state.stops.push({ key: 'manual' + Date.now(), name: 'Marked point ' + n, src: 'manual', lat: ll.lat, lng: ll.lng, work: state.p.work });
    setMode(null); plan();
  } else if (state.mode === 'hab') {
    state.habitat = { name: 'Habitat', lat: ll.lat, lng: ll.lng };
    setMode(null); plan();
  }
}

// Console diagnostics: evaDebug()
window.evaDebug = function () {
  if (!lastPlan) return null;
  return {
    points: lastPlan.pts.map(function (p, i) { var c = lastPlan.cells[i]; return { name: p.name, minutes: p.work, slope: c >= 0 ? +grid.SLOPE[c].toFixed(1) : null, dose: c >= 0 ? +doseAt(grid, c).toFixed(2) : null }; }),
    candidates: CANDS.map(function (c) { return c.name + ' (' + c.lat.toFixed(4) + ', ' + c.lng.toFixed(4) + ')'; }),
    dose_min_max: [grid.doseMin, grid.doseMax],
    matrix_min: lastPlan.M.map(function (row) { return row.map(function (r) { return r ? (isFinite(r.time) ? Math.round(r.time / 60) : 'X') : '-'; }); })
  };
};

async function start() {
  try {
    raw = await loadData('data/');
    grid = buildTerrain(raw);
  } catch (err) {
    setStatus('Error loading data', 'bad');
    $('#readout').textContent = 'Could not load the data/ folder. Open the page through a server, not directly from the file.';
    return;
  }
  setRadRange(grid.doseMin, grid.doseMax);
  setSolRange(raw.trav);
  CANDS = buildCandidates(grid, raw.crism);
  initMap(grid, raw.trav, raw.crism, { onMove: onMove, onClick: onClick });
  defaults();
  bindParams(state.p, {
    replan: plan, refresh: refresh,
    setWork: function (w) { state.stops.forEach(function (st) { st.work = w; }); },
    toggleLayer: toggleLayer,
    crism: function () { renderCrism(raw.crism); },
    plus: function () {
      var used = state.stops.map(function (s) { return s.key; });
      var c = CANDS.filter(function (x) { return used.indexOf(x.key) < 0; })[0];
      if (!c || state.stops.length >= MAX_STOPS) return;
      state.stops.push(Object.assign({}, c, { work: state.p.work })); plan();
    },
    minus: function () { if (state.stops.length > 1) { state.stops.pop(); plan(); } },
    toggleMode: function (m) { setMode(state.mode === m ? null : m); },
    setMode: setMode,
    reset: function () { defaults(); plan(); },
    redraw: function () { if (lastPlan) drawProfile(grid, lastPlan); },
    recolor: function () { if (lastPlan) { drawProfile(grid, lastPlan); drawRoute(); } }
  });
  plan();
}
start();
