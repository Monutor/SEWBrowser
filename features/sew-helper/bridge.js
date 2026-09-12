// bridge.js — адаптер SEW-Helper под SEWBrowser. ЕДИНСТВЕННЫЙ файл плагина,
// который пишем мы; lib/db-loader/background/content/css — дословные копии
// исходников Chrome-расширения (J:/Front-end-projects/AIDevelops/web-extension/SEW-Helper).
//
// Выполняется ПЕРВЫМ в IIFE плагина (см. порядок renderer в manifest.json),
// `chrome` уже задан заголовком IIFE (window.__shellChromeFor("sew-helper")) —
// здесь его только дополняем, НЕ переобъявляем. Что закрывает адаптер:
//  1. chrome.storage.session — in-memory (в webview service worker не засыпает,
//     персист очереди rate-limiter'а не нужен; shell-шим его не даёт).
//  2. chrome.cookies — заглушка []: прогрев кук делает main-сторона BFF-моста.
//  3. chrome.runtime.sendMessage — локальная шина: background.js живёт в том же
//     контексте страницы и уже висит на onMessage (shell-шим даёт addListener).
//  4. chrome.storage.local — ключи кэша картинок `mvideo:v2:*` держим ТОЛЬКО
//     в памяти: иначе 8 МБ бюджета раздули бы plugin-data/*.json на диске
//     и снапшот window.__shellPluginStores, пушимый в страницу целиком.
//  5. fetch на BFF mvideo — через host-мост window.__sewHelperBffReq/Res:
//     BFF отдаёт ACAO только https://www.mvideo.ru, из страницы SEW запрос
//     режется CORS; main-процесс (net.fetch, куки общие через default session)
//     CORS не подвержен. Остальные fetch — нативные, прозрачно.

var shbSessionMem = {};

function shbWithCb(promise, cb) {
  if (typeof cb === 'function') {
    promise.then(
      function (v) { try { cb(v); } catch (e) {} },
      function () { try { cb(); } catch (e) {} },
    );
    return;
  }
  return promise;
}

function shbNormKeys(keys) {
  if (keys === undefined || keys === null) return null;
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys.slice();
  if (typeof keys === 'object') return Object.keys(keys);
  return null;
}

// --- 0. importScripts: background.js жил в хроме service worker'ом и первой
// строкой тянет importScripts('lib.js', 'db-loader.js'). В нашем бандле оба
// файла уже склеены РАНЬШЕ (см. порядок renderer в manifest.json), поэтому
// здесь — no-op. Если background.js когда-нибудь импортирует что-то ещё,
// этот файл надо добавить в renderer манифеста раньше background.js,
// а не оживлять загрузку здесь.
function importScripts() {}

// --- 1. chrome.storage.session (in-memory) ---
chrome.storage.session = {
  get: function (keys, cb) {
    var k = shbNormKeys(keys);
    var out = {};
    if (k === null) {
      Object.keys(shbSessionMem).forEach(function (x) { out[x] = shbSessionMem[x]; });
    } else {
      k.forEach(function (x) {
        if (Object.prototype.hasOwnProperty.call(shbSessionMem, x)) out[x] = shbSessionMem[x];
      });
    }
    return shbWithCb(Promise.resolve(out), cb);
  },
  set: function (obj, cb) {
    var data = obj && typeof obj === 'object' ? obj : {};
    Object.keys(data).forEach(function (x) { shbSessionMem[x] = data[x]; });
    return shbWithCb(Promise.resolve(true), cb);
  },
  remove: function (keys, cb) {
    (shbNormKeys(keys) || []).forEach(function (x) { delete shbSessionMem[x]; });
    return shbWithCb(Promise.resolve(true), cb);
  },
};

// --- 2. chrome.cookies (заглушка) ---
chrome.cookies = {
  getAll: function () { return Promise.resolve([]); },
};

// --- 3. chrome.runtime.sendMessage (локальная шина к onMessage-слушателям) ---
chrome.runtime.sendMessage = function (msg, cb) {
  var callback = typeof cb === 'function' ? cb : function () {};
  var replied = false;
  function reply(resp) {
    if (replied) return;
    replied = true;
    try { callback(resp); } catch (e) {}
  }
  var listeners = [];
  try { listeners = window.__shellMsgListeners || []; } catch (e) { listeners = []; }
  var willAsync = false;
  listeners.slice().forEach(function (fn) {
    try {
      if (fn(msg || {}, {}, reply) === true) willAsync = true;
    } catch (e) {}
  });
  if (!willAsync && !replied) reply(undefined);
  // страховка от зависших sendResponse (у content.js свой retry поверх)
  setTimeout(function () { reply(undefined); }, 20000);
};

// --- 4. chrome.storage.local: кэш картинок — только в памяти ---
var SHB_IMG_PREFIX = 'mvideo:v2:';

function shbIsMemKey(k) {
  return typeof k === 'string' && k.indexOf(SHB_IMG_PREFIX) === 0;
}

var shbMemCache = {};
var shbRealLocal = chrome.storage.local;

chrome.storage.local = {
  get: function (keys, cb) {
    var k = shbNormKeys(keys);
    if (k !== null && k.length > 0 && k.every(shbIsMemKey)) {
      var only = {};
      k.forEach(function (x) {
        if (Object.prototype.hasOwnProperty.call(shbMemCache, x)) only[x] = shbMemCache[x];
      });
      return shbWithCb(Promise.resolve(only), cb);
    }
    var p = Promise.resolve(shbRealLocal.get(keys)).then(function (res) {
      var merged = Object.assign({}, res || {});
      if (k === null) {
        Object.keys(shbMemCache).forEach(function (x) { merged[x] = shbMemCache[x]; });
      } else {
        k.forEach(function (x) {
          if (shbIsMemKey(x) && Object.prototype.hasOwnProperty.call(shbMemCache, x)) merged[x] = shbMemCache[x];
        });
      }
      return merged;
    });
    return shbWithCb(p, cb);
  },
  set: function (obj, cb) {
    var data = obj && typeof obj === 'object' ? obj : {};
    var rest = {};
    Object.keys(data).forEach(function (x) {
      if (shbIsMemKey(x)) shbMemCache[x] = data[x];
      else rest[x] = data[x];
    });
    if (Object.keys(rest).length === 0) return shbWithCb(Promise.resolve(true), cb);
    return shbWithCb(
      Promise.resolve(shbRealLocal.set(rest)).then(function () { return true; }),
      cb,
    );
  },
  remove: function (keys, cb) {
    var list = shbNormKeys(keys) || [];
    var rest = list.filter(function (x) { return !shbIsMemKey(x); });
    list.forEach(function (x) { if (shbIsMemKey(x)) delete shbMemCache[x]; });
    if (rest.length === 0) return shbWithCb(Promise.resolve(true), cb);
    return shbWithCb(
      Promise.resolve(shbRealLocal.remove(rest)).then(function () { return true; }),
      cb,
    );
  },
};

// --- 5. fetch: BFF mvideo через host-мост, остальное — нативно ---
// var (не const): переобъявление здесь уронило бы всю IIFE, дубли исключены.
var shbNativeFetch = window.fetch.bind(window);
var SHB_BFF_PREFIX = 'https://www.mvideo.ru/bff/product-details';
var shbBffSeq = 0;

function shbBffFetch(url) {
  var id = 'b' + ++shbBffSeq + '_' + Date.now();
  try {
    window.__sewHelperBffReq = window.__sewHelperBffReq || [];
    window.__sewHelperBffReq.push({ id: id, url: String(url) });
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise(function (resolve, reject) {
    var waited = 0;
    var timer = setInterval(function () {
      waited += 250;
      var box = null;
      try { box = window.__sewHelperBffRes || null; } catch (e) { box = null; }
      if (box && Object.prototype.hasOwnProperty.call(box, id)) {
        var res = box[id];
        try { delete box[id]; } catch (e) {}
        clearInterval(timer);
        // Минимальный Response-совместимый объект: background.js читает
        // res.ok / res.status / await res.json().
        resolve({
          ok: !!(res && res.ok),
          status: res && typeof res.status === 'number' ? res.status : 0,
          json: function () { return Promise.resolve(res ? res.data : null); },
        });
        return;
      }
      if (waited >= 30000) {
        clearInterval(timer);
        reject(new Error('BFF bridge timeout'));
      }
    }, 250);
  });
}

var fetch = function (url, opts) {
  var u = typeof url === 'string' ? url : url && typeof url.url === 'string' ? url.url : '';
  if (u.indexOf(SHB_BFF_PREFIX) === 0) return shbBffFetch(u);
  return shbNativeFetch(url, opts);
};
