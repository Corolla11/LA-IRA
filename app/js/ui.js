/*
 * ui.js - DOM updates and event binding for the side panel (summary, timeline, stop list, segments, profile, parameters).
 *
 * Input : plans from route.js, the parameter object state.p, and callback objects (act) supplied by main.js.
 * Output: writes text/classes into the elements of index.html and draws the elevation profile canvas.
 * Used by: main.js; map.js imports nothing from here.
 */
import { MAX_STOPS } from './config.js';
import { doseAt } from './terrain.js';
import { schedule } from './route.js';
import { tok } from './map.js';

export var $ = function (s) { return document.querySelector(s); };
export function nf(x, d) { return Number(x).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
export function fmtMin(s) { if (!isFinite(s)) return '–'; var m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') : m + ' min'; }
export function fmtClock(s) { if (!isFinite(s)) return '–'; var m = Math.round(s / 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); }

export function setStatus(t, cls) { var s = $('#status'); s.textContent = t; s.className = 'pill ' + cls; }
export function setRadRange(min, max) { $('#radMin').textContent = nf(min, 2); $('#radMax').textContent = nf(max, 2); }
export function setSolRange(trav) {
  var el = $('[data-sol-range]'), sols = trav ? trav.map(function (p) { return p[0]; }) : [];
  if (!el) return;   // the source notes were replaced by the body profile's notes
  if (sols.length) el.textContent = Math.min.apply(null, sols) + '–' + Math.max.apply(null, sols);
  var li = el.closest('li'); if (li) li.style.display = sols.length ? '' : 'none';
}
// Hides the controls of layers absent from the manifest (layers[id] === false) and unchecks them.
// hasRad = false also hides the radiation layer (body without a dose rate).
export function applyLayerUI(manifest, hasRad) {
  var L = (manifest && manifest.layers) || {};
  function hide(sel, row, on) {
    var el = $(sel); if (!el) return;
    if (!on) el.checked = false;
    var r = el.closest(row); if (r) r.style.display = on ? '' : 'none';
  }
  hide('#lThemis', '.layer-item', L.thermal !== false);
  hide('#lCrism', '.layer-item', L.minerals !== false);
  hide('#lHill', 'label', L.hillshade !== false);
  hide('#lTrav', 'label', L.traverse !== false);
  hide('#lRad', '.layer-item', hasRad !== false);
}
export function setModeUI(m) {
  $('#btnAdd').setAttribute('aria-pressed', m === 'add'); $('#btnHab').setAttribute('aria-pressed', m === 'hab');
  var hint = $('#modeHint');
  if (m) { hint.hidden = false; hint.textContent = m === 'add' ? 'Click on the map to mark the point' : 'Click on the map to place the habitat'; }
  else hint.hidden = true;
}
export function updateStepper(stops, cands) {
  var n = stops.length, used = stops.map(function (s) { return s.key; });
  $('#poiCount').textContent = n;
  $('#poiMinus').disabled = n <= 1;
  $('#poiPlus').disabled = n >= MAX_STOPS || !cands.some(function (c) { return used.indexOf(c.key) < 0; });
  $('#btnAdd').disabled = n >= MAX_STOPS;
}

// ---------- Summary, timeline and stop list ----------
// act = { onWork(pi, minutes), onRemove(pi) }
export function refreshTimes(grid, P, p, retMap, stops, cands, act) {
  var sc = schedule(grid, P);
  var evaS = p.eva * 3600, budget = evaS * (1 - p.reserve / 100);
  var dist = 0, climb = 0, desc = 0, maxSl = 0;
  P.segs.forEach(function (sg) { if (sg.stats) { dist += sg.stats.dist; climb += sg.stats.climb; desc += sg.stats.desc; maxSl = Math.max(maxSl, sg.stats.maxSlope); } });
  var nStops = Math.max(0, P.seq.length - 2), slack = budget - sc.total;
  $('#sTotal').textContent = sc.missing ? '–' : fmtMin(sc.total);
  $('#sBudget').textContent = fmtMin(budget) + ' of ' + nf(p.eva, 1) + ' h';
  var sl = $('#sSlack'); sl.textContent = sc.missing ? '–' : (slack < 0 ? '−' + fmtMin(-slack) : fmtMin(slack)); sl.classList.toggle('neg', slack < 0);
  $('#sDist').textContent = sc.missing ? '–' : nf(dist / 1000, 2) + ' km';
  $('#sClimb').textContent = sc.missing ? '–' : nf(climb) + ' / ' + nf(desc) + ' m';
  $('#sMaxSlope').textContent = sc.missing ? '–' : nf(maxSl, 1) + '°';
  $('#sDose').textContent = sc.missing || sc.dose === null ? 'unavailable' : nf(sc.dose, 1) + ' µGy';

  var worst = -1;
  if (retMap) P.segs.forEach(function (sg) { if (sg.res && sg.res.path) sg.res.path.forEach(function (c) { var t = retMap.T[c]; if (isFinite(t) && t > worst) worst = t; }); });
  $('#sWorst').textContent = retMap ? (worst >= 0 ? fmtMin(worst) : '–') : 'calculating…';

  // Timeline
  var scale = Math.max(evaS, sc.total) || 1, tr = $('#tlTrack'); tr.innerHTML = '';
  sc.events.forEach(function (e) {
    if (e.dur <= 0) return;
    var s = document.createElement('span'); s.className = 'tl-seg ' + e.type;
    s.style.left = (e.start / scale * 100) + '%'; s.style.width = (e.dur / scale * 100) + '%';
    s.title = e.type === 'work' ? 'Stop ' + e.n + ': ' + fmtClock(e.start) + ' to ' + fmtClock(e.start + e.dur) : 'Travel: ' + fmtClock(e.start) + ' to ' + fmtClock(e.start + e.dur);
    if (e.type === 'work' && e.dur / scale > 0.035) s.textContent = e.n;
    tr.appendChild(s);
  });
  [[budget, ''], [evaS, 'end']].forEach(function (m) {
    var k = document.createElement('span'); k.className = 'tl-mark ' + m[1]; k.style.left = 'calc(' + (m[0] / scale * 100) + '% - 1px)'; tr.appendChild(k);
  });
  $('#tlEnd').textContent = fmtClock(scale) + (sc.total > evaS ? ' (past end of EVA)' : '');

  renderStops(P, sc, act);

  var f = $('#feasible'), nu = P.unreach.length;
  if (sc.missing) { f.className = 'pill bad'; f.textContent = 'Segment without path'; }
  else if (nStops === 0) { f.className = 'pill warn'; f.textContent = 'No reachable stop'; }
  else if (sc.total > evaS) { f.className = 'pill bad'; f.textContent = 'Exceeds EVA duration'; }
  else if (sc.total > budget) { f.className = 'pill bad'; f.textContent = 'Uses up the reserve'; }
  else if (nu > 0) { f.className = 'pill warn'; f.textContent = 'Feasible without ' + nu + (nu > 1 ? ' points' : ' point'); }
  else if (!grid.SAND || !grid.DOSE) { f.className = 'pill warn'; f.textContent = 'Within time budget; data incomplete'; }
  else { f.className = 'pill ok'; f.textContent = 'Feasible'; }
  updateStepper(stops, cands);
}

function renderStops(P, sc, act) {
  var ul = $('#stopList'); ul.innerHTML = '';
  var workEv = {}; sc.events.forEach(function (e) { if (e.type === 'work') workEv[e.pi] = e; });
  var list = (P.seq.length === 1 ? P.seq : P.seq.slice(0, -1)).concat(P.unreach);
  list.forEach(function (pi, k) {
    var pt = P.pts[pi], li = document.createElement('li'), bad = P.unreach.indexOf(pi) >= 0;
    if (bad) li.className = 'unreach';
    var label = pi === 0 ? 'H' : (bad ? '!' : k), meta;
    if (pi === 0) meta = 'depart 0:00 · return ' + (sc.missing ? '–' : fmtClock(sc.total));
    else if (bad) meta = 'out of reach with current limits';
    else { var e = workEv[pi]; meta = 'arrive ' + fmtClock(e.start) + ' · leave ' + fmtClock(e.start + e.dur); }
    if (pi !== 0 && pt.src) meta += ' · ' + pt.src;
    if (P.snapM[pi] > 0) meta += ' · adjusted ' + nf(P.snapM[pi]) + ' m';
    li.innerHTML = '<span class="num' + (pi === 0 ? ' h' : '') + '">' + label + '</span>' +
      '<div style="min-width:0"><div class="name"></div><div class="meta"></div></div>';
    li.querySelector('.name').textContent = pt.name;
    li.querySelector('.meta').textContent = meta;
    if (pi !== 0) {
      var ctl = document.createElement('div'); ctl.className = 'stop-ctl';
      var inp = document.createElement('input'); inp.type = 'number'; inp.min = 0; inp.max = 180; inp.step = 5; inp.value = pt.work;
      inp.id = 'work-' + pt.key; inp.setAttribute('aria-label', 'Minutes of work at ' + pt.name);
      inp.addEventListener('change', function () { act.onWork(pi, Math.max(0, Math.min(180, Number(inp.value) || 0))); });
      var u = document.createElement('span'); u.textContent = 'min';
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'icon danger'; btn.textContent = '×';
      btn.setAttribute('aria-label', 'Remove ' + pt.name);
      btn.addEventListener('click', function () { act.onRemove(pi); });
      ctl.appendChild(inp); ctl.appendChild(u); ctl.appendChild(btn); li.appendChild(ctl);
    } else { li.appendChild(document.createElement('span')); }
    ul.appendChild(li);
  });
}

export function renderSegments(P) {
  var tb = $('#segBody'); tb.innerHTML = '';
  var vis = {}; P.seq.slice(1, -1).forEach(function (pi, k) { vis[pi] = String(k + 1); }); vis[0] = 'H';
  P.segs.forEach(function (sg) {
    var tr = document.createElement('tr'), st = sg.stats, name = vis[sg.from] + ' → ' + vis[sg.to];
    if (!st) { tr.innerHTML = '<td>' + name + '</td><td class="bad" colspan="7">No path within limits</td>'; }
    else {
      tr.innerHTML = '<td>' + name + '</td><td>' + nf(st.dist) + '</td><td>' + fmtMin(sg.res.time) + '</td><td>' + nf(st.climb) + ' / ' + nf(st.desc) +
        '</td><td class="' + (st.maxSlope > 15 ? 'warn' : '') + '">' + nf(st.maxSlope, 1) + '°</td><td>' + nf(st.caution) + '</td><td>' + (st.sand === null ? '–' : nf(st.sand)) + '</td><td>' + (st.dose === null ? '–' : nf(st.dose, 1)) + '</td>';
    }
    tb.appendChild(tr);
  });
}

// ---------- Profile ----------
export function drawProfile(grid, P) {
  var N = grid.N, ELEV = grid.ELEV, SLOPE = grid.SLOPE, dxm = grid.dxm, dym = grid.dym, ddiag = grid.ddiag;
  var cv = $('#profile');
  var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  var cx = cv.getContext('2d'); cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, W, H);
  var pts = [], marks = [], d = 0;
  P.segs.forEach(function (sg, k) {
    if (!sg.res || !sg.res.path) return;
    var path = sg.res.path;
    for (var q = 0; q < path.length; q++) {
      if (q > 0) {
        var u = path[q - 1], v = path[q], di = (v % N) - (u % N), dj = ((v / N) | 0) - ((u / N) | 0);
        d += (di !== 0 && dj !== 0) ? ddiag : (di !== 0 ? dxm : dym);
      }
      pts.push([d, ELEV[path[q]], SLOPE[path[q]]]);
    }
    if (k < P.segs.length - 1) marks.push([d, k + 1]);
  });
  var muted = tok('--muted'), line = tok('--line');
  cx.font = '11px ' + tok('--font-mono');
  if (pts.length < 2) { cx.fillStyle = muted; cx.fillText('No route to show.', 8, 20); return; }
  var zmin = Infinity, zmax = -Infinity; pts.forEach(function (p) { zmin = Math.min(zmin, p[1]); zmax = Math.max(zmax, p[1]); });
  var pad = Math.max(5, (zmax - zmin) * 0.1); zmin -= pad; zmax += pad;
  var L0 = 46, R0 = 8, T0 = 8, B0 = 20, pw = W - L0 - R0, ph = H - T0 - B0;
  function X(x) { return L0 + x / d * pw; } function Y(y) { return T0 + (1 - (y - zmin) / (zmax - zmin)) * ph; }
  cx.strokeStyle = line; cx.lineWidth = 1; cx.fillStyle = muted;
  for (var g = 0; g <= 3; g++) {
    var yv = zmin + (zmax - zmin) * g / 3, yy = Math.round(Y(yv)) + 0.5;
    cx.beginPath(); cx.moveTo(L0, yy); cx.lineTo(W - R0, yy); cx.stroke();
    cx.textAlign = 'right'; cx.fillText(nf(yv), L0 - 6, yy + 4);
  }
  cx.textAlign = 'center';
  for (g = 0; g <= 4; g++) { var xv = d * g / 4; cx.fillText(nf(xv / 1000, 1) + ' km', Math.min(W - 24, Math.max(L0 + 14, X(xv))), H - 5); }
  var ok = tok('--ok'), warnC = 'rgb(' + tok('--slope-warn') + ')';
  cx.lineWidth = 2;
  for (var q = 1; q < pts.length; q++) {
    cx.strokeStyle = pts[q][2] > 15 ? warnC : ok;
    cx.beginPath(); cx.moveTo(X(pts[q - 1][0]), Y(pts[q - 1][1])); cx.lineTo(X(pts[q][0]), Y(pts[q][1])); cx.stroke();
  }
  cx.setLineDash([3, 3]); cx.strokeStyle = muted; cx.lineWidth = 1; cx.fillStyle = tok('--ink');
  marks.forEach(function (m) { var xx = Math.round(X(m[0])) + 0.5; cx.beginPath(); cx.moveTo(xx, T0); cx.lineTo(xx, T0 + ph); cx.stroke(); cx.fillText(String(m[1]), xx, T0 + 10); });
  cx.setLineDash([]);
}

// ---------- Parameters ----------
// act = { replan(), refresh(), setWork(minutes), setMode(m|toggle), reset(), plus(), minus(), toggleLayer(key,on), crism() }
export function bindParams(p, act) {
  // Change the route: rerun A*
  [['pV0', 'oV0', 'v0', function (v) { return nf(v, 1) + ' km/h'; }],
   ['pMax', 'oMax', 'maxSlope', function (v) { return v + '°'; }],
   ['pCross', 'oCross', 'maxCross', function (v) { return v + '°'; }],
   ['pSand', 'oSand', 'sand', function (v) { return '×' + nf(v, 1); }]].forEach(function (s) {
    var inp = $('#' + s[0]), out = $('#' + s[1]);
    function show() { out.textContent = s[3](Number(inp.value)); }
    show(); inp.addEventListener('input', show);
    inp.addEventListener('change', function () { p[s[2]] = Number(inp.value); act.replan(); });
  });
  // Only change the schedule: update instantly, without A*
  [['pEva', 'oEva', 'eva', function (v) { return nf(v, 1) + ' h'; }],
   ['pRes', 'oRes', 'reserve', function (v) { return v + '%'; }],
   ['pWork', 'oWork', 'work', function (v) { return v + ' min'; }]].forEach(function (s) {
    var inp = $('#' + s[0]), out = $('#' + s[1]);
    function apply() {
      out.textContent = s[3](Number(inp.value));
      p[s[2]] = Number(inp.value);
      if (s[2] === 'work') act.setWork(p.work);
      act.refresh();
    }
    out.textContent = s[3](Number(inp.value));
    inp.addEventListener('input', apply);
  });
  $('#pCarry').addEventListener('change', function (e) { p.carry = e.target.checked; act.replan(); });
  $('#pOpt').addEventListener('change', function (e) { p.optimize = e.target.checked; act.replan(); });
  $('#pAlgorithm').addEventListener('change', function (e) { p.algorithm = e.target.value; act.replan(); });

  [['#lHill', 'hill'], ['#lThemis', 'themis'], ['#lTrav', 'trav'], ['#lSlope', 'slope'], ['#lRet', 'ret'], ['#lRad', 'rad'], ['#lCrism', 'crism']].forEach(function (t) {
    $(t[0]).addEventListener('change', function (e) { act.toggleLayer(t[1], e.target.checked); });
  });
  $('#crismSel').addEventListener('change', function () { $('#lCrism').checked = true; act.crism(); });

  $('#poiPlus').addEventListener('click', act.plus);
  $('#poiMinus').addEventListener('click', act.minus);
  $('#btnAdd').addEventListener('click', function () { act.toggleMode('add'); });
  $('#btnHab').addEventListener('click', function () { act.toggleMode('hab'); });
  $('#btnReset').addEventListener('click', act.reset);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') act.setMode(null); });
  window.addEventListener('resize', act.redraw);
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', act.recolor);
}
