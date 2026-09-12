const CACHE_TTL_SUCCESS_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_FAIL_MS = 60 * 60 * 1000;
const IMG_BASE = 'https://img.mvideo.ru';
const THUMB_WIDTH = 300;
const GALLERY_WIDTH = 600;
const CACHE_IMAGE_BUDGET_BYTES = 8 * 1024 * 1024;

function parseSku(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bSKU:\s*(\d+)/);
  return m ? m[1] : null;
}

function buildImageUrl(path, width) {
  return IMG_BASE + '/' + String(path).replace(/^\/+/, '') + '?width=' + width;
}

function buildImageSet(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { thumb: null, all: [] };
  }
  const all = paths.map(function (p) { return buildImageUrl(p, GALLERY_WIDTH); });
  return { thumb: buildImageUrl(paths[0], THUMB_WIDTH), all: all };
}

function makeResult(images) {
  const ok = images && images.thumb !== null;
  return {
    ok: !!ok,
    thumb: images ? images.thumb : null,
    all: images && Array.isArray(images.all) ? images.all : [],
    name: images && typeof images.name === 'string' ? images.name : null
  };
}

function cacheKey(sku) {
  return 'mvideo:v2:' + sku;
}

function isCacheFresh(entry, now) {
  if (!entry || typeof entry.ts !== 'number') return false;
  const ttl = entry.ok ? CACHE_TTL_SUCCESS_MS : CACHE_TTL_FAIL_MS;
  return now - entry.ts < ttl;
}

function estimateEntryBytes(entry) {
  const s = JSON.stringify(entry);
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  } catch (e) { /* noop: fallback to char length */ }
  return s.length;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseSku: parseSku,
    buildImageUrl: buildImageUrl,
    buildImageSet: buildImageSet,
    makeResult: makeResult,
    cacheKey: cacheKey,
    isCacheFresh: isCacheFresh,
    CACHE_TTL_SUCCESS_MS: CACHE_TTL_SUCCESS_MS,
    CACHE_TTL_FAIL_MS: CACHE_TTL_FAIL_MS,
    CACHE_IMAGE_BUDGET_BYTES: CACHE_IMAGE_BUDGET_BYTES,
    estimateEntryBytes: estimateEntryBytes
  };
}