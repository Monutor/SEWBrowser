// db-loader.js
// SEWBrowser: и полки, и штрихи товара приходят в гость из оболочки — сам он
// больше ничего не качает.
//
// 1) Полки склада. Оболочка кладёт список в window.__shellShelves при инжекте
//    плагинов (локальный src/database/shelves.json разбирает main — у гостя
//    нет ни диска, ни IPC). Формат: { version, zones[], rows[] }, где
//    rows[i] = "индексЗоны\tячейка\tштрих полки".
//
// 2) Штрих товара по коду («ШК по артикулу» в окне товара). Локальный db.json
//    в распакованном виде — 116 МБ и 272 тыс. позиций; грузить его в гостя
//    нельзя (и раньше это стоило 116 МБ на КАЖДУЮ вкладку). Индекс базы живёт
//    в main (%APPDATA%/SEWBrowser/barcode-db/index.txt) и опрашивается мостом:
//    гость кладёт запрос в window.__sewHelperBarcodeReq, оболочка отвечает в
//    window.__sewHelperBarcodeRes[id]. Мост общий с BFF/сканами/остатками,
//    поэтому ответ может прийти через несколько секунд простоя — свой таймаут
//    гостя держим больше шимного (20 с не проходит, здесь ждать можно).
const BARCODE_REQ_QUEUE = '__sewHelperBarcodeReq';
const BARCODE_RES_GLOBAL = '__sewHelperBarcodeRes';
const BARCODE_TIMEOUT_MS = 30000;
const BARCODE_POLL_MS = 250;
let shelfList = null;

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

// ---------------------------------------------------------------- штрихи ----

var barcodeSeq = 0;

/** Запрос к мосту базы штрихов: ответ придёт в BARCODE_RES_GLOBAL[id] */
function askBarcodeBridge(type, sku) {
  return new Promise(function (resolve) {
    var queue = window[BARCODE_REQ_QUEUE];
    if (!Array.isArray(queue)) queue = [];
    window[BARCODE_REQ_QUEUE] = queue;
    var res = window[BARCODE_RES_GLOBAL];
    if (!res || typeof res !== 'object') {
      res = {};
      window[BARCODE_RES_GLOBAL] = res;
    }
    var id = 'b' + (++barcodeSeq) + '-' + Date.now().toString(36);
    var settled = false;
    var timer = null;
    function finish(answer) {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      try { delete res[id]; } catch (e) { res[id] = undefined; }
      resolve(answer);
    }
    // Ответ кладут в res[id] оболочка; пока его нет — опрашиваем сами: гостевой
    // setInterval Chromium душит в фоновой вкладке, а здесь вкладка активная
    // (окно товара открыто), плюс лаг ответа моста измеряется секундами.
    timer = setInterval(function () {
      if (res[id] !== undefined) finish(res[id]);
    }, BARCODE_POLL_MS);
    setTimeout(function () {
      if (settled) return;
      finish({ error: 'База штрихов не ответила за ' + Math.round(BARCODE_TIMEOUT_MS / 1000) + ' с' });
    }, BARCODE_TIMEOUT_MS);
    queue.push(sku ? { id: id, type: type, sku: String(sku) } : { id: id, type: type });
  });
}

/** Штрих товара по коду; null — в базе его нет */
async function getBarcode(sku) {
  var answer = await askBarcodeBridge('lookup', sku);
  if (answer && answer.barcode) return String(answer.barcode);
  if (answer && answer.error) console.warn('[SEW-Helper] Штрих по коду: ' + answer.error);
  return null;
}

/**
 * Состояние базы штрихов в понятных content.js словах. Статус отдаёт main, он
 * знает и про собирающийся индекс, и про «база старее файла db.json»:
 * loading — индекс собирается (первый запуск разбирает 116 МБ, это десятки
 * секунд, раньше это был fetch 15 с), cached — индекс есть, но файл базы новее.
 */
async function getDbStatus() {
  var status = await askBarcodeBridge('status');
  if (!status || typeof status !== 'object') {
    return { loaded: false, error: 'База штрихов недоступна', loading: false, cached: false };
  }
  var state = status.state;
  return {
    loaded: state === 'ready' || state === 'building',
    error: state === 'error' ? String(status.error || 'не удалось прочитать базу штрихов') : null,
    loading: state === 'building',
    cached: status.stale === true,
  };
}

/** Пересобрать индекс базы; вызывающий сам решает, когда повторить запрос */
async function reloadBarcodeDb() {
  var status = await askBarcodeBridge('reload');
  if (status && status.state === 'error') {
    console.warn('[SEW-Helper] Пересборка базы штрихов: ' + (status.error || 'ошибка'));
  }
  return status;
}

// ---------------------------------------------------------------- полки ----

function getShelves() {
  return shelfList || [];
}

/** Список полок не зависит от базы штрихов, поэтому и не ждёт её: раньше здесь
 *  стоял await на загрузку db.json, и полки появлялись только после неё
 *  (а с мёртвым URL — не появлялись вовсе). */
function getShelvesWhenReady() {
  return Promise.resolve(getShelves());
}