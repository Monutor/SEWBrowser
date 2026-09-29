/**
 * Общий chrome-шим гостевой страницы: renderer инжектит его в <webview>-вкладки,
 * main — в отдельные окна страницы (вкладка, открытая в новом окне).
 */
export const CHROME_SHIM = `
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
