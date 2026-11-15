/*
 * cache.js - browser copy of each body's data package (IndexedDB 'aira-cache', store 'files',
 * key "<body>/<file>" -> { sha256, blob, savedAt }). The server's data/<body>/status.json says what is current.
 *
 * syncBody(bodyId)            -> { status, resolve(name) -> url }  silent: downloads what is missing or different
 * checkUpdates(bodyId)        -> asks the server to re-query NASA (POST /api/refresh), then diffs the server
 *                                status against THIS browser's cache
 * applyUpdates(bodyId, diffs) -> downloads and stores the changed files
 * Any IndexedDB failure falls back to plain server URLs (sync) or a thrown error (check/apply).
 */
var dbp = null;
function db() {
  return dbp || (dbp = new Promise(function (res, rej) {
    try {
      var r = indexedDB.open('aira-cache', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('files'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = r.onblocked = function () { rej(r.error || new Error('IndexedDB blocked')); };
    } catch (e) { rej(e); }
  }));
}
function idb(mode, fn) {
  return db().then(function (d) {
    return new Promise(function (res, rej) {
      var t = d.transaction('files', mode), req = fn(t.objectStore('files'));
      t.oncomplete = function () { res(req.result); };
      t.onerror = t.onabort = function () { rej(t.error || new Error('IndexedDB error')); };
    });
  });
}
var get = function (key) { return idb('readonly', function (s) { return s.get(key); }); };
var put = function (key, val) { return idb('readwrite', function (s) { return s.put(val, key); }); };

var serverUrl = function (bodyId, name) { return 'data/' + bodyId + '/' + name; };

async function download(bodyId, name, sha256) {
  var r = await fetch(serverUrl(bodyId, name) + '?v=' + sha256.slice(0, 12), { cache: 'no-store' });
  if (!r.ok) throw new Error('Cannot download ' + name + ': HTTP ' + r.status);
  var rec = { sha256: sha256, blob: await r.blob(), savedAt: Date.now() };
  try { await put(bodyId + '/' + name, rec); } catch (e) { console.warn('cache write failed', e); }
  return rec;
}

async function fetchStatus(bodyId) {
  var r = await fetch(serverUrl(bodyId, 'status.json'), { cache: 'no-store' });
  if (!r.ok) throw new Error('status.json: HTTP ' + r.status);
  return r.json();
}

export async function syncBody(bodyId) {
  var urls = {}, status = null;
  var resolve = function (name) { return urls[name] || serverUrl(bodyId, name); };
  try { status = await fetchStatus(bodyId); } catch (e) { console.warn(e); return { status: null, resolve: resolve }; }
  for (var name of Object.keys(status.files || {})) {
    try {
      var rec = null;
      try { rec = await get(bodyId + '/' + name); } catch (e) { /* IndexedDB unavailable: use the server */ }
      if (!rec || rec.sha256 !== status.files[name].sha256) rec = await download(bodyId, name, status.files[name].sha256);
      urls[name] = URL.createObjectURL(rec.blob);
    } catch (e) { console.warn('cache: using server copy of ' + name, e); }
  }
  return { status: status, resolve: resolve };
}

export async function checkUpdates(bodyId) {
  var r = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: bodyId }) });
  var j = null; try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok || !j) throw new Error((j && j.error) || 'HTTP ' + r.status);
  var diffs = [];
  for (var name of Object.keys(j.status.files)) {
    var f = j.status.files[name], rec = null;
    try { rec = await get(bodyId + '/' + name); } catch (e) { throw new Error('Browser storage is unavailable (' + (e && e.message || e) + ')'); }
    if (rec && rec.sha256 === f.sha256) continue;
    diffs.push({ file: name, sha256: f.sha256, oldUrl: rec ? URL.createObjectURL(rec.blob) : null,
      newUrl: serverUrl(bodyId, name) + '?v=' + f.sha256.slice(0, 12), oldSize: rec ? rec.blob.size : null, newSize: f.size });
  }
  return { throttled: !!j.throttled, status: j.status, nextCheckAt: j.nextCheckAt, errors: j.errors || {}, diffs: diffs };
}

export async function applyUpdates(bodyId, diffs) {
  for (var d of diffs) await download(bodyId, d.file, d.sha256);
}
