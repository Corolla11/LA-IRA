// "Update data" button, the "Data: changed … · checked …" text and the result popup.
// initRefresh(bodyId, status, manifest) is called by main.js once the body is loaded.
import { checkUpdates, applyUpdates } from './cache.js';

const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const when = (iso) => { if (!iso) return 'never'; const d = new Date(iso); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const hhmm = (iso) => { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const mins = (iso) => Math.floor((Date.now() - new Date(iso)) / 60000);
const ago = (iso) => {
  if (!iso) return 'not yet';
  const m = mins(iso);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' h ago' : Math.floor(m / 1440) + ' d ago';
};
const kb = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const isImage = (f) => /\.(png|jpe?g)$/i.test(f);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

export function initRefresh(bodyId, status, manifest) {
  const btn = $('#btnUpdate'), dlg = $('#refreshDlg'), body = $('#refreshBody'), msg = $('#refreshMsg');
  const bApply = $('#refreshApply'), bClose = $('#refreshClose');
  let cur = status, result = null;

  const label = () => { $('#dataTime').textContent = cur ? 'Data: changed ' + when(cur.lastChangeAt) + ' · checked ' + ago(cur.lastCheckAt) : ''; };
  label(); setInterval(label, 60000);

  function close() { dlg.hidden = true; btn.focus(); }
  function say(t, bad) { msg.textContent = t; msg.classList.toggle('bad', !!bad); }

  function thumb(url, cap) {
    const f = el('figure', 'thumb'), im = el('img'); im.src = url; im.alt = cap + ' image'; f.append(im, el('figcaption', 'note', cap));
    return f;
  }
  function render(r) {
    body.replaceChildren();
    const st = el('div', 'stats');
    for (const [k, v] of [['Last NASA check', when(r.status.lastCheckAt) + ' (' + ago(r.status.lastCheckAt) + ')'], ['Data last changed', when(r.status.lastChangeAt)]]) {
      const s = el('div', 'stat'); s.append(el('span', 'k', k), el('span', 'v', v)); st.append(s);
    }
    body.append(st);
    if (r.throttled) body.append(el('p', 'note', 'NASA was checked ' + ago(r.status.lastCheckAt) + '; next check available at ' + hhmm(r.nextCheckAt) + '.'));
    const errs = Object.keys(r.errors);
    if (errs.length) {
      const ul = el('ul', 'dlg-errs');
      for (const k of errs) ul.append(el('li', null, k + ': ' + r.errors[k]));
      body.append(el('p', 'note', 'Some layers could not be refreshed; their previous data was kept.'), ul);
    }
    if (!r.diffs.length) say('No changes. This browser already has the latest data.');
    else {
      say(r.diffs.length + ' file' + (r.diffs.length > 1 ? 's' : '') + ' changed.');
      for (const d of r.diffs) {
        const row = el('div', 'gate-row'), head = el('div', 'gate-row-head');
        const delta = d.oldSize == null ? kb(d.newSize) : kb(d.oldSize) + ' → ' + kb(d.newSize) + ' (' + (d.newSize >= d.oldSize ? '+' : '−') + kb(Math.abs(d.newSize - d.oldSize)) + ')';
        head.append(el('span', 'mono', d.file), el('span', 'pill ' + (d.oldUrl ? 'warn' : 'info'), d.oldUrl ? 'changed' : 'new'));
        row.append(head, el('div', 'd', delta));
        if (isImage(d.file)) {
          const t = el('div', 'thumbs');
          if (d.oldUrl) t.append(thumb(d.oldUrl, 'Before'));
          t.append(thumb(d.newUrl, 'After'));
          row.append(t);
        }
        body.append(row);
      }
    }
    const same = Object.keys(r.status.files).filter((f) => !r.diffs.some((d) => d.file === f));
    if (same.length) body.append(el('p', 'note', 'Unchanged: ' + same.join(', ')));
    bApply.hidden = !r.diffs.length;
  }

  btn.addEventListener('click', async () => {
    result = null; body.replaceChildren(); bApply.hidden = true; bApply.disabled = false;
    dlg.hidden = false; say('Querying NASA sources… this can take a minute.'); bClose.focus(); btn.disabled = true;
    try {
      result = await checkUpdates(bodyId);
      cur = result.status; label(); render(result);
    } catch (e) { say('Update check failed: ' + e.message, true); }
    btn.disabled = false;
  });
  bApply.addEventListener('click', async () => {
    bApply.disabled = true; say('Saving new data…');
    try {
      await applyUpdates(bodyId, result.diffs);
      sessionStorage.setItem('aira-resume', JSON.stringify({ bodyId: bodyId, manifest: manifest }));
      location.reload();
    } catch (e) { say('Could not save the new data: ' + e.message, true); bApply.disabled = false; }
  });
  bClose.addEventListener('click', close);
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...dlg.querySelectorAll('button')].filter((b) => !b.hidden && !b.disabled);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
