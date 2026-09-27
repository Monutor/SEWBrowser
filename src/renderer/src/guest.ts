// Скрипты, инжектимые в страницу гостя, и обёртка executeJavaScript.
// Ссылки на DOM берутся лениво (внутри функций), а не на верхнем уровне.

import { listTabs, type ShellTab } from './tabs'



const CHROME_SHIM = `
if (!window.__shellChromeShim) {
  window.__shellChromeShim = true;
  window.__shellMsgListeners = [];
  window.__chromeShimReceive = function (message) {
    (window.__shellMsgListeners || []).forEach(function (fn) {
      try { fn(message || {}, {}, function () {}); } catch (e) {}
    });
  };
  (function () {
    function normKeys(keys) {
      if (keys === undefined || keys === null) return null;
      if (typeof keys === 'string') return [keys];
      if (Array.isArray(keys)) return keys;
      if (typeof keys === 'object') return Object.keys(keys);
      return null;
    }
    function pick(all, keys) {
      var out = {};
      var src = all || {};
      if (keys === null) {
        Object.keys(src).forEach(function (k) { out[k] = src[k]; });
        return out;
      }
      keys.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
      });
      return out;
    }
    function withCallback(promise, cb) {
      if (typeof cb === 'function') {
        promise.then(
          function (v) { try { cb(v); } catch (e) {} },
          function () { try { cb(); } catch (e) {} },
        );
        return;
      }
      return promise;
    }
    function pluginName() { return window.__shellPluginName || 'default'; }
    function snapshotOf(plugin) {
      var s = window.__shellPluginStores;
      if (!s || typeof s !== 'object') return {};
      var d = s[plugin];
      return d && typeof d === 'object' ? d : {};
    }
    function hasBridge() {
      return !!(window.shell && typeof window.shell.pluginDataGet === 'function');
    }
    function storeGet(plugin, keys) {
      var k = normKeys(keys);
      if (hasBridge()) {
        return window.shell.pluginDataGet(plugin, k || undefined).then(function (all) { return pick(all, k); });
      }
      return Promise.resolve(pick(snapshotOf(plugin), k));
    }
    function storeSet(plugin, obj) {
      var data = obj && typeof obj === 'object' ? obj : {};
      try {
        var stores = window.__shellPluginStores;
        if (!stores || typeof stores !== 'object') { stores = {}; window.__shellPluginStores = stores; }
        stores[plugin] = Object.assign({}, stores[plugin], data);
      } catch (e) {}
      if (window.shell && typeof window.shell.pluginDataSet === 'function') {
        return window.shell.pluginDataSet(plugin, data);
      }
      return Promise.resolve(true);
    }
    function storeRemove(plugin, keys) {
      var list = normKeys(keys) || [];
      try {
        var stores = window.__shellPluginStores;
        if (!stores || typeof stores !== 'object') { stores = {}; window.__shellPluginStores = stores; }
        var cur = snapshotOf(plugin);
        list.forEach(function (k) { delete cur[k]; });
        stores[plugin] = cur;
      } catch (e) {}
      if (window.shell && typeof window.shell.pluginDataRemove === 'function') {
        return window.shell.pluginDataRemove(plugin, list);
      }
      return Promise.resolve(true);
    }
    // getPlugin — thunk: глобальный стор резолвит имя лениво (как раньше),
    // фабрика __shellChromeFor — привязывает имя плагина замыканием.
    function makeLocal(getPlugin) {
      function name() { return typeof getPlugin === 'function' ? getPlugin() : getPlugin; }
      return {
        get: function (keys, cb) { return withCallback(storeGet(name(), keys), cb); },
        set: function (obj, cb) { return withCallback(storeSet(name(), obj), cb); },
        remove: function (keys, cb) { return withCallback(storeRemove(name(), keys), cb); },
      };
    }
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || {};
    window.chrome.storage.local = makeLocal(pluginName);
    window.chrome.storage.onChanged = window.chrome.storage.onChanged || {
      addListener: function () {},
      removeListener: function () {},
    };
    window.chrome.runtime = window.chrome.runtime || {};
    if (typeof window.chrome.runtime.getURL !== 'function') {
      window.chrome.runtime.getURL = function (path) { return path || ''; };
    }
    // Фабрика chrome-объекта, привязанного к хранилищу конкретного плагина.
    // Нужна, т.к. window.__shellPluginName сбрасывается сразу после инжекта,
    // а отложенные вызовы (MutationObserver, обработчики событий) читали бы чужой стор.
    window.__shellChromeFor = function (name) {
      var plugin = typeof name === 'string' && name ? name : 'default';
      return {
        storage: {
          local: makeLocal(function () { return plugin; }),
          onChanged: window.chrome.storage.onChanged,
        },
        runtime: window.chrome.runtime,
      };
    };
    if (!window.chrome.runtime.onMessage || typeof window.chrome.runtime.onMessage.addListener !== 'function') {
      window.chrome.runtime.onMessage = {
        addListener: function (fn) { window.__shellMsgListeners.push(fn); },
        removeListener: function (fn) {
          window.__shellMsgListeners = window.__shellMsgListeners.filter(function (f) { return f !== fn; });
        },
      };
    }
  })();
}
`

// Перехват Ctrl+клика и средней кнопки в гостевой странице. Идемпотентно:
// повторная инъекция в ту же вкладку ничего не делает.
export const LINK_HOOK = `(function(){
  try {
    if (window.__shellLinkHook) return;
    window.__shellLinkHook = true;
    window.__shellNewTabReq = window.__shellNewTabReq || [];
    var push = function (ev) {
      try {
        if (ev.type === 'auxclick' && ev.button !== 1) return;
        if (ev.type === 'click' && !(ev.ctrlKey || ev.metaKey)) return;
        var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#') return;
        ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        window.__shellNewTabReq.push({ url: new URL(href, document.baseURI).href });
      } catch (e) {}
    };
    document.addEventListener('click', push, true);
    document.addEventListener('auxclick', push, true);
  } catch (e) {}
})()`

// Забор очереди ссылок из активной вкладки. Возвращает всегда строку —
// результат executeJavaScript обязан быть structured-cloneable.
export const LINK_TAKE = '(function(){try{var q=window.__shellNewTabReq;if(!Array.isArray(q))return "[]";try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()'

export async function injectPlugins(tab: ShellTab, plugins: PluginInfo[]): Promise<void> {
  // Снапшот данных плагинов в страницу (читает шим вместо IPC — см. комментарий
  // к CHROME_SHIM). Пушим до кода плагинов, чтобы первые чтения видели данные.
  await pushPluginStores()
  // Хост опроса: только первая вкладка забирает очередь заданий (tasks-notify),
  // иначе при N вкладках придёт N одинаковых уведомлений. Ставим ДО кода
  // плагинов — tasks-notify читает флаг на старте (__tnInit).
  try {
    await guestJS<void>(tab, 'poll-host', `window.__shellPollHost = ${tab.isPrimary ? 'true' : 'false'};`)
  } catch (err) {
    console.warn('[plugins] poll host flag failed:', err)
  }
  for (const plugin of plugins) {
    try {
      if (plugin.styles) {
        try {
          await tab.view.insertCSS(plugin.styles)
        } catch (err) {
          console.warn(`[plugins:${plugin.name}] insertCSS failed:`, err)
        }
      }
      // chrome-шим страницы (один на документ) + имя плагина для его хранилища
      await guestJS<void>(tab, 'shim', CHROME_SHIM)
      if (!plugin.code) continue
      const key = JSON.stringify(plugin.name)
      // Код плагина выполняется в гостевом try/catch: синхронный throw складываем
      // в window.__shellPluginError[name] и читаем обратно в консоль оболочки.
      // Иначе Electron пишет лишь безликое "GUEST_VIEW_MANAGER_CALL: Script
      // failed to execute" без имени плагина и текста ошибки.
      await guestJS<void>(
        tab,
        `inject:${plugin.name}`,
        `window.__shellPluginName = ${key};` +
          `window.__shellPlugins = window.__shellPlugins || {};` +
          `window.__shellPluginError = window.__shellPluginError || {};` +
          `if (!window.__shellPlugins[${key}]) {` +
          // Код выполняется в IIFE с собственным `chrome`, привязанным к стору
          // этого плагина: отложенные вызовы (наблюдатели, обработчики) видят
          // свои данные, а не 'default' (имя в __shellPluginName уже сброшено).
          `window.__shellPlugins[${key}] = 1;\n(() => {\nconst chrome = window.__shellChromeFor(${key});\ntry {\n${plugin.code}\n} catch (e) {\nwindow.__shellPluginError[${key}] = String((e && e.stack) || e);\nconsole.error('[shell-plugin:' + ${key} + ']', e);\n}\n})();}`,
      )
      try {
        const pluginErr = (await guestJS<unknown>(
          tab,
          `plugin-error:${plugin.name}`,
          `(window.__shellPluginError || {})[${key}] ?? null`,
        )) as unknown
        if (typeof pluginErr === 'string' && pluginErr) {
          console.warn(`[plugins:${plugin.name}] guest error:`, pluginErr)
        }
      } catch {
        // страница ушла между инжектом и чтением — нечего читать
      }
      if (plugin.init) {
        try {
          await guestJS<unknown>(tab, `init:${plugin.name}`, plugin.init)
        } catch (err) {
          console.warn(`[plugins:${plugin.name}] init failed:`, err)
        }
      }
    } catch (err) {
      console.warn(`[plugins:${plugin.name}] injection failed:`, err)
    }
  }
  // Сбрасываем имя плагина, чтобы чужой код не писал в чужое хранилище
  try {
    await guestJS<void>(tab, 'name-reset', 'window.__shellPluginName = null;')
  } catch {
    // страница могла уже уйти — игнорируем
  }
}


export async function pushPluginStores(): Promise<void> {
  let snapshot: Record<string, Record<string, unknown>> = {}
  try {
    snapshot = await window.shell.getAllPluginData()
  } catch (err) {
    console.warn('[shell] getAllPluginData failed:', err)
  }
  for (const tab of listTabs()) {
    try {
      await guestJS<void>(tab, 'push-stores', 'window.__shellPluginStores = ' + JSON.stringify(snapshot) + ';')
    } catch {
      // вкладка могла закрыться между listTabs() и вызовом — пропускаем
    }
  }
}


export const lastGuestErr: Record<string, string> = {}

export async function guestJS<T>(tab: ShellTab, label: string, code: string): Promise<T> {
  const key = `${tab.id}:${label}`
  try {
    return (await tab.view.executeJavaScript(code)) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (lastGuestErr[key] !== msg) {
      lastGuestErr[key] = msg
      console.warn(`[guestjs:${key}] failed:`, msg)
    }
    throw err
  }
}

export function isExternalProtocol(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol !== 'http:' && protocol !== 'https:'
  } catch {
    return false
  }
}

