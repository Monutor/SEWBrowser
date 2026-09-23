// features/tasks-notify/tasks-notify.js — выполняется в IIFE плагина,
// `chrome` уже привязан к стору tasks-notify (window.__shellChromeFor).
// НЕ переобъявлять chrome. Только var/function (без const/let на верхнем уровне — файл склеивается).
var __tnBearer = null;
var __tnTimer = null;
var __tnBusy = false;

function __tnGetSettings(cb) {
  try {
    chrome.storage.local.get(['settings'], function (res) {
      var s = (res && res.settings) || {};
      cb({
        objectId: typeof s.objectId === 'string' && s.objectId ? s.objectId : 'S187',
        intervalSec: typeof s.intervalSec === 'number' && s.intervalSec >= 15 ? s.intervalSec : 60,
        sound: s.sound !== false,
      });
    });
  } catch (e) { cb({ objectId: 'S187', intervalSec: 60, sound: true }); }
}

function __tnHookAuth() {
  if (window.__tnHooked) return;
  window.__tnHooked = true;
  function grab(h) {
    try {
      if (typeof h === 'string' && h.indexOf('Bearer ') === 0) __tnBearer = h;
      else if (h && typeof h.get === 'function') {
        var v = h.get('authorization') || h.get('Authorization');
        if (typeof v === 'string' && v.indexOf('Bearer ') === 0) __tnBearer = v;
      } else if (h && typeof h === 'object') {
        var v2 = h['authorization'] || h['Authorization'];
        if (typeof v2 === 'string' && v2.indexOf('Bearer ') === 0) __tnBearer = v2;
      }
    } catch (e) {}
  }
  var origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    try {
      var u = typeof url === 'string' ? url : (url && url.url) || '';
      if (u.indexOf('/v2/api/io-relocation-bff/relocation/search') >= 0 ||
          u.indexOf('/api/io-handover-v2-bff/task') >= 0) {
        grab(opts && opts.headers);
        grab(url && url.headers);
      }
    } catch (e) {}
    return origFetch(url, opts);
  };
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    // setRequestHeader оборачиваем на уровне прототипа СРАЗУ: он всегда
    // вызывается до send, обёртка внутри send опаздывала и Bearer терялся (-> 401)
    var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (String(k).toLowerCase() === 'authorization' && String(v).indexOf('Bearer ') === 0) __tnBearer = String(v); } catch (e) {}
      return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function (m, u) { this.__tnUrl = u; return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) { return origSend.apply(this, arguments); };
  } catch (e) {}
}

function __tnSearch(settings) {
  // Сервер ждёт конверт {"requestBody": {...}} — голая внутренность даёт 400
  var body = { requestBody: {
    objectId: [settings.objectId],
    status: ['CREATED', 'IN_PROGRESS'],
    processCode: [], srcStock: [], dstStock: [], salesChannel: [],
    createTimeFrom: '', createTimeTo: '',
  } };
  var headers = { 'Content-Type': 'application/json' };
  if (__tnBearer) headers['Authorization'] = __tnBearer;
  return fetch('/v2/api/io-relocation-bff/relocation/search', {
    method: 'POST', credentials: 'include', headers: headers, body: JSON.stringify(body),
  }).then(function (r) {
    if (!r.ok) throw new Error('search http ' + r.status);
    return r.json();
  }).then(function (j) {
    var list = j && j.responseBody && j.responseBody.relocations;
    return Array.isArray(list) ? list : [];
  });
}

function __tnHandover(settings) {
  // GET с query-параметрами; строку статусов зеркалим с живой SPA (там "CREATED,%20IN_PROGRESS")
  var url = '/api/io-handover-v2-bff/task?objectId=' + encodeURIComponent(settings.objectId) + '&status=CREATED,%20IN_PROGRESS';
  var headers = {};
  if (__tnBearer) headers['Authorization'] = __tnBearer;
  return fetch(url, { method: 'GET', credentials: 'include', headers: headers }).then(function (r) {
    if (!r.ok) throw new Error('handover http ' + r.status);
    return r.json();
  }).then(function (j) {
    var list = j && j.responseBody && j.responseBody.tasks;
    return Array.isArray(list) ? list : [];
  });
}

/** TTL 7 дней + cap 2000 (общий для seen-карт перемещений и выдачи) */
function __tnTrim(seen, now) {
  var cutoff = now - 7 * 24 * 3600 * 1000;
  var keys = Object.keys(seen).filter(function (k) { return seen[k] >= cutoff; });
  keys.sort(function (a, b) { return seen[b] - seen[a]; });
  var trimmed = {};
  keys.slice(0, 2000).forEach(function (k) { trimmed[k] = seen[k]; });
  return trimmed;
}

function __tnTick() {
  if (__tnBusy) return;
  // Bearer перехватывается из запросов самой SPA; пока она ничего не послала
  // (первый тик после захода) — опрос пропускаем, иначе гарантированный 401
  if (!__tnBearer) {
    try { window.__tasksNotifyState = { lastTick: new Date().toISOString(), lastCount: 0, lastError: 'awaiting SPA auth' }; } catch (e) {}
    return;
  }
  __tnBusy = true;
  __tnGetSettings(function (st) {
    __tnSearch(st).then(function (relocs) {
      return __tnHandover(st).then(function (tasks) { return { relocs: relocs, tasks: tasks }; });
    }).then(function (both) {
      chrome.storage.local.get(['seen', 'seenHandover'], function (res) {
        var seen = (res && res.seen) || {};
        var seenHo = (res && res.seenHandover) || {};
        var baseline = !res || !res.seen;
        var baselineHo = !res || !res.seenHandover;
        var fresh = [];
        var now = Date.now();
        both.relocs.forEach(function (it) {
          var id = it && it.relocationId;
          if (typeof id !== 'number') return;
          if (!Object.prototype.hasOwnProperty.call(seen, id)) {
            seen[id] = now;
            if (!baseline) {
              var proc = (it.process && it.process.name) || 'перемещение';
              var src = (it.srcStock && it.srcStock.name) || '?';
              var dst = (it.dstStock && it.dstStock.name) || '?';
              fresh.push({ id: id, kind: 'relocation', title: 'Новое задание: ' + proc, body: '#' + id + ' · ' + src + ' → ' + dst, url: '/v2/relocation/tasks', sound: st.sound !== false });
            }
          }
        });
        both.tasks.forEach(function (it) {
          var id = it && it.taskId;
          if (typeof id !== 'number') return;
          if (!Object.prototype.hasOwnProperty.call(seenHo, id)) {
            seenHo[id] = now;
            if (!baselineHo) {
              var desc = (it.type && (it.type.description || it.type.code)) || 'выдача';
              var ord = it.orderNumber || ('#' + id);
              fresh.push({ id: id, kind: 'handover', title: 'Новая выдача: ' + desc + ' №' + ord, body: '#' + id + ' · ' + (it.status || ''), url: '/v2/handover-v2/tasks', sound: st.sound !== false });
            }
          }
        });
        chrome.storage.local.set({ seen: __tnTrim(seen, now), seenHandover: __tnTrim(seenHo, now) }, function () {
          try {
            window.__tasksNotifyReq = (window.__tasksNotifyReq || []).concat(fresh);
            window.__tasksNotifyState = { lastTick: new Date().toISOString(), lastCount: both.relocs.length + both.tasks.length, lastError: '' };
          } catch (e) {}
          __tnBusy = false;
        });
      });
    }).catch(function (e) {
      try { window.__tasksNotifyState = { lastTick: new Date().toISOString(), lastCount: -1, lastError: String((e && e.message) || e) }; } catch (x) {}
      __tnBusy = false;
    });
  });
}

(function __tnInit() {
  try {
    __tnHookAuth();
    window.__tasksNotifyReq = window.__tasksNotifyReq || [];
    window.__tasksNotifyState = window.__tasksNotifyState || { lastTick: '', lastCount: 0, lastError: '' };
    __tnGetSettings(function (st) {
      try { if (__tnTimer) clearInterval(__tnTimer); } catch (e) {}
      __tnTick();
      __tnTimer = setInterval(__tnTick, st.intervalSec * 1000);
    });
  } catch (e) {}
})();
