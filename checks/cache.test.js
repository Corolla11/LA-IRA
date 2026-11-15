import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openCachedBody, checkUpdates, applyUpdates } from '../app/js/cache.js';
import { initRefresh } from '../app/js/refresh.js';

const records = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');
globalThis.indexedDB = {
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        createObjectStore() {},
        transaction() {
          let outstanding = 0;
          const transaction = {
            objectStore() {
              function operation(fn) {
                const request = {};
                outstanding++;
                queueMicrotask(() => {
                  request.result = fn();
                  if (request.onsuccess) request.onsuccess();
                  if (--outstanding === 0) queueMicrotask(() => transaction.oncomplete());
                });
                return request;
              }
              return {
                get(key) { return operation(() => records.get(key)); },
                put(value, key) { return operation(() => records.set(key, value)); }
              };
            }
          };
          return transaction;
        }
      };
      request.onupgradeneeded();
      request.onsuccess();
    });
    return request;
  }
};

test('updates retain their hashes after reopening and unchanged files use 304', async () => {
  const body = 'mars', old = 'old traverse', changed = 'new traverse';
  const status = { files: { 'traverse.json': { sha256: sha(old), size: old.length } } };
  const calls = [];
  let latest = changed;
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(url);
    if (url.endsWith('status.json')) return Response.json(status);
    if (url.startsWith('/api/radiation')) return new Response(null, { status: 304 });
    if (url.startsWith('/api/traverse')) {
      if (url.includes('have=' + sha(latest))) return new Response(null, { status: 304 });
      return new Response(latest, { headers: { 'X-Sha256': sha(latest) } });
    }
    if (url.startsWith('blob:')) return previous(url);
    throw new Error('Unexpected request: ' + url);
  };
  try {
    let cache = await openCachedBody(body, true);
    await cache.cacheFetched('traverse.json', new Response(old));
    const first = checkUpdates(body, true, status);
    const concurrent = checkUpdates(body, true, status);
    assert.equal(first, concurrent);
    const result = await first;
    assert.equal(result.diffs.length, 1);
    assert.equal(calls.filter(url => url.startsWith('/api/traverse')).length, 1);
    assert.equal(calls.filter(url => url.startsWith('/api/radiation?body=mars')).length, 1);
    await applyUpdates(body, result.diffs);

    cache = await openCachedBody(body, true);
    assert.equal(await (await fetch(cache.resolve('traverse.json'))).text(), changed);
    await cache.cacheFetched('traverse.json', new Response(old));
    await cache.ensureCached();
    assert.equal(records.get(body + '/traverse.json').sha256, sha(changed));
    records.get(body + '/traverse.json').sha256 = sha(old);
    const next = await checkUpdates(body, true, status);
    assert.equal(next.diffs.length, 0);
    assert.equal(records.get(body + '/traverse.json').sha256, sha(changed));
    assert.ok(calls.some(url => url.includes('have=' + sha(changed))));
  } finally { globalThis.fetch = previous; }
});

test('live radiation checks run only for Mars and report actual failures', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    if (url.startsWith('/api/radiation?body=mars')) return new Response(null, { status: 502 });
    throw new Error('Unexpected request: ' + url);
  };
  try {
    const status = { files: {} };
    const moon = await checkUpdates('moon', true, status);
    assert.deepEqual(moon.errors, {});
    assert.deepEqual(moon.diffs, []);
    assert.deepEqual(calls, []);
    const mars = await checkUpdates('mars', true, status);
    assert.deepEqual(mars.errors, { 'radiation.json': 'HTTP 502' });
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = previous; }
});

test('local cached data stays unchanged until applying verified updates', async () => {
  const body = 'cache-test-local', old = 'old image', changed = 'new image';
  let status = { files: { 'hirise.jpg': { sha256: sha(old), size: old.length } } };
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    if (url.endsWith('status.json')) return Response.json(status);
    if (url === '/api/refresh') return Response.json({ status, errors: {}, throttled: false });
    if (url.startsWith('data/' + body + '/hirise.jpg')) return new Response(changed);
    return previous(url);
  };
  try {
    let cache = await openCachedBody(body, false);
    await cache.cacheFetched('hirise.jpg', new Response(old));
    status = { files: { 'hirise.jpg': { sha256: sha(changed), size: changed.length } } };
    cache = await openCachedBody(body, false);
    assert.equal(await (await fetch(cache.resolve('hirise.jpg'))).text(), old);
    const result = await checkUpdates(body, false, status);
    assert.equal(result.diffs.length, 1);
    await applyUpdates(body, result.diffs);
    cache = await openCachedBody(body, false);
    assert.equal(await (await fetch(cache.resolve('hirise.jpg'))).text(), changed);
    await assert.rejects(applyUpdates(body, [
      { file: 'hirise.jpg', sha256: sha(old), blob: new Blob([old]) },
      { file: 'hillshade.jpg', sha256: sha('wrong'), blob: new Blob(['bad']) }
    ]), /Hash mismatch/);
    assert.equal(records.get(body + '/hirise.jpg').sha256, sha(changed));
  } finally { globalThis.fetch = previous; }
});

test('applying a real-sized base64 elevation file stores the decoded data', async () => {
  const body = 'cache-test-elevation', bytes = Buffer.alloc(4_000_000, 42);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes.toString('base64'), { headers: { 'Content-Type': 'text/plain' } });
  try {
    await applyUpdates(body, [{ file: 'elev.txt', sha256: sha(bytes) }]);
    const rec = records.get(body + '/elev.txt');
    assert.equal(rec.blob.size, bytes.length);
    assert.equal(rec.sha256, sha(bytes));
  } finally { globalThis.fetch = previous; }
});

test('background and manual checks share one request, and Apply saves and resumes', async () => {
  const bodyId = 'cache-test-dialog', old = 'old traverse', changed = 'new traverse';
  let status = { files: { 'traverse.json': { sha256: sha(old), size: old.length } } };
  const previous = { fetch: globalThis.fetch, document: globalThis.document,
    sessionStorage: globalThis.sessionStorage, location: globalThis.location, setInterval: globalThis.setInterval };
  let requests = 0, release, reloaded = false, resumed;
  const waiting = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async url => {
    if (url.endsWith('status.json')) return Response.json(status);
    if (url === '/api/refresh') {
      requests++;
      return Response.json({ status, errors: {}, throttled: false });
    }
    if (url.startsWith('data/' + bodyId + '/traverse.json')) return new Response(changed);
    return previous.fetch(url);
  };
  const makeElement = () => ({
    textContent: '', hidden: false, disabled: false, listeners: {}, classList: { toggle() {} },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    replaceChildren() {}, append() {}, focus() {}, querySelectorAll() { return []; }
  });
  const elements = Object.fromEntries(['btnUpdate', 'refreshDlg', 'refreshBody', 'refreshMsg',
    'refreshApply', 'refreshClose', 'dataTime'].map(id => [id, makeElement()]));
  globalThis.document = { querySelector: selector => elements[selector.slice(1)], createElement: makeElement };
  globalThis.sessionStorage = { setItem(key, value) { resumed = JSON.parse(value); } };
  globalThis.location = { reload() { reloaded = true; } };
  globalThis.setInterval = () => 0;
  try {
    const cache = await openCachedBody(bodyId, false);
    await cache.cacheFetched('traverse.json', new Response(old));
    status = { lastCheckAt: null, lastChangeAt: null,
      files: { 'traverse.json': { sha256: sha(changed), size: changed.length } } };
    initRefresh(bodyId, status, { layers: {} }, false, () => waiting);
    assert.match(elements.dataTime.textContent, /checking for updates/);
    elements.btnUpdate.listeners.click();
    release();
    for (let i = 0; i < 50 && elements.refreshApply.hidden; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(requests, 1);
    assert.equal(elements.refreshApply.hidden, false);
    await elements.refreshApply.listeners.click();
    assert.equal(records.get(bodyId + '/traverse.json').sha256, sha(changed));
    assert.equal(resumed.bodyId, bodyId);
    assert.equal(reloaded, true);
  } finally { Object.assign(globalThis, previous); }
});
