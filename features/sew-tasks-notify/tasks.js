// sew-tasks-notify — уведомления о новых заданиях SEW (выдача + перемещение).
// Проблема: новое задание не появляется в DOM без перезагрузки страницы,
// поэтому список опрашиваем напрямую тем же GET-запросом, которым страница
// тянет данные (URL подхватываем перехватом fetch/XHR при первом визите).
// Чистые функции внизу покрыты node:test (features/sew-tasks-notify/tasks.test.js).

/** Достать строковые id заданий из ответа API неизвестной формы. */
function sewTasksExtractIds(data) {
  var cur = data;
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    // BFF-обёртка relocation/search: { responseHeader, responseBody: { relocations } }.
    if (cur.responseBody && typeof cur.responseBody === 'object') cur = cur.responseBody;
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      var containers = ['items', 'tasks', 'data', 'content', 'list', 'rows', 'result', 'records', 'relocations'];
      for (var i = 0; i < containers.length; i++) {
        if (Array.isArray(cur[containers[i]])) {
          cur = cur[containers[i]];
          break;
        }
      }
    }
  }
  if (!Array.isArray(cur)) return [];
  var out = [];
  for (var j = 0; j < cur.length; j++) {
    var it = cur[j];
    if (it === null || it === undefined) continue;
    if (typeof it === 'string' || typeof it === 'number') {
      out.push(String(it));
      continue;
    }
    if (typeof it !== 'object') continue;
    var id = it.relocationId ?? it.id ?? it.taskId ?? it.task_id ?? it.key ?? it.number ?? it.code;
    if (id !== null && id !== undefined && id !== '') out.push(String(id));
  }
  return out;
}

/**
 * Дифф против уже виденных id. Первый вызов — тихое базовое множество
 * (уведомлений по нему нет, иначе заспамит при каждом старте). Возвращает
 * только новые id и сразу добавляет их в known.
 */
function sewTasksDiffKnown(known, ids) {  if (!(known instanceof Set)) return [];
  if (!Array.isArray(ids)) return [];
  if (known.size === 0) {
    for (var i = 0; i < ids.length; i++) known.add(ids[i]);
    return [];
  }
  var fresh = [];
  for (var j = 0; j < ids.length; j++) {
    if (!known.has(ids[j])) {
      known.add(ids[j]);
      fresh.push(ids[j]);
    }
  }
  return fresh;
}

var STN_FEED_KEYS = ['handover', 'relocation'];
var STN_URL_CAP = 5;

/** Почистить список URL: только непустые строки без дублей, кап на фид.
 * Заодно выкидывает известный мусор (app-config) — и из новых, и из ранее
 * сохранённых: чистка при каждом слиянии лечит старые plugin-data. */
function sewTasksCleanList(value) {
  if (!Array.isArray(value)) return [];
  var out = [];
  for (var i = 0; i < value.length; i++) {
    var u = value[i];
    if (typeof u !== 'string' || !u) continue;
    if (!sewTasksShouldLearn(u)) continue;
    if (out.indexOf(u) !== -1) continue;
    out.push(u);
    if (out.length >= STN_URL_CAP) break;
  }
  return out;
}

function sewTasksObjOrEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/**
 * Слияние сохранённых (диск) и выученных (перехват) эндпоинтов.
 * Чужие фиды и мусор отбрасываются — брать можно только наши два списка.
 */
function sewTasksMergeEndpoints(persisted, learned) {
  var p = sewTasksObjOrEmpty(persisted);
  var l = sewTasksObjOrEmpty(learned);
  var out = {};
  for (var i = 0; i < STN_FEED_KEYS.length; i++) {
    var feed = STN_FEED_KEYS[i];
    var union = sewTasksCleanList(p[feed]).concat(sewTasksCleanList(l[feed]));
    var dedup = [];
    for (var j = 0; j < union.length; j++) {
      if (dedup.indexOf(union[j]) === -1) dedup.push(union[j]);
      if (dedup.length >= STN_URL_CAP) break;
    }
    if (dedup.length) out[feed] = dedup;
  }
  return out;
}

/** Объект для сохранения в plugin-data (гость сам писать на диск не может). */
function sewTasksPrepareSave(learned, searchSpec) {
  var out = { endpoints: sewTasksMergeEndpoints({}, learned) };
  var search = sewTasksMergeSearch(null, searchSpec);
  if (search) out.search = { relocation: search };
  return out;
}

/** Кап тела search-запроса: фильтры страницы не должны раздувать plugin-data. */
var STN_SEARCH_BODY_CAP = 2048;

/**
 * Валидация тела relocation/search: JSON-объект ≤2КБ с непустым objectId.
 * Фильтры лежат либо на верхнем уровне ({ objectId: [...] }), либо вложены
 * в ключ requestBody ({ requestBody: { objectId: [...] } } — так шлёт сама
 * страница). Принимает строку или объект, возвращает канонический JSON
 * ИСХОДНОЙ структуры (сервер ждёт именно её) или null.
 */
function sewTasksNormalizeSearchBody(body) {
  var obj = null;
  if (typeof body === 'string') {
    if (!body || body.length > STN_SEARCH_BODY_CAP) return null;
    try {
      obj = JSON.parse(body);
    } catch (eParse) {
      return null;
    }
  } else if (body && typeof body === 'object' && !Array.isArray(body)) {
    obj = body;
  } else {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  var holder = obj;
  if (!Array.isArray(holder.objectId) && holder.requestBody && typeof holder.requestBody === 'object' && !Array.isArray(holder.requestBody)) {
    holder = holder.requestBody;
  }
  if (!Array.isArray(holder.objectId) || holder.objectId.length === 0) return null;
  var hasStore = false;
  for (var i = 0; i < holder.objectId.length; i++) {
    if (typeof holder.objectId[i] === 'string' && holder.objectId[i]) {
      hasStore = true;
      break;
    }
  }
  if (!hasStore) return null;
  var canonical = JSON.stringify(obj);
  if (!canonical || canonical.length > STN_SEARCH_BODY_CAP) return null;
  return canonical;
}

/** Проверка спека { url, body } для relocation/search. */
function sewTasksValidSearchSpec(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (!sewTasksIsRelocationSearch(spec.url)) return false;
  return sewTasksNormalizeSearchBody(spec.body) !== null;
}

/**
 * Слияние спека relocation/search: выученный бьёт сохранённый, мусор —
 * откат к сохранённому. Возвращает канонический { url, body } или null.
 */
function sewTasksMergeSearch(persisted, learned) {
  var specs = [learned, persisted];
  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    if (sewTasksValidSearchSpec(spec)) {
      return { url: spec.url, body: sewTasksNormalizeSearchBody(spec.body) };
    }
  }
  return null;
}

/**
 * Эпизод протухшей auth: первый 401/403 фида — true (показать тост),
 * повторы в том же эпизоде — false. Любой успех (2xx) закрывает эпизод.
 * state — обычный объект { feedKey: true }, переживает только сессию страницы.
 */
function sewTasksAuthNote(state, feedKey, status) {
  if (!state || typeof state !== 'object' || typeof feedKey !== 'string') return false;
  if (status === 401 || status === 403) {
    if (state[feedKey]) return false;
    state[feedKey] = true;
    return true;
  }
  if (status >= 200 && status < 300) delete state[feedKey];
  return false;
}

/**
 * relocation/search — стабильный списочный эндпоинт перемещения (POST с JSON-body).
 * Детектит абсолютный и относительный URL; деталка /relocation/<id> — не search.
 */
function sewTasksIsRelocationSearch(url) {
  if (typeof url !== 'string' || !url) return false;
  var path = url.split('?')[0].split('#')[0];
  return /\/relocation\/search\/?$/.test(path);
}

/**
 * Какие URL стоит учить как списки: app-config и прочий мусор — нет.
 * Эвристика узкая (только известный мусор), чтобы не потерять неизвестные API.
 * Деталку /relocation/<id> не учим (одиночный объект, не список, забивает кап),
 * GET на search-URL тоже (список опрашивается POST-спеком, голый GET бесполезен).
 */
function sewTasksShouldLearn(url) {
  if (typeof url !== 'string' || !url) return false;
  var path = url.split('?')[0].split('#')[0];
  if (/app-config\/?$/i.test(path)) return false;
  if (/\/relocation\/\d+(\/|$)/.test(path)) return false;
  if (sewTasksIsRelocationSearch(url)) return false;
  // Отчёты об ошибках (Sentry envelope): не списки заданий, повторять их
  // опросом нельзя. Ловим и по пути (/api/errors/, /envelope), и по маркерам
  // в query (sentry_version/sentry_key/sentry_client).
  if (/\/api\/errors\//i.test(path)) return false;
  if (/\/envelope\/?$/i.test(path)) return false;
  if (/sentry_/i.test(url)) return false;
  return true;
}

/**
 * Текст auth-тоста с самодиагностикой: перехват видит статусы запросов самой
 * страницы, наши опросы идут мимо него — по разнице видно, кто именно 401.
 * appStatus: число (последний статус запросов страницы) или null (не видели).
 */
function sewTasksAuthBody(pollStatus, appStatus) {
  var poll = pollStatus === 403 ? '403' : '401';
  if (typeof appStatus === 'number' && appStatus >= 200 && appStatus < 300) {
    return 'Запросы самой страницы: ' + appStatus + ', а наш фоновый опрос: ' + poll + '. Нажмите — обновим страницу и попробуем снова';
  }
  if (appStatus === 401 || appStatus === 403) {
    return 'Страница тоже разлогинена (' + appStatus + ') — войдите заново, затем нажмите, чтобы обновить слежку';
  }
  return 'Страница разлогинилась — нажмите, чтобы обновить и продолжить слежку';
}
/**
 * Достать Authorization из заголовков запроса страницы.
 * Форматы: plain-объект ({Authorization}), массив пар ([[k,v]]),
 * Headers-like ({get(name)}). Регистр ключа не важен. Мусор — ''.
 */
function sewTasksExtractAuth(headers) {
  if (!headers || typeof headers === 'string') return '';
  try {
    if (typeof headers.get === 'function') {
      var v = headers.get('authorization');
      if (typeof v !== 'string') v = headers.get('Authorization');
      return typeof v === 'string' && v ? v : '';
    }
  } catch (eGet) {}
  if (Array.isArray(headers)) {
    for (var i = 0; i < headers.length; i++) {
      var pair = headers[i];
      if (Array.isArray(pair) && pair.length >= 2 && typeof pair[0] === 'string') {
        if (pair[0].toLowerCase() === 'authorization' && typeof pair[1] === 'string' && pair[1]) return pair[1];
      }
    }
    return '';
  }
  if (typeof headers === 'object') {
    var keys = Object.keys(headers);
    for (var j = 0; j < keys.length; j++) {
      if (keys[j].toLowerCase() === 'authorization') {
        var val = headers[keys[j]];
        return typeof val === 'string' && val ? val : '';
      }
    }
  }
  return '';
}

/** Заголовки фонового опроса: Accept всегда, Authorization — если выучили токен. */
function sewTasksPollHeaders(auth, isPost) {
  var out = { Accept: 'application/json' };
  if (typeof auth === 'string' && auth) out.Authorization = auth;
  if (isPost === true) out['Content-Type'] = 'application/json';
  return out;
}

/**
 * Матчер URL token-эндпоинта Keycloak (стабильный, один на приложение):
 * страница получает/обновляет accessToken через него на любой странице,
 * поэтому сниффер не привязан к фидам.
 */
function sewTasksIsTokenUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  var path = url.split('?')[0].split('#')[0];
  return /openid-connect\/token\/?$/i.test(path);
}

/**
 * Достать accessToken из тела ответа token-эндпоинта (плоский JSON
 * { accessToken, refreshToken, expiresIn, ... }). Возвращает сырой JWT
 * без префикса — 'Bearer ' добавляет stnRememberAuth. Мусор — ''.
 */
function sewTasksExtractToken(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  var t = data.accessToken ?? data.access_token;
  return typeof t === 'string' && t ? t : '';
}
// node (тесты): только экспорт, браузерного bootstrap нет.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sewTasksExtractIds, sewTasksDiffKnown, sewTasksMergeEndpoints, sewTasksPrepareSave, sewTasksAuthNote, sewTasksShouldLearn, sewTasksAuthBody, sewTasksExtractAuth, sewTasksPollHeaders, sewTasksIsRelocationSearch, sewTasksNormalizeSearchBody, sewTasksMergeSearch, sewTasksIsTokenUrl, sewTasksExtractToken };
}

// Гость: bootstrap один раз на документ.
if (typeof window !== 'undefined' && window.document && !window.__sewTasksNotify) {
  window.__sewTasksNotify = true;

  var STN_FEEDS = [
    {
      key: 'handover',
      page: '/v2/handover-v2/tasks',
      title: 'Выдача: новое задание',
      url: 'https://sew.mvideoeldorado.ru/v2/handover-v2/tasks',
    },
    {
      key: 'relocation',
      page: '/v2/relocation/tasks',
      title: 'Перемещение: новое задание',
      url: 'https://sew.mvideoeldorado.ru/v2/relocation/tasks',
    },
  ];
  var STN_POLL_MS = 30000;
  var STN_KNOWN_CAP = 1000;

  // feedKey текущей страницы (null — не страница заданий, но фоновый опрос
  // выученных эндпоинтов всё равно идёт: сессия общая).
  function stnFeedOf(url) {
    for (var i = 0; i < STN_FEEDS.length; i++) {
      if (String(url).indexOf(STN_FEEDS[i].page) !== -1) return STN_FEEDS[i].key;
    }
    return null;
  }

  // Выученные GET-эндпоинты списков: feedKey -> [url]. Только same-origin GET —
  // чужие POST/мутации повторять нельзя. Стартуем с сохранённых на диске
  // (снапшот plugin-data пушится ДО кода плагинов), поэтому повторный визит
  // нужен только если адреса ещё ни разу не выучивались.
  function stnReadPersisted() {
    try {
      var stores = window.__shellPluginStores;
      if (!stores || typeof stores !== 'object') return {};
      var mine = stores['sew-tasks-notify'];
      if (!mine || typeof mine !== 'object' || Array.isArray(mine)) return {};
      return mine.endpoints;
    } catch (e0) {
      return {};
    }
  }
  var stnLearned = sewTasksMergeEndpoints(stnReadPersisted(), {});
  // Выученный спек relocation/search: один POST { url, body } вместо кучи
  // GET-деталек /relocation/<id>. Миграция не нужна: старых данных без search
  // касается только merge (null → работаем по legacy GET).
  function stnReadPersistedSearch() {
    try {
      var stores = window.__shellPluginStores;
      if (!stores || typeof stores !== 'object') return null;
      var mine = stores['sew-tasks-notify'];
      if (!mine || typeof mine !== 'object' || Array.isArray(mine)) return null;
      if (!mine.search || typeof mine.search !== 'object') return null;
      return sewTasksMergeSearch(null, mine.search.relocation);
    } catch (e0s) {
      return null;
    }
  }
  var stnSearchSpec = stnReadPersistedSearch();
  var stnKnown = {};
  // Единый Authorization (Bearer из Keycloak) на все фиды: только память
  // страницы, на диск НЕ пишем (секрет). Источники: заголовки запросов
  // страницы (fetch/XHR) и ответ стабильного token-эндпоинта
  // .../openid-connect/token (он дёргается на любой странице — хватает одного
  // визита, пер-фид привязки нет: сессия Keycloak одна на приложение).
  // Нормализация: голый JWT из token-ответа получает префикс 'Bearer '.
  var stnAuthHeader = '';
  function stnRememberAuth(value) {
    if (typeof value !== 'string' || !value) return;
    stnAuthHeader = /^bearer\s+/i.test(value) ? value : 'Bearer ' + value;
  }
  function stnLearn(feedKey, url, method, body) {
    if (!feedKey || typeof url !== 'string') return;
  // Относительные URL (без ведущего / и без origin, напр. "api/...") браузер
  // резолвит по текущей странице — легитимный вызов. Нормализуем к абсолютному
  // same-origin; чужие origins — отбрасываем.
  var resolved;
  try {
    resolved = new URL(url, window.location.href);
  } catch (eUrl) {
    return;
  }
  if (resolved.origin !== window.location.origin) return;
  url = resolved.toString();
  // DIAG-TEMP: лог всех перехваченных запросов (feed/URL/метод) — увидеть,
  // что реально ходит на странице (в т.ч. GET, которые не проходят shouldLearn),
  // чтобы понять, доходит ли /relocation/search до хука.
  try {
    if (!stnDiag.reqList) stnDiag.reqList = [];
    stnDiag.reqList.push({ f: feedKey, u: (url.split(window.location.origin) || [url]).pop(), m: String(method || 'GET') });
    while (stnDiag.reqList.length > 20) stnDiag.reqList.shift();
  } catch (eReq) {}
  // POST relocation/search: учим один спектр { url, body } (тело — фильтры
  // objectId страницы). Только relocation, остальные POST не трогаем.
    if (method && method.toUpperCase() === 'POST') {
      // DIAG-TEMP: учимся ли мы на POST (для диагностики): полный список
      // последних POST-запросов, чтобы видеть, доходит ли relocation/search.
      try {
        stnDiag.post = (stnDiag.post || 0) + 1;
        var relPostUrl = (url.split(window.location.origin) || [url]).pop();
        var isRelSearch = feedKey === 'relocation' && sewTasksIsRelocationSearch(url);
        stnDiag.postLast = { feed: feedKey, url: relPostUrl, method: String(method), isSearch: isRelSearch };
        if (!stnDiag.postList) stnDiag.postList = [];
        stnDiag.postList.push({ f: feedKey, u: relPostUrl, m: String(method), s: isRelSearch });
        while (stnDiag.postList.length > 12) stnDiag.postList.shift();
      } catch (ePost) {}
      if (feedKey === 'relocation' && sewTasksIsRelocationSearch(url)) {
        var norm = sewTasksNormalizeSearchBody(body);
        stnDiag.learn = {
          feed: 'relocation',
          url: (url.split(window.location.origin) || [url]).pop(),
          norm: norm ? 'ok' : 'null',
          bodyIs: typeof body,
          spec: stnSearchSpec ? stnSearchSpec.url.split(window.location.origin).pop() : 'none',
        };
        if (norm && (!stnSearchSpec || stnSearchSpec.body !== norm || stnSearchSpec.url !== url)) {
          stnSearchSpec = { url: url, body: norm };
          stnRequestSave();
        }
      }
      return;
    }
    if (!sewTasksShouldLearn(url)) return;
    if (method && method.toUpperCase() !== 'GET') return;
    var list = stnLearned[feedKey] || (stnLearned[feedKey] = []);
    if (list.indexOf(url) === -1 && list.length < STN_URL_CAP) {
      list.push(url);
      stnRequestSave();
    }
  }

  // Гость писать на диск не умеет (в webview нет window.shell) — кладём заявку
  // в очередь, renderer заберёт и сохранит через pluginDataSet. Очередь из
  // одного места: всегда только свежий слепок.
  function stnRequestSave() {
    try {
      window.__sewTasksDataReq = [sewTasksPrepareSave(stnLearned, stnSearchSpec)];
    } catch (eSave) {}
  }

  // Последний HTTP-статус запросов САМОЙ страницы по фиду (наши опросы идут
  // через stnNativeFetch мимо перехвата — по разнице видно, кто именно 401).
  var stnAppStatus = {};

  // Перехват fetch: учимся на GET-ответах с task-списками.
  try {
    var stnNativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : input && input.url ? input.url : '';
      var method = (init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET';
      var feedKey = stnFeedOf(window.location.href);
      stnLogReq(feedKey, u, method, init && init.headers);
      if (feedKey) stnLearn(feedKey, u, method, init && init.body);
      // Auth: заголовки запросов страницы подхватываем на любой странице
      // (сессия общая, пер-фид привязки нет).
      try {
        var a = sewTasksExtractAuth(init && init.headers) ||
          sewTasksExtractAuth(typeof input !== 'string' && input && input.headers);
        if (a) stnRememberAuth(a);
      } catch (eAuth) {}
      var isTokenUrl = sewTasksIsTokenUrl(u);
      var p = stnNativeFetch(input, init);
      // Подслушиваем ответы страницы (поведение запроса не меняем): статус —
      // для самодиагностики auth-тоста, тело token-эндпоинта — единый токен
      // (clone: оригинал уходит странице нетронутым).
      try {
        p.then(function (res) {
          try {
            if (feedKey && res && typeof res.status === 'number') stnAppStatus[feedKey] = res.status;
          } catch (eTap) {}
          try {
            if (isTokenUrl && res && res.ok && res.clone && typeof res.clone === 'function') {
              res.clone().json().then(function (data) {
                try { stnRememberAuth(sewTasksExtractToken(data)); } catch (eTok) {}
              }, function () {});
            }
          } catch (eTok2) {}
        }, function () {});
      } catch (eTap2) {}
      return p;
    };
  } catch (e) {}

  // Перехват XHR: тот же принцип (SPA на Angular часто ходит через XHR).
  // setRequestHeader ловим отдельно: токен виден только там, в open его нет.
  try {
    var stnXhrSetHeader = window.XMLHttpRequest.prototype.setRequestHeader;
    window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        // DIAG-TEMP: собираем полный набор заголовков запроса по имени —
        // кастомные (X-Api-Key и т.п.) покажут, чем POST /relocation/search
        // от страницы отличается от нашего (причина 502). Токен — глобально.
        if (typeof name === 'string' && typeof value === 'string') {
          if (!this.__stnHeaders) this.__stnHeaders = {};
          this.__stnHeaders[name.toLowerCase()] = value;
          if (name.toLowerCase() === 'authorization') stnRememberAuth(value);
        }
      } catch (eHdr) {}
      return stnXhrSetHeader.apply(this, arguments);
    };
  } catch (eHdr2) {}
  try {
    var stnXhrOpen = window.XMLHttpRequest.prototype.open;
    var stnXhrSend = window.XMLHttpRequest.prototype.send;
    // Тело POST видно только в send — доучиваем спек там (open учит GET без тела).
    window.XMLHttpRequest.prototype.send = function (body) {
      try {
        if (this.__stnFeed && this.__stnMethod && String(this.__stnMethod).toUpperCase() === 'POST') {
          stnLearn(this.__stnFeed, this.__stnUrl, this.__stnMethod, body);
        }
      } catch (eSend) {}
      // DIAG-TEMP: заголовки уже все установлены до send — фиксируем полный
      // набор запроса страницы (маскируем токен/куки). Показывает кастомные
      // заголовки POST /relocation/search, из-за которых у нас 502.
      try {
        if (this.__stnHeaders && Object.keys(this.__stnHeaders).length) {
          var snap = {};
          var hkeys = Object.keys(this.__stnHeaders);
          for (var hk = 0; hk < hkeys.length; hk++) {
            var hn = hkeys[hk];
            var hv = this.__stnHeaders[hn];
            snap[hn] = ((hn === 'authorization' || hn === 'cookie') && hv) ? '<len:' + String(hv.length) + '>' : String(hv);
          }
          if (!stnDiag.reqHdrs) stnDiag.reqHdrs = [];
          stnDiag.reqHdrs.push({ u: (this.__stnUrl.split(window.location.origin) || [this.__stnUrl]).pop(), m: String(this.__stnMethod || 'GET'), h: snap });
          while (stnDiag.reqHdrs.length > 30) stnDiag.reqHdrs.shift();
        }
      } catch (eHdrSnap) {}
      return stnXhrSend.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__stnFeed = stnFeedOf(window.location.href);
        this.__stnUrl = url;
        this.__stnMethod = method;
        stnLogReq(this.__stnFeed, url, method);
        if (this.__stnFeed) stnLearn(this.__stnFeed, url, method);
        var self = this;
        this.addEventListener('load', function () {
          try {
            if (self.__stnFeed && typeof self.status === 'number') stnAppStatus[self.__stnFeed] = self.status;
          } catch (eTap3) {}
          // Ответ token-эндпоинта (Angular ходит через XHR): единый токен.
          try {
            if (sewTasksIsTokenUrl(self.__stnUrl) && self.status >= 200 && self.status < 300 &&
                typeof self.responseText === 'string' && self.responseText) {
              stnRememberAuth(sewTasksExtractToken(JSON.parse(self.responseText)));
            }
          } catch (eTok3) {}
        });
      } catch (e2) {}
      return stnXhrOpen.apply(this, arguments);
    };
  } catch (e3) {}

  // DIAG-TEMP: состояние опросов для чтения мостом (консоль оболочки).
  var stnDiag = { feeds: {} };
  window.__sewTasksDiag = stnDiag;
  // DIAG-TEMP: безусловный лог ВСЕХ fetch/XHR-запросов вкладки (не только те
  // с feedKey) — чтобы увидеть, каким механизмом реально дёргает список.
  function stnLogReq(feedKey, url, method, headers) {
    try {
      if (!stnDiag.reqLog) stnDiag.reqLog = [];
      var authPresent = !!stnReadHdr(headers, 'authorization');
      var ct = stnReadHdr(headers, 'content-type');
      stnDiag.reqLog.push({ f: feedKey || null, u: String(url || '').split(window.location.origin).pop(), m: String(method || 'GET'), ap: authPresent, ct: ct });
      while (stnDiag.reqLog.length > 100) stnDiag.reqLog.shift();
    } catch (eReq) {}
  }
  function stnDiagSet(feedKey, patch) {
    try {
      var cur = stnDiag.feeds[feedKey] || (stnDiag.feeds[feedKey] = {});
      for (var k in patch) cur[k] = patch[k];
      cur.at = Date.now();
    } catch (eDiag) {}
  }
  // DIAG-TEMP: достать заголовок из Headers-like или plain-объекта.
  function stnReadHdr(headers, name) {
    var v = '';
    try {
      if (headers && typeof headers.get === 'function') {
        v = String(headers.get(name) || '');
      } else if (headers && typeof headers === 'object') {
        for (var k in headers) {
          if (k.toLowerCase() === name.toLowerCase()) { v = String(headers[k] || ''); break; }
        }
      }
    } catch (eH) {}
    return v;
  }

  var stnAuth = {};
  function stnQueueAuth(feed, pollStatus) {
    try {
      window.__sewTasksReq = window.__sewTasksReq || [];
      window.__sewTasksReq.push({
        feed: feed.key,
        id: 'auth',
        title: 'SEW: сессия истекла',
        body: sewTasksAuthBody(pollStatus, stnAppStatus[feed.key] ?? null),
        url: feed.url,
      });
    } catch (eAuth) {}
  }

  function stnQueue(feed, id) {
    try {
      window.__sewTasksReq = window.__sewTasksReq || [];
      window.__sewTasksReq.push({ feed: feed.key, id: id, title: feed.title, body: 'Задание ' + id, url: feed.url });
    } catch (e4) {}
  }

  // DIAG-TEMP: глубокая форма ответа (только ключи и длины, БЕЗ данных —
  // грепаем, каким контейнером реально приходит список: responseBody может
  // зваться иначе, массив может быть глубже или пустым).
  function stnShapeOfDeep(data, depth) {
    if (depth === undefined) depth = 0;
    if (data === null || data === undefined) return String(data);
    if (Array.isArray(data)) {
      var s = 'arr[' + data.length + ']';
      if (depth < 2 && data.length) s += '<' + stnShapeOfDeep(data[0], depth + 1) + '>';
      return s;
    }
    if (typeof data !== 'object') return typeof data;
    var allKeys = Object.keys(data);
    var parts = [];
    for (var i = 0; i < allKeys.length && i < 8; i++) {
      var v = data[allKeys[i]];
      if (depth < 2 && v !== null && typeof v === 'object') parts.push(allKeys[i] + ':' + stnShapeOfDeep(v, depth + 1));
      else parts.push(allKeys[i]);
    }
    if (allKeys.length > 8) parts.push('+more');
    return 'obj{' + parts.join(',') + '}';
  }
  function stnShapeOf(data) {
    try {
      var s = stnShapeOfDeep(data, 0);
      return s.length > 300 ? s.slice(0, 300) + '…' : s;
    } catch (eShape) {
      return '?';
    }
  }

  function stnPollFeed(feed) {
    // relocation/search — POST-спек, два варианта (с Bearer и без): отличить
    // причину 405 (с токеном сервер отвечает 405, без токена 200 — cookie).
    // Список заданий — ученик GET-эндпоинт (тот же, что у страницы): опрашиваем
    // с cookie (noauth, primary) + один раз с Bearer — закрыть вопрос авторизации.
    var jobs = [];
    if (feed.key === 'relocation' && stnSearchSpec) {
      jobs.push({
        url: stnSearchSpec.url,
        init: { method: 'POST', credentials: 'same-origin', body: stnSearchSpec.body, headers: sewTasksPollHeaders(stnAuthHeader, true) },
        tag: 'search-auth',
      });
      jobs.push({
        url: stnSearchSpec.url,
        init: {
          method: 'POST',
          credentials: 'same-origin',
          body: stnSearchSpec.body,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        },
        tag: 'search-noauth',
      });
    }
    var urls = stnLearned[feed.key] || [];
    for (var u = 0; u < urls.length; u++) {
      // Cookie-сессия — primary: страница ходит через неё, а Bearer может
      // возвращать 405 (так и было у search). Проверочный Bearer — один раз.
      jobs.push({
        url: urls[u],
        init: { credentials: 'same-origin', headers: { Accept: 'application/json' } },
        tag: 'list',
      });
      if (u === 0 && stnAuthHeader) {
        jobs.push({
          url: urls[u],
          init: { credentials: 'same-origin', headers: sewTasksPollHeaders(stnAuthHeader) },
          tag: 'list-auth',
        });
      }
    }
    if (jobs.length === 0) return;
    if (!stnKnown[feed.key]) stnKnown[feed.key] = new Set();
    var uniqPollUrls = [];
    for (var pu = 0; pu < jobs.length; pu++) {
      var puUrl = jobs[pu].url;
      if (uniqPollUrls.indexOf(puUrl) === -1) uniqPollUrls.push(puUrl);
    }
    // DIAG-TEMP: состав опроса + что выучено/записано — понять, есть ли GET-список.
    var diagReq = []; // DIAG-TEMP: детали джобов текущего прохода (url+method+auth+ct)
    for (var ri = 0; ri < jobs.length; ri++) {
      var rAuth = stnReadHdr(jobs[ri].init && jobs[ri].init.headers, 'authorization');
      var rCt = stnReadHdr(jobs[ri].init && jobs[ri].init.headers, 'content-type');
      diagReq.push(ri + ':' + (jobs[ri].init && jobs[ri].init.method || 'GET') + ' auth=' + (!!rAuth) + '(' + rAuth.length + ') ct=' + rCt);
    }
    stnDiagSet(feed.key, {
      urls: jobs.length,
      learnedUrls: urls.slice(),
      persisted: stnReadPersisted(),
      hasSearchSpec: !!stnSearchSpec,
      searchUrl: stnSearchSpec ? stnSearchSpec.url : null,
      searchBody: stnSearchSpec ? (stnSearchSpec.body || '').slice(0, 300) : null,
      auth: !!stnAuthHeader,
      pollUrl: jobs[0] && jobs[0].url,
      pollUrls: uniqPollUrls,
      reqDetail: diagReq,
      appStatus: stnAppStatus[feed.key] ?? null,
    }); // DIAG-TEMP
    var known = stnKnown[feed.key];
    var diagDetail = []; // DIAG-TEMP: per-URL итоги текущего прохода
    (function next(i) {
      if (i >= jobs.length) return;
      var tag = jobs[i].tag ? ' ' + jobs[i].tag : ''; // DIAG-TEMP
      stnNativeFetch(jobs[i].url, jobs[i].init)
        .then(function (res) {
          if (!res || !res.ok) {
            // Сессия протухла: один тост на эпизод (клик обновит страницу),
            // дальше молчим до успеха. Остальные ошибки — тоже молча.
            var status = res ? res.status : 0;
            diagDetail.push(i + ':' + status + tag); // DIAG-TEMP
            stnDiagSet(feed.key, { lastHttp: status, detail: diagDetail.slice() }); // DIAG-TEMP
            // DIAG-TEMP: тело ошибки (коротко) + ключевые заголовки ответа —
            // понять, ЧТО именно говорит сервер при 405/HTML (что не так в запросе).
            if (res) {
              var respHd = {};
              try {
                var stnHdrNames = ['www-authenticate', 'server', 'allow', 'content-type'];
                for (var _i = 0; _i < stnHdrNames.length; _i++) {
                  var _rk = stnHdrNames[_i];
                  try { respHd[_rk] = res.headers.get(_rk); } catch (eRK) {}
                }
                res.text().then(function (body) {
                  stnDiagSet(feed.key, {
                    lastBody: (body || '').slice(0, 400),
                    lastBodyCt: respHd['content-type'] || '',
                    lastRespHd: respHd,
                  });
                }, function () {
                  stnDiagSet(feed.key, { lastBody: '(no-body)', lastRespHd: respHd });
                });
              } catch (eBody) {
                stnDiagSet(feed.key, { lastBody: '(err reading body)', lastRespHd: respHd });
              }
            }
            if (res && status && sewTasksAuthNote(stnAuth, feed.key, status)) stnQueueAuth(feed, status);
            // Шаговик один — финальный .then ниже. Ошибочный ответ не читаем
            // res.json() (тело уже берём текстом) — не дублируем.
            return;
          }
          sewTasksAuthNote(stnAuth, feed.key, res.status);
          return res.json().then(function (data) {
            var ids = sewTasksExtractIds(data);
            var fresh = sewTasksDiffKnown(known, ids);
            diagDetail.push(i + ':' + res.status + ':ids=' + ids.length + ':' + stnShapeOf(data) + tag); // DIAG-TEMP
            stnDiagSet(feed.key, { lastHttp: res.status, lastIds: ids.length, lastFresh: fresh.length, detail: diagDetail.slice() }); // DIAG-TEMP
            for (var k = 0; k < fresh.length; k++) stnQueue(feed, fresh[k]);
            // trim: не даём множеству расти бесконечно
            if (known.size > STN_KNOWN_CAP) {
              var drop = known.size - STN_KNOWN_CAP;
              var it = known.values();
              while (drop-- > 0) known.delete(it.next().value);
            }
          }).catch(function () {
            // DIAG-TEMP: content-type отличает HTML-стену логина (text/html с 200)
            // от битого/пустого JSON. Тело не читаем (могут быть данные заданий).
            var ct = '';
            try {
              ct = (res.headers && res.headers.get('content-type')) || '';
            } catch (eCt) {}
            diagDetail.push(i + ':json-err:ct=' + ct + tag); // DIAG-TEMP
            stnDiagSet(feed.key, { lastErr: 'json', detail: diagDetail.slice() });
          }); // DIAG-TEMP
        })
        .catch(function () { diagDetail.push(i + ':net-err' + tag); stnDiagSet(feed.key, { lastErr: 'network', detail: diagDetail.slice() }); }) // DIAG-TEMP
        .then(function () { next(i + 1); });
    })(0);
  }

  function stnTick() {
    try {
      for (var i = 0; i < STN_FEEDS.length; i++) stnPollFeed(STN_FEEDS[i]);
    } catch (e5) {}
  }

  var stnTimer = setInterval(stnTick, STN_POLL_MS);
  window.addEventListener('pagehide', function () { clearInterval(stnTimer); }, { once: true });
}
