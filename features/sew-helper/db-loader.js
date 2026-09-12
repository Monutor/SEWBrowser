// db-loader.js
const BARCODE_DB_URL = 'https://raw.githubusercontent.com/Monutor/DataBaseProducts/main/db.json';
const DB_INDEX_KEY = 'barcodeDbIndex';
const DB_INDEX_BUDGET_BYTES = 4 * 1024 * 1024;
const DB_TIMEOUT_MS = 15000;
let barcodeIndex = null;
let shelfList = null;
let dbStatus = { loaded: false, error: null, loading: true };
let _dbReady = loadBarcodeDb();

async function loadBarcodeDb() {
  dbStatus = { loaded: false, error: null, loading: true };
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(function () { controller.abort(); }, DB_TIMEOUT_MS);
    const response = await fetch(BARCODE_DB_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    barcodeIndex = new Map();
    const shelfMap = new Map();
    for (const item of data) {
      const sku = item['Код товара'];
      const barcode = item['ШК товара'];
      if (sku && barcode) {
        barcodeIndex.set(String(sku), String(barcode));
      }
      const zone = item['Зона'];
      const cell = item['Ячейки хранения'];
      const cellBarcode = item['ШК ячейки хранения'];
      if (zone && cell && cellBarcode && !shelfMap.has(cell)) {
        shelfMap.set(cell, { zone: zone, cell: cell, barcode: String(cellBarcode) });
      }
    }
    shelfList = Array.from(shelfMap.values()).sort(function (a, b) {
      return a.zone.localeCompare(b.zone, 'ru') || a.cell.localeCompare(b.cell, 'ru');
    });
    await cacheBarcodeIndex();
    dbStatus = { loaded: true, error: null, cached: false };
    console.log('[SEW-Helper] Barcode DB loaded: ' + barcodeIndex.size + ' items, ' + shelfList.length + ' shelves');
  } catch (e) {
      const cached = await chrome.storage.local.get(DB_INDEX_KEY);
      if (cached && cached[DB_INDEX_KEY]) {
        try {
          const parsed = JSON.parse(cached[DB_INDEX_KEY]);
          barcodeIndex = new Map(Object.keys(parsed.index || {}).map(function (k) { return [k, parsed.index[k]]; }));
          shelfList = Array.isArray(parsed.shelves) ? parsed.shelves : [];
          dbStatus = { loaded: true, error: null, cached: true };
        console.log('[SEW-Helper] Barcode DB loaded from cache: ' + barcodeIndex.size + ' items');
      } catch (parseErr) {
        dbStatus = { loaded: false, error: e.message || String(e), cached: false };
        console.warn('[SEW-Helper] Failed to load barcode DB and cache parse failed:', parseErr);
        barcodeIndex = new Map();
        shelfList = [];
      }
    } else {
      dbStatus = { loaded: false, error: e.message || String(e), cached: false };
      console.warn('[SEW-Helper] Failed to load barcode DB:', e);
      barcodeIndex = new Map();
      shelfList = [];
    }
  }
}

async function cacheBarcodeIndex() {
  const indexObj = {};
  for (const pair of barcodeIndex) { indexObj[pair[0]] = pair[1]; }
  const payload = JSON.stringify({ index: indexObj, shelves: shelfList });
  if (payload.length >= DB_INDEX_BUDGET_BYTES) return;
  try {
    await chrome.storage.local.set({ [DB_INDEX_KEY]: payload });
  } catch (e) { /* noop: quota or storage unavailable */ }
}

function getDbStatus() {
  return dbStatus;
}

function reloadBarcodeDb() {
  dbStatus = { loaded: false, error: null, cached: false, loading: true };
  _dbReady = loadBarcodeDb();
  return _dbReady;
}

function getBarcode(sku) {
  if (!barcodeIndex) return null;
  return barcodeIndex.get(String(sku)) || null;
}

function getShelves() {
  return shelfList || [];
}

async function getShelvesWhenReady() {
  await _dbReady;
  return getShelves();
}