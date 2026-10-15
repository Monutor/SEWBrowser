// db-loader.js
// SEWBrowser: список полок больше НЕ берётся из сети. Оболочка кладёт его в
// window.__shellShelves при инжекте плагинов (локальный src/database/shelves.json
// разбирает main — у гостя нет ни диска, ни IPC). Формат: { version, zones[],
// rows[] }, где rows[i] = "индексЗоны\tячейка\tштрих полки".
//
// Второе назначение db-loader'а — индекс «ШК товара по коду товара»
// (кнопка «ШК по артикулу» в окне товара). Он, в отличие от полок, тянется из
// db.json DataBaseProducts: локальной копии базы в гостях нет, а самой базы на
// GitHub больше нет, поэтому работает только кэш plugin-data. К полкам это не
// относится: их список собирается синхронно из window.__shellShelves и от
// состояния индекса не зависит.
const BARCODE_DB_URL = 'https://raw.githubusercontent.com/Monutor/DataBaseProducts/main/db.json';
const DB_INDEX_KEY = 'barcodeDbIndex';
const DB_INDEX_BUDGET_BYTES = 4 * 1024 * 1024;
const DB_TIMEOUT_MS = 15000;
let barcodeIndex = null;
let shelfList = null;
let dbStatus = { loaded: false, error: null, loading: true };
let _dbReady = loadBarcodeDb();

// SEWBrowser: db.json в DataBaseProducts лежит gzip'ом — отдаётся как
// application/octet-stream БЕЗ заголовка Content-Encoding, поэтому браузер сам
// его не распакует и response.json() падает. Формат зафиксирован: gzip поверх
// JSON-массива, обратно переворачивать не планируем. Распаковываем нативным
// DecompressionStream по магии 1F 8B в первых двух байтах. Ветка без gzip —
// страховка на случай, если db.json пересоберут скриптом и зальют без сжатия.
// Отличие от исходного расширения SEW-Helper — правку не переносить оттуда
// дословно.
function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function parseDbBytes(bytes) {
  if (!isGzip(bytes)) return JSON.parse(new TextDecoder().decode(bytes));
  if (typeof DecompressionStream !== 'function') {
    throw new Error('db.json в gzip, но в браузере нет DecompressionStream');
  }
  dbStatus = { loaded: false, error: null, loading: true, stage: 'unpack' };
  const unpacked = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(unpacked).text());
}

async function readDbPayload(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const gzipped = isGzip(bytes);
  dbStatus = { loaded: false, error: null, loading: true, stage: 'parse' };
  console.log('[SEW-Helper] Barcode DB: ' + (gzipped ? 'gzip ' : '') + bytes.length + ' bytes');
  return await parseDbBytes(bytes);
}

/** Полки из инжекта оболочки. Список уже собран main'ом из shelves.json, здесь
 *  только разбор строк в объекты, которые ждёт комбобокс content.js.
 *  Пустой список — не повод молчать в консоль: без полок ЛП-автоматика
 *  sew-inventory не сможет выбрать ячейку. */
function readShellShelves() {
  var payload = (typeof window !== 'undefined' && window.__shellShelves) || null;
  if (!payload || !Array.isArray(payload.zones) || !Array.isArray(payload.rows)) {
    shelfList = [];
    console.warn('[SEW-Helper] Полки не получены: оболочка не положила window.__shellShelves');
    return;
  }
  var zones = payload.zones;
  var shelves = [];
  for (var i = 0; i < payload.rows.length; i++) {
    var parts = String(payload.rows[i]).split('\t');
    if (parts.length < 3) continue;
    shelves.push({ zone: zones[Number(parts[0])] || parts[0], cell: parts[1], barcode: parts[2] });
  }
  shelfList = shelves;
  console.log('[SEW-Helper] Полок получено: ' + shelves.length +
    ' (выгрузка ' + (payload.version || 'без версии') + ')');
}

readShellShelves();

async function loadBarcodeDb() {
  dbStatus = { loaded: false, error: null, loading: true };
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(function () { controller.abort(); }, DB_TIMEOUT_MS);
    const response = await fetch(BARCODE_DB_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await readDbPayload(response);
    barcodeIndex = new Map();
    for (const item of data) {
      const sku = item['Код товара'];
      const barcode = item['ШК товара'];
      if (sku && barcode) {
        barcodeIndex.set(String(sku), String(barcode));
      }
    }
    await cacheBarcodeIndex();
    dbStatus = { loaded: true, error: null, cached: false };
    console.log('[SEW-Helper] Barcode DB loaded: ' + barcodeIndex.size + ' items');
  } catch (e) {
      const cached = await chrome.storage.local.get(DB_INDEX_KEY);
      if (cached && cached[DB_INDEX_KEY]) {
        try {
          const parsed = JSON.parse(cached[DB_INDEX_KEY]);
          barcodeIndex = new Map(Object.keys(parsed.index || {}).map(function (k) { return [k, parsed.index[k]]; }));
          dbStatus = { loaded: true, error: null, cached: true };
        console.log('[SEW-Helper] Barcode DB loaded from cache: ' + barcodeIndex.size + ' items');
      } catch (parseErr) {
        dbStatus = { loaded: false, error: e.message || String(e), cached: false };
        console.warn('[SEW-Helper] Failed to load barcode DB and cache parse failed:', parseErr);
        barcodeIndex = new Map();
      }
    } else {
      dbStatus = { loaded: false, error: e.message || String(e), cached: false };
      console.warn('[SEW-Helper] Failed to load barcode DB:', e);
      barcodeIndex = new Map();
    }
  }
}

async function cacheBarcodeIndex() {
  const indexObj = {};
  for (const pair of barcodeIndex) { indexObj[pair[0]] = pair[1]; }
  // Полки в кэш не кладём: они приезжают с инжектом, а лишние ~400 записей
  // только раздували бы plugin-data на диске.
  const payload = JSON.stringify({ index: indexObj });
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

/** Список полок больше не зависит от db.json, поэтому и не ждёт его: раньше
 *  здесь стоял await на загрузку базы, и полки появлялись только после неё
 *  (а с мёртвым URL — не появлялись вовсе). */
function getShelvesWhenReady() {
  return Promise.resolve(getShelves());
}