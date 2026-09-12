importScripts('lib.js', 'db-loader.js');

const inFlight = new Map();
var _cacheCleanupScheduled = false;
let _queueRunning = 0;
const _rateLimitQueue = [];
const _resolves = new Map();
let _queueIdCounter = 0;
const MAX_CONCURRENT = 2;

async function scheduleCacheCleanup() {
  if (_cacheCleanupScheduled) return;
  _cacheCleanupScheduled = true;
  setTimeout(async function () {
    _cacheCleanupScheduled = false;
    try {
      const items = await chrome.storage.local.get(null);
      const keys = Object.keys(items);
      const now = Date.now();
      const toRemove = [];
      for (const key of keys) {
        const entry = items[key];
        if (!entry || typeof entry.ts !== 'number') continue;
        const ttl = entry.ok ? CACHE_TTL_SUCCESS_MS : CACHE_TTL_FAIL_MS;
        if (now - entry.ts >= ttl) {
          toRemove.push(key);
        }
      }
      if (toRemove.length > 0) {
        await chrome.storage.local.remove(toRemove);
      }
    } catch (e) { /* noop: storage unavailable, cleanup skipped */ }
  }, 5000);
}

async function ensureRoomFor(newEntry) {
  const newSize = estimateEntryBytes(newEntry);
  if (newSize >= CACHE_IMAGE_BUDGET_BYTES) return false;
  const items = await chrome.storage.local.get(null);
  const prefix = cacheKey('');
  const keys = Object.keys(items).filter(function (k) { return k.indexOf(prefix) === 0; }).sort(function (a, b) {
    const ta = items[a] && typeof items[a].ts === 'number' ? items[a].ts : 0;
    const tb = items[b] && typeof items[b].ts === 'number' ? items[b].ts : 0;
    return ta - tb;
  });
  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    total += estimateEntryBytes(items[keys[i]]);
  }
  while (keys.length > 0 && total + newSize > CACHE_IMAGE_BUDGET_BYTES) {
    const oldest = keys.shift();
    total -= estimateEntryBytes(items[oldest]);
    await chrome.storage.local.remove(oldest);
  }
  return total + newSize <= CACHE_IMAGE_BUDGET_BYTES;
}

async function ensureCookies(sku) {
  await fetch('https://www.mvideo.ru/products/' + encodeURIComponent(sku), {
    credentials: 'include',
    redirect: 'follow'
  });
}

async function hasMvideoCookies() {
  const cookies = await chrome.cookies.getAll({ domain: 'mvideo.ru' });
  return cookies.some(function (c) {
    return typeof c.name === 'string' && c.name.indexOf('MVID') === 0;
  });
}

function delay(min, max) {
  return new Promise(function (resolve) {
    setTimeout(resolve, min + Math.random() * (max - min));
  });
}

function enqueueFetch(sku) {
  return new Promise(function (resolve) {
    const id = ++_queueIdCounter;
    _resolves.set(id, resolve);
    _rateLimitQueue.push({ sku: sku, id: id });
    persistQueue();
    drain();
  });
}

function persistQueue() {
  chrome.storage.session.set({ _rateLimitQueue: _rateLimitQueue.map(function (item) { return { sku: item.sku, id: item.id }; }) });
}

function initQueue() {
  chrome.storage.session.get('_rateLimitQueue', function (result) {
    const items = result && result._rateLimitQueue;
    if (!items || !items.length) return;
    items.forEach(function (item) {
      const deferred = { resolve: null };
      const promise = new Promise(function (resolve) { deferred.resolve = resolve; });
      _resolves.set(item.id, deferred.resolve);
      _rateLimitQueue.push({ sku: item.sku, id: item.id });
      if (item.id > _queueIdCounter) _queueIdCounter = item.id;
    });
    drain();
    chrome.storage.session.remove('_rateLimitQueue');
  });
}

function drain() {
  if (_queueRunning >= MAX_CONCURRENT || _rateLimitQueue.length === 0) return;
  var item = _rateLimitQueue.shift();
  _queueRunning++;
  fetchBff(item.sku)
    .then(function (result) {
      var resolve = _resolves.get(item.id);
      _resolves.delete(item.id);
      if (resolve) resolve(result);
    })
    .catch(function () {
      var resolve = _resolves.get(item.id);
      _resolves.delete(item.id);
      if (resolve) resolve({ ok: false, thumb: null, all: [] });
    })
    .finally(function () { _queueRunning--; persistQueue(); drain(); });
}

async function fetchBff(sku) {
  await delay(200, 800);
  const res = await fetch(
    'https://www.mvideo.ru/bff/product-details?productId=' + encodeURIComponent(sku),
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Referer': 'https://www.mvideo.ru/products/' + encodeURIComponent(sku)
      }
    }
  );
  if (!res.ok) {
    throw new Error('BFF status ' + res.status);
  }
  const data = await res.json();
  const body = data && data.body ? data.body : null;
  const paths = body && Array.isArray(body.images) ? body.images : [];
  let name = null;
  if (body && typeof body.name === 'string' && body.name) {
    name = body.name;
  } else if (body && body.product && typeof body.product.name === 'string') {
    name = body.product.name;
  } else if (body && Array.isArray(body.products) && body.products[0] && typeof body.products[0].name === 'string') {
    name = body.products[0].name;
  }
  const set = buildImageSet(paths);
  set.name = name;
  return set;
}

async function getProductImages(sku) {
  const key = cacheKey(sku);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (entry && isCacheFresh(entry, Date.now())) {
    return { ok: entry.ok, thumb: entry.thumb, all: entry.all || [], name: entry.name || null };
  }
  if (inFlight.has(sku)) {
    return inFlight.get(sku);
  }

  const p = (async () => {
    let images;
    try {
      if (!(await hasMvideoCookies())) {
        await ensureCookies(sku);
        await delay(200, 800);
      }
      images = await enqueueFetch(sku);
    } catch (e) {
      try {
        await ensureCookies(sku);
        await delay(200, 800);
        images = await enqueueFetch(sku);
      } catch (e2) {
        images = { ok: false, thumb: null, all: [] };
      }
    }
    const result = makeResult(images);
    const entry = { ok: result.ok, thumb: result.thumb, all: result.all, name: result.name, ts: Date.now() };
    if (await ensureRoomFor(entry)) {
      try {
        await chrome.storage.local.set({ [key]: entry });
      } catch (e) { /* noop: quota or storage unavailable, result still returned */ }
    }
    scheduleCacheCleanup();
    return result;
  })();

  inFlight.set(sku, p);
  p.finally(function () {
    inFlight.delete(sku);
  });
  return p;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === 'getBarcode') {
    _dbReady.then(function () {
      sendResponse({ barcode: getBarcode(String(msg.sku)) });
    }, function () {
      sendResponse({ barcode: getBarcode(String(msg.sku)) });
    });
    return true;
  }
  if (msg.type === 'getShelves') {
    getShelvesWhenReady().then(function (shelves) {
      sendResponse({ shelves: shelves });
    });
    return true;
  }
  if (msg.type === 'getDbStatus') {
    sendResponse(getDbStatus());
    return true;
  }
  if (msg.type === 'reloadBarcodeDb') {
    reloadBarcodeDb();
    sendResponse({ ok: true });
    return true;
  }
  if (!msg || msg.type !== 'getProductImages') {
    return;
  }
  getProductImages(String(msg.sku))
    .then(function (result) {
      sendResponse(result);
    })
    .catch(function () {
      sendResponse({ ok: false, thumb: null, all: [] });
    });
  return true;
});

initQueue();
