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
function sewTasksDiffKnown(known, ids) {
  if (!(known instanceof Set)) return [];
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

// node (тесты): только экспорт, браузерного bootstrap нет.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sewTasksExtractIds, sewTasksDiffKnown };
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
  // чужие POST/мутации повторять нельзя.
  var stnLearned = {};
  var stnKnown = {};
  function stnLearn(feedKey, url, method) {
    if (!feedKey || typeof url !== 'string') return;
    if (url.charAt(0) === '/' || url.indexOf(window.location.origin) === 0) {
      if (method && method.toUpperCase() !== 'GET') return;
      var list = stnLearned[feedKey] || (stnLearned[feedKey] = []);
      if (list.indexOf(url) === -1 && list.length < 5) list.push(url);
    }
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
          if (!res || !res.ok) return next(i + 1);
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
