/*
 * main.js - entry point (loaded as a module by index.html). Owns the app state and wires everything together.
 *
 * Flow: runGate (sources.js: body + layers) -> start(body, manifest) -> loadData -> buildTerrain -> buildCandidates -> initMap -> bindParams -> plan().
 * plan() runs A* (route.js) only when geometry or limits change; EVA duration, reserve and stop time
 * only call refresh() (schedule), without rerunning A*.
 */
import { DEFAULT_PARAMS, MAX_STOPS } from './config.js';
import { runGate } from './sources.js';
import { loadData } from './data.js';
import { openCachedBody } from './cache.js';
import { initRefresh } from './refresh.js';
import { buildTerrain, cellOf, doseAt } from './terrain.js';
import { planRoute, returnMap, nextFrame } from './route.js';
import { buildCandidates } from './candidates.js';
import { initMap, setCursor, toggleLayer, renderSlope, renderReturn, renderCrism, renderRoute } from './map.js';
import { $, nf, fmtMin, setStatus, setRadRange, setSolRange, setModeUI, applyLayerUI, refreshTimes, renderSegments, drawProfile, bindParams } from './ui.js';

var body, grid, raw, CANDS = [], cache = { sig: '', map: new Map() };
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
  try {
  setStatus('Calculating route…', 'info');
  $('#feasible').className = 'pill info'; $('#feasible').textContent = 'Calculating…';
  var P = await planRoute(grid, [state.habitat].concat(state.stops), state.p, cache, function (n) {
    setStatus($('#pAlgorithm').selectedOptions[0].textContent + ': segment ' + n, 'info'); return token === runToken;
  });
  if (!P || token !== runToken) return;
  lastPlan = P;
  $('#astarInfo').textContent = $('#pAlgorithm').selectedOptions[0].textContent + ': ' + P.runsNew + ' segment(s) computed now (' + nf(P.expandedNew) + ' cells expanded), ' + P.runsCached + ' reused from cache.';
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
  } catch (err) {
    if (token !== runToken) return;
    console.error(err);
    setStatus('Route calculation failed', 'bad');
    $('#readout').textContent = 'Route calculation failed: ' + err.message;
  }
}

function setMode(m) {
  state.mode = m; setModeUI(m); setCursor(m ? 'crosshair' : '');
}
function defaults() {
  var pos = body.habitat ? { lat: body.habitat.lat, lng: body.habitat.lng } :
    { lat: (grid.meta.latN + grid.meta.latS) / 2, lng: (grid.meta.lonW + grid.meta.lonE) / 2 };
  state.habitat = Object.assign({ name: 'Habitat' }, pos);
  state.stops = CANDS.slice(0, 4).map(function (c) { return Object.assign({}, c, { work: state.p.work }); });
}

function onMove(ll) {
  var c = cellOf(grid, ll.lat, ll.lng);
  if (c < 0) return;
  var txt = ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5) + ' · elev ' + nf(grid.ELEV[c]) + ' m · slope ' + nf(grid.SLOPE[c], 1) + '°' +
    (grid.SAND ? (grid.SAND[c] ? ' · estimated sand' : ' · not classified as sand') : ' · terrain type unavailable') +
    (grid.DOSE ? ' · dose ~' + nf(doseAt(grid, c), 2) + ' µGy/h' : ' · dose unavailable');
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
    points: lastPlan.pts.map(function (p, i) { var c = lastPlan.cells[i], dose = doseAt(grid, c); return { name: p.name, minutes: p.work, slope: c >= 0 ? +grid.SLOPE[c].toFixed(1) : null, dose: dose === null ? null : +dose.toFixed(2) }; }),
    candidates: CANDS.map(function (c) { return c.name + ' (' + c.lat.toFixed(4) + ', ' + c.lng.toFixed(4) + ')'; }),
    dose_min_max: [grid.doseMin, grid.doseMax],
    matrix_min: lastPlan.M.map(function (row) { return row.map(function (r) { return r ? (isFinite(r.time) ? Math.round(r.time / 60) : 'X') : '-'; }); })
  };
};

function addNote(text) {
  var li = document.createElement('li'); li.textContent = text; $('#sourceNotes').appendChild(li);
}
// The RAD reference point follows Curiosity: the profile target tied to it moves to where the latest dose was measured.
function followLiveRadiation(profile, meta) {
  if (!meta.radiationLive) return;
  var target = (profile.targets || []).filter(function (t) { return t.src === 'Curiosity / RAD'; })[0];
  if (target) {
    target.lat = meta.radiation.lat; target.lng = meta.radiation.lng;
    target.name = 'Curiosity point, sol ' + meta.radiationLive.sol;
  }
}
function addLiveNotes(data, live) {
  if (!live) return;
  var late = data.fallbacks.map(function (label) { return label === 'optical' ? 'HiRISE' : label; });
  addNote(late.length
    ? 'NASA could not be reached for: ' + late.join(', ') + '. Those layers show the snapshot taken when this version was deployed.'
    : 'The planner opened from saved or deployed data. NASA is being checked in the background; use "Update data" to check again.');
  var radNote = $('#radNote');
  if (data.meta.radiationLive && radNote) {
    var r = data.meta.radiationLive;
    radNote.textContent = 'mean E dose of ' + nf(data.meta.radiation.rate, 2) + ' µGy/h measured on sols ' +
      r.firstSol + '–' + r.lastSol + ' (the newest in the PDS archive), taken at the position of Curiosity on sol ' + r.sol;
  }
}

// Manifests from the local server (/api/prepare) have no "live" key; deployments always set it (sources.js).
function localServer(manifest) { return !('live' in manifest); }

// body = profile from app/bodies/<id>.json; manifest contains the selected source layers.
async function start(bodyProfile, manifest) {
  body = bodyProfile;
  state.p.v0 = body.v0 || DEFAULT_PARAMS.v0;
  var synced, live = !!manifest.live;
  try {
    synced = await openCachedBody(body.id, live);
    raw = await loadData('data/' + body.id + '/', manifest.layers, null, synced.resolve, synced.cacheFetched);
    if (live) {
      try {
        var radiation = await synced.get('radiation.json');
        if (radiation) {
          var current = JSON.parse(await radiation.blob.text());
          if (![current.rate, current.lat, current.lng].every(Number.isFinite) || current.rate <= 0) {
            throw new Error('Cached radiation data is invalid.');
          }
          raw.meta.radiation = { rate: current.rate, lat: current.lat, lng: current.lng };
          raw.meta.radiationLive = { sol: current.sol, firstSol: current.firstSol, lastSol: current.lastSol };
        }
      } catch (e) { console.warn('cached radiation unavailable', e); }
    }
    followLiveRadiation(body, raw.meta);
    grid = buildTerrain(raw);
  } catch (err) {
    setStatus('Error loading data', 'bad');
    console.error(err);
    $('#readout').textContent = 'Could not load data: ' + err.message;
    return;
  }
  if (grid.DOSE) { setRadRange(grid.doseMin, grid.doseMax); $('#radRef').textContent = nf(grid.meta.radiation.rate, 2) + ' reference'; }
  else $('#radRef').textContent = 'unavailable';
  $('#subtitle').textContent = body.subtitle || ((grid.meta.name || 'Exploration area') + ' · ' + grid.meta.body.name);
  if (body.notes) $('#sourceNotes').replaceChildren.apply($('#sourceNotes'), body.notes.map(function (t) { var li = document.createElement('li'); li.textContent = t; return li; }));
  addLiveNotes(raw, manifest.live);
  $('#pV0').value = state.p.v0; $('#pV0').dispatchEvent(new Event('input'));
  setSolRange(raw.trav);
  CANDS = buildCandidates(grid, raw.crism, body);
  if (!CANDS.length) $('#candidateNote').textContent = 'Mark points on the map. No suggested points were supplied.';
  initMap(grid, raw.trav, raw.crism, { onMove: onMove, onClick: onClick }, 'data/' + body.id + '/', synced.resolve,
    synced.cacheUrl);
  if (live || localServer(manifest)) {
    $('#btnUpdate').hidden = false;
    initRefresh(body.id, synced.status, manifest, live, synced.ensureCached);
  }
  applyLayerUI(manifest, !!grid.DOSE);
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
// After "Apply" the page reloads: resume the same body and layers without the startup screen (one use)
(async function boot() {
  var saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('aira-resume')); sessionStorage.removeItem('aira-resume'); } catch (e) { /* none */ }
  if (saved && saved.bodyId) {
    $('#gate').hidden = true;
    try {
      var r = await fetch('bodies/' + encodeURIComponent(saved.bodyId) + '.json');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return start(await r.json(), saved.manifest);
    } catch (e) { console.error(e); }
  }
  runGate(start);
})();
