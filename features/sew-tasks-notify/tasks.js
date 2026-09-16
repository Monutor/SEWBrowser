// sew-tasks-notify — уведомления о новых заданиях SEW (выдача + перемещение).
// Проблема: новое задание не появляется в DOM без перезагрузки страницы,
// поэтому список опрашиваем напрямую тем же GET-запросом, которым страница
// тянет данные (URL подхватываем перехватом fetch/XHR при первом визите).
// Чистые функции внизу покрыты node:test (features/sew-tasks-notify/tasks.test.js).

/** Достать строковые id заданий из ответа API неизвестной формы. */
function sewTasksExtractIds(data) {
  var cur = data;
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    var containers = ['items', 'tasks', 'data', 'content', 'list', 'rows', 'result', 'records'];
    for (var i = 0; i < containers.length; i++) {
      if (Array.isArray(cur[containers[i]])) {
        cur = cur[containers[i]];
        break;
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
    var id = it.id ?? it.taskId ?? it.task_id ?? it.key ?? it.number ?? it.code;
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
function sewTasksPrepareSave(learned) {
  return { endpoints: sewTasksMergeEndpoints({}, learned) };
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
 * Какие URL стоит учить как списки: app-config и прочий мусор — нет.
 * Эвристика узкая (только известный мусор), чтобы не потерять неизвестные API.
 */
function sewTasksShouldLearn(url) {
  if (typeof url !== 'string' || !url) return false;
  var path = url.split('?')[0].split('#')[0];
  if (/app-config\/?$/i.test(path)) return false;
  return true;
}
// node (тесты): только экспорт, браузерного bootstrap нет.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sewTasksExtractIds, sewTasksDiffKnown, sewTasksMergeEndpoints, sewTasksPrepareSave, sewTasksAuthNote, sewTasksShouldLearn };
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
  var stnKnown = {};
  function stnLearn(feedKey, url, method) {
    if (!feedKey || typeof url !== 'string') return;
    if (!sewTasksShouldLearn(url)) return;
    if (url.charAt(0) === '/' || url.indexOf(window.location.origin) === 0) {
      if (method && method.toUpperCase() !== 'GET') return;
      var list = stnLearned[feedKey] || (stnLearned[feedKey] = []);
      if (list.indexOf(url) === -1 && list.length < STN_URL_CAP) {
        list.push(url);
        stnRequestSave();
      }
    }
  }

  // Гость писать на диск не умеет (в webview нет window.shell) — кладём заявку
  // в очередь, renderer заберёт и сохранит через pluginDataSet. Очередь из
  // одного места: всегда только свежий слепок.
  function stnRequestSave() {
    try {
      window.__sewTasksDataReq = [sewTasksPrepareSave(stnLearned)];
    } catch (eSave) {}
  }

  // Перехват fetch: учимся на GET-ответах с task-списками.
  try {
    var stnNativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : input && input.url ? input.url : '';
      var method = (init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET';
      var feedKey = stnFeedOf(window.location.href);
      if (feedKey) stnLearn(feedKey, u, method);
      return stnNativeFetch(input, init);
    };
  } catch (e) {}

  // Перехват XHR: тот же принцип (SPA на Angular часто ходит через XHR).
  try {
    var stnXhrOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__stnFeed = stnFeedOf(window.location.href);
        this.__stnUrl = url;
        this.__stnMethod = method;
        if (this.__stnFeed) stnLearn(this.__stnFeed, url, method);
      } catch (e2) {}
      return stnXhrOpen.apply(this, arguments);
    };
  } catch (e3) {}

  var stnAuth = {};
  function stnQueueAuth(feed) {
    try {
      window.__sewTasksReq = window.__sewTasksReq || [];
      window.__sewTasksReq.push({
        feed: feed.key,
        id: 'auth',
        title: 'SEW: сессия истекла',
        body: 'Страница разлогинилась — нажмите, чтобы обновить и продолжить слежку',
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

  function stnPollFeed(feed) {
    var urls = stnLearned[feed.key] || [];
    if (urls.length === 0) return;
    if (!stnKnown[feed.key]) stnKnown[feed.key] = new Set();
    var known = stnKnown[feed.key];
    (function next(i) {
      if (i >= urls.length) return;
      stnNativeFetch(urls[i], { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (!res || !res.ok) {
            // Сессия протухла: один тост на эпизод (клик обновит страницу),
            // дальше молчим до успеха. Остальные ошибки — тоже молча.
            if (res && sewTasksAuthNote(stnAuth, feed.key, res.status)) stnQueueAuth(feed);
            return next(i + 1);
          }
          sewTasksAuthNote(stnAuth, feed.key, res.status);
          return res.json().then(function (data) {
            var fresh = sewTasksDiffKnown(known, sewTasksExtractIds(data));
            for (var k = 0; k < fresh.length; k++) stnQueue(feed, fresh[k]);
            // trim: не даём множеству расти бесконечно
            if (known.size > STN_KNOWN_CAP) {
              var drop = known.size - STN_KNOWN_CAP;
              var it = known.values();
              while (drop-- > 0) known.delete(it.next().value);
            }
          }).catch(function () {});
        })
        .catch(function () {})
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
