/*
 * Browser copy of each body's data package (IndexedDB 'aira-cache', store 'files',
 * key "<body>/<file>" -> { sha256, blob, savedAt }).
 */
import { LIVE_RADIATION_BODY } from './config.js';

var dbp = null, checks = {};
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

function putSnapshot(key, val, replacedHash) {
  return db().then(function (d) {
    return new Promise(function (res, rej) {
      var t = d.transaction('files', 'readwrite'), store = t.objectStore('files'), req = store.get(key);
      req.onsuccess = function () {
        if (!req.result || (replacedHash && req.result.sha256 === replacedHash)) store.put(val, key);
      };
      t.oncomplete = function () { res(); };
      t.onerror = t.onabort = function () { rej(t.error || new Error('IndexedDB error')); };
    });
  });
}

async function normalizedBlob(name, blob) {
  if (name !== 'elev.txt' || blob.type === 'application/octet-stream') return blob;
  var text = (await blob.text()).trim();
  var binary;
  try { binary = atob(text); } catch (e) { return blob; }
  if (btoa(binary) !== text) return blob;
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/octet-stream' });
}
async function hashBlob(blob) {
  var digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}
async function record(name, sha256, blob) {
  blob = await normalizedBlob(name, blob);
  var actual = await hashBlob(blob);
  if (actual !== sha256) throw new Error('Hash mismatch for ' + name);
  return { sha256: sha256, blob: blob, savedAt: Date.now() };
}
async function getVerified(key, name) {
  var rec = await get(key);
  if (!rec) return null;
  var blob = await normalizedBlob(name, rec.blob), actual = await hashBlob(blob);
  if (actual !== rec.sha256) {
    console.warn('cache hash corrected for ' + name);
    await putSnapshot(key, { sha256: actual, blob: blob, savedAt: rec.savedAt }, rec.sha256);
    rec = await get(key);
  }
  return rec;
}
async function save(bodyId, name, sha256, blob) {
  var rec = await record(name, sha256, blob);
  await put(bodyId + '/' + name, rec);
  return rec;
}
async function download(bodyId, name, sha256) {
  var r = await fetch(serverUrl(bodyId, name) + '?v=' + sha256.slice(0, 12), { cache: 'no-store' });
  if (!r.ok) throw new Error('Cannot download ' + name + ': HTTP ' + r.status);
  var rec = await save(bodyId, name, sha256, await r.blob());
  return rec;
}
async function updateRecord(bodyId, diff) {
  var blob = diff.blob;
  if (!blob) {
    var r = await fetch(serverUrl(bodyId, diff.file) + '?v=' + diff.sha256.slice(0, 12), { cache: 'no-store' });
    if (!r.ok) throw new Error('Cannot download ' + diff.file + ': HTTP ' + r.status);
    blob = await r.blob();
  }
  return record(diff.file, diff.sha256, blob);
}
async function fetchStatus(bodyId) {
  var r = await fetch(serverUrl(bodyId, 'status.json'), { cache: 'no-store' });
  if (!r.ok) throw new Error('status.json: HTTP ' + r.status);
  return r.json();
}

// Static deployments return cached files immediately and fill IndexedDB from package responses.
export async function openCachedBody(bodyId, live) {
  var urls = {}, status = null, oldMetaHash = null;
  var resolve = function (name) { return urls[name] || serverUrl(bodyId, name); };
  try { status = await fetchStatus(bodyId); }
  catch (e) { console.warn('cache status unavailable', e); }
  var files = status && status.files || {};
  await Promise.all(Object.keys(files).map(async function (name) {
    try {
      var rec = await get(bodyId + '/' + name);
      if (rec && (!live || name !== 'meta.json' || rec.sha256 === files[name].sha256)) {
        urls[name] = URL.createObjectURL(rec.blob);
      } else if (rec && name === 'meta.json') {
        oldMetaHash = rec.sha256;
      }
    } catch (e) { console.warn('cache read failed for ' + name, e); }
  }));
  var pending = {};
  async function cacheFetched(name, response) {
    var file = files[name];
    if (!file || !response || !response.ok) return;
    try {
      var rec = await record(name, file.sha256, await response.blob());
      await putSnapshot(bodyId + '/' + name, rec, name === 'meta.json' ? oldMetaHash : null);
    }
    catch (e) { console.warn('cache write failed for ' + name, e); }
  }
  function cacheUrl(name, url) {
    if (!files[name] || url.indexOf('blob:') === 0) return;
    if (!pending[name]) pending[name] = (async function () {
      try {
        var existing = await get(bodyId + '/' + name);
        if (existing && !(name === 'meta.json' && oldMetaHash && existing.sha256 === oldMetaHash)) return;
        var response = await fetch(url);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        await cacheFetched(name, response);
      } catch (e) { console.warn('cache copy failed for ' + name, e); }
    })();
    return pending[name];
  }
  async function ensureCached() {
    await Promise.all(Object.keys(files).map(function (name) {
      return cacheUrl(name, serverUrl(bodyId, name));
    }));
  }
  return { status: status, resolve: resolve, cacheFetched: cacheFetched, cacheUrl: cacheUrl,
    ensureCached: ensureCached, get: function (name) { return get(bodyId + '/' + name); } };
}

// Local-server sync downloads the current status package before loading, retaining its existing behavior.
export async function syncBody(bodyId) {
  var urls = {}, status = null;
  var resolve = function (name) { return urls[name] || serverUrl(bodyId, name); };
  try { status = await fetchStatus(bodyId); } catch (e) { console.warn(e); return { status: null, resolve: resolve }; }
  await Promise.all(Object.keys(status.files || {}).map(async function (name) {
    try {
      var rec = null;
      try { rec = await get(bodyId + '/' + name); } catch (e) { /* IndexedDB unavailable: use the server */ }
      if (!rec || rec.sha256 !== status.files[name].sha256) rec = await download(bodyId, name, status.files[name].sha256);
      urls[name] = URL.createObjectURL(rec.blob);
    } catch (e) { console.warn('cache: using server copy of ' + name, e); }
  }));
  return { status: status, resolve: resolve };
}

var liveEndpoints = {
  'elev.txt': function (body) { return '/api/layer?body=' + encodeURIComponent(body) + '&name=elevation'; },
  'hirise.jpg': function (body) { return '/api/layer?body=' + encodeURIComponent(body) + '&name=optical'; },
  'hillshade.jpg': function (body) { return '/api/layer?body=' + encodeURIComponent(body) + '&name=hillshade'; },
  'themis.png': function (body) { return '/api/layer?body=' + encodeURIComponent(body) + '&name=thermal'; },
  'traverse.json': function (body) { return '/api/traverse?body=' + encodeURIComponent(body); }
};
function liveEndpoint(bodyId, name) {
  if (liveEndpoints[name]) return liveEndpoints[name](bodyId);
  var match = /^crism_(phy|hyd|car|tru)\.png$/.exec(name);
  if (match) return '/api/layer?body=' + encodeURIComponent(bodyId) + '&name=minerals-' + match[1];
  return null;
}

async function checkLiveUpdates(bodyId, status) {
  if (!status || !status.files) throw new Error('The deployment data status is unavailable.');
  var diffs = [], errors = {};
  var names = Object.keys(status.files).filter(function (name) { return name !== 'meta.json' && name !== 'radiation.json'; });
  if (bodyId === LIVE_RADIATION_BODY) names.push('radiation.json');
  await Promise.all(names.map(async function (name) {
    try {
      var rec = await getVerified(bodyId + '/' + name, name);
      var path = name === 'radiation.json'
        ? '/api/radiation?body=' + encodeURIComponent(bodyId)
        : liveEndpoint(bodyId, name);
      if (!path) return;
      var url = path + (rec ? '&have=' + encodeURIComponent(rec.sha256) : '');
      var response = await fetch(url, { cache: 'no-store' });
      if (response.status === 304) return;
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var sha256 = response.headers.get('X-Sha256');
      if (!sha256) throw new Error('The data service did not return a content hash.');
      var blob = await normalizedBlob(name, await response.blob());
      if (rec && rec.sha256 === sha256) return;
      diffs.push({ file: name, sha256: sha256, blob: blob,
        oldUrl: rec ? URL.createObjectURL(rec.blob) : null,
        newUrl: URL.createObjectURL(blob),
        oldSize: rec ? rec.blob.size : null, newSize: blob.size });
    } catch (e) { errors[name] = e && e.message || String(e); }
  }));
  var checkedAt = new Date().toISOString();
  var current = Object.assign({}, status, { lastCheckAt: checkedAt });
  return { throttled: false, status: current, nextCheckAt: null, errors: errors, diffs: diffs };
}

async function checkLocalUpdates(bodyId) {
  var r = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: bodyId }) });
  var j = null; try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok || !j) throw new Error((j && j.error) || 'HTTP ' + r.status);
  var diffs = [];
  for (var name of Object.keys(j.status.files)) {
    var f = j.status.files[name], rec = null;
    try { rec = await getVerified(bodyId + '/' + name, name); }
    catch (e) { throw new Error('Browser storage is unavailable (' + (e && e.message || e) + ')'); }
    if (rec && rec.sha256 === f.sha256) continue;
    diffs.push({ file: name, sha256: f.sha256, oldUrl: rec ? URL.createObjectURL(rec.blob) : null,
      newUrl: serverUrl(bodyId, name) + '?v=' + f.sha256.slice(0, 12),
      oldSize: rec ? rec.blob.size : null, newSize: f.size });
  }
  return { throttled: !!j.throttled, status: j.status, nextCheckAt: j.nextCheckAt, errors: j.errors || {}, diffs: diffs };
}

export function checkUpdates(bodyId, live, status) {
  if (checks[bodyId]) return checks[bodyId];
  var check = live ? checkLiveUpdates(bodyId, status) : checkLocalUpdates(bodyId);
  checks[bodyId] = check;
  check.then(function () { delete checks[bodyId]; }, function () { delete checks[bodyId]; });
  return check;
}

export async function applyUpdates(bodyId, diffs) {
  var records = await Promise.all(diffs.map(function (d) { return updateRecord(bodyId, d); }));
  var database = await db();
  await new Promise(function (resolve, reject) {
    var transaction = database.transaction('files', 'readwrite'), store = transaction.objectStore('files');
    diffs.forEach(function (d, index) { store.put(records[index], bodyId + '/' + d.file); });
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = function () { reject(transaction.error || new Error('IndexedDB error')); };
  });
}
