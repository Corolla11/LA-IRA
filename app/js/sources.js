// Startup gate: body picker + per-source health, layer selection and optional custom URLs.
// runGate(onReady) calls onReady(profile, manifest) once the data is prepared and the user is in.
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  let j = null;
  try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok && !(j && typeof j === 'object')) throw new Error('HTTP ' + r.status + ' from ' + url);
  return { status: r.status, ok: r.ok, json: j };
}

export function runGate(onReady) {
  const gate = $('#gate'), sel = $('#gateBody'), list = $('#gateList'), msg = $('#gateMsg');
  const bRe = $('#gateRecheck'), bGo = $('#gateGo'), bPart = $('#gatePartial');
  let profile = null, checks = [], errors = {}, partial = null, busy = false, deployment = null;
  const checked = {}, urls = {};   // user state per source id

  const say = (t, bad) => { msg.textContent = t; msg.classList.toggle('bad', !!bad); };
  const elevOk = () => { const c = checks.find((x) => x.id === 'elevation'); return !!(c && c.ok); };
  const setBusy = (b) => {
    busy = b; sel.disabled = b; bRe.disabled = b;
    list.querySelectorAll('input').forEach((i) => { if (i.dataset.lock !== '1') i.disabled = b; });
    bGo.disabled = b || !elevOk(); bPart.disabled = b;
  };

  function render() {
    list.innerHTML = '';
    for (const src of profile.sources) {
      const c = checks.find((x) => x.id === src.id) || { ok: false, detail: 'no check result' };
      const req = !!src.required, err = errors[src.id], ov = (urls[src.id] || '').trim();
      const pillCls = err || !c.ok ? 'bad' : 'ok', pillTxt = err || !c.ok ? 'FAIL' : 'OK';
      const li = document.createElement('li'); li.className = 'gate-row';
      li.innerHTML =
        '<div class="gate-row-head"><label class="check"><input type="checkbox">' +
        '<span>' + esc(src.label || src.id) + (req ? ' <span class="req">required</span>' : '') + '</span></label>' +
        '<span class="pill ' + pillCls + '">' + pillTxt + '</span></div>' +
        '<div class="d' + (err ? ' err' : '') + '">' + esc(err || c.detail || '') + (c.prepared && !err ? ' · already prepared' : '') + '</div>' +
        '<input type="url" placeholder="' + esc(src.url || '') + '" value="' + esc(urls[src.id] || '') + '" ' +
        'aria-label="Custom URL for ' + esc(src.label || src.id) + '" autocomplete="off" spellcheck="false">' +
        '<div class="note" hidden>format check skipped (assumed compatible)</div>';
      const cb = li.querySelector('input[type=checkbox]');
      if (req) { cb.checked = true; cb.disabled = true; cb.dataset.lock = '1'; }
      else cb.checked = !!checked[src.id];
      cb.addEventListener('change', () => { checked[src.id] = cb.checked; });
      const inp = li.querySelector('input[type=url]'), note = li.querySelector('.note');
      note.hidden = !ov;
      inp.addEventListener('input', () => { urls[src.id] = inp.value; note.hidden = !inp.value.trim(); });
      if (deployment) {
        if (!c.ok) cb.dataset.lock = '1';
        cb.disabled = busy || !c.ok || req;
        inp.disabled = true; inp.hidden = true;
        inp.dataset.lock = '1';
        note.hidden = false; note.textContent = 'Only packaged data is available in this deployment.';
      }
      list.appendChild(li);
    }
    bGo.disabled = busy || !elevOk();
  }

  async function load(id, keep) {
    setBusy(true); errors = {}; partial = null; bPart.hidden = true;
    say(deployment ? 'Checking packaged data…' : 'Checking data sources…');
    try {
      const p = await getJson('bodies/' + encodeURIComponent(id) + '.json');
      if (!p.ok) throw new Error('body profile not found: ' + id);
      const s = deployment
        ? { ok: true, json: { checks: p.json.sources.map((src) => {
          const ok = !!deployment.bodies.find((b) => b.id === id).layers[src.id];
          return { id: src.id, label: src.label, required: !!src.required, ok,
            detail: ok ? 'Included in this deployment' : 'Not included in this deployment' };
        }) } }
        : await getJson('/api/sources?body=' + encodeURIComponent(id));
      if (!s.ok || !s.json || !s.json.checks) throw new Error((s.json && s.json.error) || 'source check failed');
      profile = p.json; checks = s.json.checks;
      for (const src of profile.sources) {
        const c = checks.find((x) => x.id === src.id);
        if (!keep || !(src.id in checked)) checked[src.id] = !!(c && c.ok);   // failing sources start unchecked
        else if (!(c && c.ok) && !(urls[src.id] || '').trim()) checked[src.id] = false;
      }
      render(); setBusy(false);
      const bad = checks.filter((c) => !c.ok).length;
      say(deployment ? (elevOk() ? 'Static deployment: only included data sources are available.'
          : 'Topography is not included in this deployment.')
        : !elevOk() ? 'Topography (required) is not reachable. Fix the source or its URL and re-check.'
        : bad ? bad + ' source(s) failed and are unchecked. Select the layers to use, then open.'
        : 'All sources reachable. Select the layers to use, then open.', !elevOk());
    } catch (e) {
      profile = null; checks = []; list.innerHTML = ''; setBusy(false); bGo.disabled = true;
      say('Cannot reach the data service (' + e.message + '). Start it with "uv run tools/serve.py", then press Re-check.', true);
    }
  }

  function done(manifest) { gate.hidden = true; onReady(profile, manifest); }

  async function prepare() {
    if (deployment) {
      const layers = {};
      for (const src of profile.sources) {
        const c = checks.find((x) => x.id === src.id);
        layers[src.id] = !!(c && c.ok && (checked[src.id] || src.required));
      }
      done({ body: profile.id, layers: layers, overrides: {} });
      return;
    }
    const layers = profile.sources.filter((s) => checked[s.id] || s.required).map((s) => s.id);
    const overrides = {};
    for (const s of profile.sources) { const u = (urls[s.id] || '').trim(); if (u) overrides[s.id] = u; }
    errors = {}; partial = null; bPart.hidden = true; setBusy(true);
    say('Preparing data… this can take a minute');
    try {
      const r = await getJson('/api/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: profile.id, layers, overrides }) });
      const j = r.json || {};
      if (r.ok && j.ok) { done(j.manifest); return; }
      errors = j.errors || {};
      render(); setBusy(false);
      if (j.manifest && j.manifest.layers && j.manifest.layers.elevation) {
        partial = j.manifest; bPart.hidden = false;
        say('Some layers failed (see below). Fix them and retry, or open without them.', true);
      } else say(j.error || 'Preparation failed. See the rows above.', true);
    } catch (e) {
      setBusy(false); say('Network error while preparing data (' + e.message + '). The app stays blocked.', true);
    }
  }

  sel.addEventListener('change', () => {
    for (const k in checked) delete checked[k];
    for (const k in urls) delete urls[k];
    load(sel.value, false);
  });
  bRe.addEventListener('click', () => { if (sel.value) load(sel.value, true); else boot(); });
  bGo.addEventListener('click', () => { if (profile && elevOk() && !busy) prepare(); });
  bPart.addEventListener('click', () => { if (partial) done(partial); });

  async function boot() {
    sel.innerHTML = ''; say('Loading…'); bRe.disabled = false;
    try {
      const deploymentResponse = await fetch('/deployment.json');
      if (deploymentResponse.status !== 404) {
        if (!deploymentResponse.ok) throw new Error('HTTP ' + deploymentResponse.status + ' from /deployment.json');
        deployment = await deploymentResponse.json();
        if (!deployment || deployment.mode !== 'static' || !Array.isArray(deployment.bodies)) {
          throw new Error('invalid static deployment configuration');
        }
        bGo.textContent = 'Open planner';
      }
      const bodies = deployment
        ? deployment.bodies.map((b) => ({ id: b.id, name: b.name }))
        : (await getJson('/api/bodies')).json;
      if (!Array.isArray(bodies) || !bodies.length) throw new Error('no bodies listed');
      for (const x of bodies) {
        let name = x.name;   // prefer the profile name
        try { const p = await getJson('bodies/' + encodeURIComponent(x.id) + '.json'); if (p.ok && p.json.name) name = p.json.name; } catch (e) { /* keep API name */ }
        const o = document.createElement('option'); o.value = x.id; o.textContent = name || x.id; sel.appendChild(o);
      }
      sel.value = bodies.some((x) => x.id === 'mars') ? 'mars' : bodies[0].id;
      load(sel.value, false);
    } catch (e) {
      say('Cannot reach the data service (' + e.message + '). Start it with "uv run tools/serve.py", then press Re-check.', true);
    }
  }

  gate.hidden = false;
  boot();
}
