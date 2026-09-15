import './styles.css'

const webview = document.getElementById('site') as unknown as SewWebViewElement
const addressInput = document.getElementById('address') as HTMLInputElement | null
const statusEl = document.getElementById('status') as HTMLElement | null
const toastEl = document.getElementById('toast') as HTMLElement | null
const toolbar = document.getElementById('toolbar') as HTMLElement | null

// Поиск по странице
const findbar = document.getElementById('findbar') as HTMLElement | null
const findInput = document.getElementById('find-input') as HTMLInputElement | null
const findCount = document.getElementById('find-count') as HTMLElement | null
let findActive = false

// Оверлей ошибки сети
const errorOverlay = document.getElementById('error-overlay') as HTMLElement | null
const errorText = document.getElementById('error-text') as HTMLElement | null

// Настройки
const settingsOverlay = document.getElementById('settings-overlay') as HTMLElement | null
const setStartUrl = document.getElementById('set-starturl') as HTMLInputElement | null
const setAllowlistEnabled = document.getElementById('set-allowlist-enabled') as HTMLInputElement | null
const setAllowlist = document.getElementById('set-allowlist') as HTMLTextAreaElement | null
const setPlugins = document.getElementById('set-plugins') as HTMLElement | null
const setStorageUsage = document.getElementById('set-storage-usage') as HTMLElement | null
const setCookies = document.getElementById('set-cookies') as HTMLElement | null
const setClearOnExit = document.getElementById('set-clear-on-exit') as HTMLSelectElement | null
const setScannerApp = document.getElementById('set-scanner-app') as HTMLInputElement | null
const setScannerArgs = document.getElementById('set-scanner-args') as HTMLInputElement | null
const setScannerAppBrowse = document.getElementById('set-scanner-app-browse') as HTMLButtonElement | null
const setScanFolderAdd = document.getElementById('set-scan-folder-add') as HTMLButtonElement | null
const setScanFoldersList = document.getElementById('set-scan-folders') as HTMLElement | null

// Загрузки
const downloadsEl = document.getElementById('downloads') as HTMLElement | null
const downloadsOverlay = document.getElementById('downloads-overlay') as HTMLElement | null
const downloadsHistory = document.getElementById('downloads-history') as HTMLElement | null
const downloadsFilter = document.getElementById('downloads-filter') as HTMLSelectElement | null
let downloadsOpen = false
let downloadsRecords: DownloadedFile[] = []

const templatesOverlay = document.getElementById('templates-overlay') as HTMLElement | null
const templatesList = document.getElementById('templates-list') as HTMLElement | null
const templatesManageOverlay = document.getElementById('templates-manage-overlay') as HTMLElement | null
let templatesOpen = false
let templatesManageOpen = false

// Вкладки навигации
const tabstrip = document.getElementById('tabstrip') as HTMLElement | null
const tabsEl = document.getElementById('tabs') as HTMLElement | null
const tabsOverlay = document.getElementById('tabs-overlay') as HTMLElement | null
const tabsList = document.getElementById('tabs-list') as HTMLElement | null
const tabForm = document.getElementById('tab-form') as HTMLElement | null
const tabNameInput = document.getElementById('tab-name') as HTMLInputElement | null
const tabUrlInput = document.getElementById('tab-url') as HTMLInputElement | null
const tabsExport = document.getElementById('tabs-export') as HTMLElement | null
const tabsImport = document.getElementById('tabs-import') as HTMLElement | null
const tabsImportFile = document.getElementById('tabs-import-file') as HTMLInputElement | null
let editingTabId: string | null = null
let tabsOpen = false

let config: ShellConfig | null = null
let plugins: PluginInfo[] = []
/** Все плагины (включая выключенные) — для настроек */
let allPlugins: { name: string; enabled: boolean }[] = []
let isFullscreen = false

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/** Логика совпадает с allowlist в конфиге (проверка синхронная, в will-navigate) */
function isAllowed(url: string): boolean {
  if (!config || !config.allowlistEnabled) return true
  const host = hostOf(url)
  if (!host) return false
  if (!Array.isArray(config.allowlist)) return false
  return config.allowlist.some((pattern) => {
    const p = pattern.toLowerCase()
    if (p.startsWith('*.')) {
      const domain = p.slice(2)
      return host === domain || host.endsWith(`.${domain}`)
    }
    return host === p
  })
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Статус пишется в настройки; разовые подсказки (toast=true) дополнительно
 * всплывают тостом справа внизу на 3.5 c. Технический счётчик (polling)
 * идёт с toast=false, чтобы не спамить.
 */
function setStatus(text: string, toast = true): void {
  if (statusEl) statusEl.textContent = text
  if (!toast || !toastEl || !text) return
  toastEl.textContent = text
  toastEl.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.hidden = true
  }, 3500)
}

/**
 * Минимальный window.chrome для перенесённых content-скриптов Chrome-расширений.
 * storage.local — из снапшота window.__shellPluginStores, который оболочка пушит
 * в страницу при инжекте и обновляет при изменениях: у <webview> НЕТ preload,
 * поэтому window.shell в гостевой странице отсутствует и IPC оттуда недоступен
 * (данные плагинов — шаблоны и т.п., несекретные; credentials/куки/конфиг таким
 * путём не отдаются вообще). Запись — в снапшот + оппортунистически в IPC.
 * Сообщения от оболочки — через window.__chromeShimReceive (fan-out по onMessage).
 * Имя текущего плагина loader кладёт в window.__shellPluginName перед его кодом.
 */
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

async function injectPlugins(): Promise<void> {
  // Снапшот данных плагинов в страницу (читает шим вместо IPC — см. комментарий
  // к CHROME_SHIM). Пушим до кода плагинов, чтобы первые чтения видели данные.
  await pushPluginStores()
  for (const plugin of plugins) {
    try {
      if (plugin.styles) {
        try {
          await webview.insertCSS(plugin.styles)
        } catch (err) {
          console.warn(`[plugins:${plugin.name}] insertCSS failed:`, err)
        }
      }
      // chrome-шим страницы (один на документ) + имя плагина для его хранилища
      await guestJS<void>('shim', CHROME_SHIM)
      if (!plugin.code) continue
      const key = JSON.stringify(plugin.name)
      // Код плагина выполняется в гостевом try/catch: синхронный throw складываем
      // в window.__shellPluginError[name] и читаем обратно в консоль оболочки.
      // Иначе Electron пишет лишь безликое "GUEST_VIEW_MANAGER_CALL: Script
      // failed to execute" без имени плагина и текста ошибки.
      await guestJS<void>(
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
          await guestJS<unknown>(`init:${plugin.name}`, plugin.init)
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
    await guestJS<void>('name-reset', 'window.__shellPluginName = null;')
  } catch {
    // страница могла уже уйти — игнорируем
  }
}

/** Забрать снапшот данных всех плагинов из main и положить в гостевую страницу */
async function pushPluginStores(): Promise<void> {
  let snapshot: Record<string, Record<string, unknown>> = {}
  try {
    snapshot = await window.shell.getAllPluginData()
  } catch (err) {
    console.warn('[shell] getAllPluginData failed:', err)
  }
  try {
    await guestJS<void>('push-stores', 'window.__shellPluginStores = ' + JSON.stringify(snapshot) + ';')
  } catch {
    // страница не готова — игнорируем
  }
}

/**
 * BFF-мост для sew-helper: гость складывает запросы в window.__sewHelperBffReq,
 * оболочка забирает их (splice — атомарно), ходит в main через netFetch
 * (net.fetch: без CORS, куки общие с webview через default session) и кладёт
 * ответы в window.__sewHelperBffRes[id]. Опрос каждые 500 мс, только если
 * плагин загружен.
 */
/** Именованный вызов гостя: при reject пишет КАКОЙ вызов упал и с чем.
 *  Без этого безликий "GUEST_VIEW_MANAGER_CALL: ..." не даёт понять виновника.
 *  Повторы с тем же текстом глушим (дедуп по label), исключение пробрасываем. */
const lastGuestErr: Record<string, string> = {}
async function guestJS<T>(label: string, code: string): Promise<T> {
  try {
    return (await webview.executeJavaScript(code)) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (lastGuestErr[label] !== msg) {
      lastGuestErr[label] = msg
      console.warn(`[guestjs:${label}] failed:`, msg)
    }
    throw err
  }
}

let sewHelperBridgeStarted = false
let bffTakeDiagged = false
/** Адаптивный опрос: 500мс при работе, до 2000мс в простое + пауза когда окно скрыто */
let bffDelay = 500
let bffBusy = false
function startSewHelperBridge(): void {
  if (sewHelperBridgeStarted) return
  sewHelperBridgeStarted = true
  const tick = (): void => {
    if (document.hidden) {
      bffDelay = 2000
      setTimeout(tick, bffDelay)
      return
    }
    if (!bffBusy) {
      bffBusy = true
      void pumpSewHelperBff()
        .then((hadWork) => {
          bffDelay = hadWork ? 500 : Math.min(2000, bffDelay + 250)
        })
        .catch(() => {
          bffDelay = Math.min(2000, bffDelay + 250)
        })
        .finally(() => {
          bffBusy = false
        })
    }
    setTimeout(tick, bffDelay)
  }
  setTimeout(tick, 500)
}

async function pumpSewHelperBff(): Promise<boolean> {
  try {
    if (!plugins.some((p) => p.name === 'sew-helper')) return false
    // Гостевая часть — полностью неубиваемая (вложенные try/catch): reject
    // executeJavaScript Electron всегда дублирует внутренним логом
    // "GUEST_VIEW_MANAGER_CALL: ...", поэтому гость не должен кидать
    // в принципе.
    // take возвращает JSON-СТРОКУ (structured clone результата падает на
    // объектах только в экзотике, строка — всегда безопасна). КРИТИЧНО:
    // IIFE обязана заканчиваться `()()` — голая `(function(){...})` без вызова
    // возвращает сам объект функции, а он неклонируем:
    // "GUEST_VIEW_MANAGER_CALL: An object could not be cloned" (ловушка 17).
    const rawTake = await guestJS<string>(
      'bff-take',
      '(function(){try{var q=window.__sewHelperBffReq;if(!Array.isArray(q))return "[]";' +
        'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
    ).catch((err) => {
      // take возвращает строку во всех ветках — клон здесь ни при чём.
      // Фиксируем состояние ГЕСТА (синхронные хост-вызовы, без клона),
      // чтобы понять, в какой момент падает invoke. Однократно.
      if (!bffTakeDiagged) {
        bffTakeDiagged = true
        try {
          console.warn(
            `[guestjs:bff-take] guest state: url=${webview.getURL()} loading=${webview.isLoading()} crashed=${webview.isCrashed()}`,
          )
        } catch {
          // ignore
        }
      }
      throw err
    })
    let reqs: Array<{ id: string; url: string }> = []
    try {
      const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
      if (Array.isArray(parsed)) reqs = parsed as Array<{ id: string; url: string }>
    } catch {
      reqs = []
    }
    if (!Array.isArray(reqs) || reqs.length === 0) return false
    for (const req of reqs) {
      if (!req || typeof req.id !== 'string' || typeof req.url !== 'string') continue
      let res: { ok: boolean; status: number; data: unknown }
      try {
        res = await window.shell.netFetch(req.url)
      } catch {
        res = { ok: false, status: 0, data: null }
      }
      try {
        await guestJS<boolean>(
          'bff-write',
          '(function(id,payload){try{(window.__sewHelperBffRes = window.__sewHelperBffRes || {})[id]=payload;return true}catch(e){return false}})' +
            '(' +
            JSON.stringify(req.id) +
            ',' +
            JSON.stringify(res ?? { ok: false, status: 0, data: null }) +
            ')',
        )
      } catch {
        // страница ушла между опросом и ответом — гость повторит запрос сам (retry)
      }
    }
    return true
  } catch {
    // webview не готов — молча ждём следующего тика
    return false
  }
}

/**
 * Мост для в-page блока «Сканы»: гость складывает запросы в
 * window.__sewScansReq, оболочка забирает их (splice — атомарно) и ходит в main
 * через window.shell.* (у гостя нет window.shell, поэтому мост — в renderer).
 * Ответи кладём в window.__sewScansRes[id] как JSON-СТРОКУ (structured clone
 * падает на объектах; строка безопасна). IIFE ОБЯЗАТНО заканчивается `()()`
 * (ловушка 17: голая `(function(){...})` без вызова не клонируется → GUEST_VIEW_MANAGER_CALL).
 */
let scansBridgeStarted = false
let scansTakeDiagged = false
/** Тот же адаптивный опрос, что у BFF-моста: быстро при работе, медленно в простое */
let scansDelay = 500
let scansBusy = false
function startScansBridge(): void {
  if (scansBridgeStarted) return
  scansBridgeStarted = true
  const tick = (): void => {
    if (document.hidden) {
      scansDelay = 2000
      setTimeout(tick, scansDelay)
      return
    }
    if (!scansBusy) {
      scansBusy = true
      void pumpScansBridge()
        .then((hadWork) => {
          scansDelay = hadWork ? 500 : Math.min(2000, scansDelay + 250)
        })
        .catch(() => {
          scansDelay = Math.min(2000, scansDelay + 250)
        })
        .finally(() => {
          scansBusy = false
        })
    }
    setTimeout(tick, scansDelay)
  }
  setTimeout(tick, 500)
}

async function pumpScansBridge(): Promise<boolean> {
  try {
    if (!plugins.some((p) => p.name === 'scans-block')) return false
    const rawTake = await guestJS<string>(
      'scans-take',
      '(function(){try{var q=window.__sewScansReq;if(!Array.isArray(q))return "[]";' +
        'try{return JSON.stringify(q.splice(0))}catch(e){return "[]"}}catch(e){return "[]"}})()',
    ).catch((err) => {
      if (!scansTakeDiagged) {
        scansTakeDiagged = true
        try {
          console.warn(
            `[guestjs:scans-take] guest state: url=${webview.getURL()} loading=${webview.isLoading()} crashed=${webview.isCrashed()}`,
          )
        } catch {
          // ignore
        }
      }
      throw err
    })
    let reqs: Array<{ id: string; type: string; payload?: unknown }> = []
    try {
      const parsed: unknown = JSON.parse(typeof rawTake === 'string' ? rawTake : '[]')
      if (Array.isArray(parsed)) reqs = parsed as Array<{ id: string; type: string; payload?: unknown }>
    } catch {
      reqs = []
    }
    if (!Array.isArray(reqs) || reqs.length === 0) return false
    for (const req of reqs) {
      if (!req || typeof req.id !== 'string' || typeof req.type !== 'string') continue
      let result: unknown
      try {
        switch (req.type) {
          case 'list':
            result = await window.shell.listScans()
            break
          case 'read':
            result = typeof req.payload === 'string' ? await window.shell.readScanFile(req.payload) : null
            break
          case 'launch':
            result = await window.shell.launchScannerApp()
            break
          case 'pick':
            result = await window.shell.pickScanFile()
            break
          case 'open':
            result = typeof req.payload === 'string' ? await window.shell.openScanFile(req.payload) : false
            break
          case 'show':
            result = typeof req.payload === 'string' ? await window.shell.showScanInFolder(req.payload) : false
            break
          case 'delete':
            result = typeof req.payload === 'string' ? await window.shell.deleteScan(req.payload) : []
            break
          default:
            result = { ok: false, error: 'unknown type' }
        }
      } catch (err) {
        console.warn(`[scans-bridge] ${req.type} failed:`, err)
        result = { ok: false, error: String((err as Error)?.message ?? err) }
      }
      try {
        await guestJS<boolean>(
          'scans-write',
          '(function(id,payload){try{(window.__sewScansRes = window.__sewScansRes || {})[id]=payload;return true}catch(e){return false}})' +
            '(' +
            JSON.stringify(req.id) +
            ',' +
            JSON.stringify(result ?? null) +
            ')',
        )
      } catch {
        // страница ушла между опросом и ответом — гость повторит запрос сам
      }
    }
    return true
  } catch {
    // webview не готов — молча ждём следующего тика
    return false
  }
}

function updateAddressBar(): void {
  if (!addressInput) return
  try {
    addressInput.value = webview.getURL() ?? ''
  } catch {
    // webview ещё не готов — игнорируем
  }
}

async function navigate(url: string): Promise<void> {
  const target = normalizeUrl(url)
  if (!target) return
  if (isAllowed(target)) {
    try {
      await webview.loadURL(target)
    } catch (err) {
      console.warn('[shell] loadURL failed:', err)
    }
  } else {
    setStatus('blocked by allowlist')
  }
}

// ---------- Зум ----------

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

function nearestZoomIndex(factor: number): number {
  let best = 0
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - factor) < Math.abs(ZOOM_STEPS[best] - factor)) best = i
  }
  return best
}

/** Применяет запомненный для текущего хоста зум (вызывается при навигации) */
function applyZoomForCurrentPage(): void {
  if (!config) return
  try {
    const host = hostOf(webview.getURL() ?? '')
    const factor = (host && config.zoom[host]) || 1
    webview.setZoomFactor(factor)
  } catch {
    // webview ещё не готов — применится при следующей навигации
  }
}

async function changeZoom(dir: 1 | -1 | 'reset'): Promise<void> {
  if (!config) return
  let current = 1
  try {
    current = webview.getZoomFactor()
  } catch {
    // страница не готова — нечего масштабировать
    return
  }
  const next =
    dir === 'reset'
      ? 1
      : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, nearestZoomIndex(current) + dir))]
  try {
    webview.setZoomFactor(next)
  } catch {
    return
  }
  const host = hostOf(webview.getURL() ?? '')
  if (host) {
    config.zoom[host] = Math.round(next * 100) / 100
    try {
      config = await window.shell.setConfig({ zoom: config.zoom })
    } catch (err) {
      console.warn('[shell] failed to persist zoom:', err)
    }
  }
  setStatus(`${Math.round(next * 100)}%`)
}

// ---------- Поиск по странице ----------

function openFind(): void {
  if (!findbar || !findInput) return
  findbar.hidden = false
  findActive = true
  findInput.focus()
  findInput.select()
  if (findInput.value) doFind(true, false)
}

function closeFind(): void {
  if (!findActive) return
  findActive = false
  if (findbar) findbar.hidden = true
  if (findCount) findCount.textContent = ''
  try {
    webview.stopFindInPage('clearSelection')
  } catch {
    // игнорируем
  }
}

function doFind(forward: boolean, findNext = true): void {
  const text = findInput?.value ?? ''
  if (!text) {
    if (findCount) findCount.textContent = ''
    return
  }
  try {
    webview.findInPage(text, { forward, findNext })
  } catch {
    // страница не готова — игнорируем
  }
}

function wireFindbar(): void {
  findInput?.addEventListener('input', () => doFind(true, false))
  findInput?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      doFind(!event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeFind()
    }
  })
  document.getElementById('find-prev')?.addEventListener('click', () => doFind(false))
  document.getElementById('find-next')?.addEventListener('click', () => doFind(true))
  document.getElementById('find-close')?.addEventListener('click', closeFind)
  webview.addEventListener('found-in-page', (event) => {
    const result = event.result
    if (!result.finalUpdate || !findCount) return
    findCount.textContent = result.matches === 0 ? '0' : `${result.activeMatchOrdinal}/${result.matches}`
  })
}

// ---------- Оверлей ошибки сети ----------

function showError(text: string): void {
  if (errorText) errorText.textContent = text
  if (errorOverlay) errorOverlay.hidden = false
}

function hideError(): void {
  if (errorOverlay) errorOverlay.hidden = true
}

function wireErrorOverlay(): void {
  document.getElementById('error-retry')?.addEventListener('click', () => {
    hideError()
    webview.reload()
  })
}

// ---------- Настройки ----------

function openSettings(): void {
  if (!config || !settingsOverlay) return
  if (setStartUrl) setStartUrl.value = config.startUrl
  if (setAllowlistEnabled) setAllowlistEnabled.checked = config.allowlistEnabled
  if (setAllowlist) setAllowlist.value = config.allowlist.join('\n')
  if (setPlugins) {
    setPlugins.innerHTML = ''
    // Показываем ВСЕ плагины (включая выключенные), иначе выключенный
    // пропадал из списка и его нельзя было включить обратно.
    const list = allPlugins.length > 0 ? allPlugins : plugins.map((p) => ({ name: p.name, enabled: true }))
    for (const plugin of list) {
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.dataset.plugin = plugin.name
      checkbox.checked = config.plugins[plugin.name] ?? plugin.enabled ?? true
      label.append(checkbox, document.createTextNode(plugin.name))
      setPlugins.append(label)
    }
    if (list.length === 0) {
      const empty = document.createElement('span')
      empty.textContent = 'Нет загруженных плагинов'
      setPlugins.append(empty)
    }
  }
  if (setClearOnExit) setClearOnExit.value = config.clearOnExit
  if (setScannerApp) setScannerApp.value = config.scannerAppPath ?? ''
  if (setScannerArgs) setScannerArgs.value = (config as ShellConfig).scannerAppArgs ?? ''
  void renderScanFolders()
  settingsOverlay.hidden = false
  void refreshStoragePanel()
}

function closeSettings(): void {
  if (settingsOverlay) settingsOverlay.hidden = true
}

async function saveSettings(): Promise<void> {
  if (!config) return
  const pluginChecks = setPlugins?.querySelectorAll<HTMLInputElement>('input[data-plugin]') ?? []
  const pluginStates: Record<string, boolean> = {}
  pluginChecks.forEach((checkbox) => {
    const name = checkbox.dataset.plugin
    if (name) pluginStates[name] = checkbox.checked
  })
  const patch: Partial<ShellConfig> = {
    startUrl: normalizeUrl(setStartUrl?.value ?? '') || config.startUrl,
    allowlistEnabled: setAllowlistEnabled?.checked ?? config.allowlistEnabled,
    allowlist: (setAllowlist?.value ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    plugins: pluginStates,
    clearOnExit: (setClearOnExit?.value as ShellConfig['clearOnExit']) ?? config.clearOnExit,
    scannerAppPath: setScannerApp?.value.trim() ?? config.scannerAppPath,
    scannerAppArgs: setScannerArgs?.value.trim() ?? (config as ShellConfig).scannerAppArgs ?? '',
  }
  try {
    const oldStartUrl = config.startUrl
    config = await window.shell.setConfig(patch)
    closeSettings()
    setStatus('настройки сохранены')
    if (config.startUrl !== oldStartUrl) {
      if (addressInput) addressInput.value = config.startUrl
      void navigate(config.startUrl)
    }
  } catch (err) {
    console.warn('[shell] failed to save settings:', err)
    setStatus('не удалось сохранить настройки')
  }
}

async function clearSessionAndLogout(): Promise<void> {
  if (!window.confirm('Очистить все данные сессии (куки, кэш, хранилища) и выйти из SEW?')) return
  try {
    await window.shell.clearSession()
    closeSettings()
    webview.reload()
    setStatus('сессия очищена')
  } catch (err) {
    console.warn('[shell] failed to clear session:', err)
    setStatus('не удалось очистить сессию')
  }
}

async function renderScanFolders(): Promise<void> {
  if (!setScanFoldersList) return
  setScanFoldersList.innerHTML = ''
  const folders = config?.scanFolders ?? []
  if (folders.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'scan-folder-empty'
    empty.textContent = 'Папки не добавлены — нажмите «Добавить папку»'
    setScanFoldersList.append(empty)
    return
  }
  for (const folder of folders) {
    const row = document.createElement('div')
    row.className = 'scan-folder-row'
    const pathEl = document.createElement('div')
    pathEl.className = 'scan-folder-path'
    pathEl.textContent = folder.path
    pathEl.title = folder.path
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'scan-folder-remove'
    removeBtn.textContent = '✕'
    removeBtn.title = 'Удалить папку'
    removeBtn.setAttribute('aria-label', `Удалить папку ${folder.path}`)
    removeBtn.addEventListener('click', async () => {
      if (!window.confirm(`Удалить папку со сканами ${folder.path}?`)) return
      const next = (config?.scanFolders ?? []).filter((f) => f.id !== folder.id)
      config = await window.shell.setConfig({ scanFolders: next })
      void renderScanFolders()
    })
    row.append(pathEl, removeBtn)
    setScanFoldersList.append(row)
  }
}

function wireSettings(): void {
  document.getElementById('btn-settings')?.addEventListener('click', openSettings)
  document.getElementById('set-save')?.addEventListener('click', () => void saveSettings())
  document.getElementById('set-cancel')?.addEventListener('click', closeSettings)
  document.getElementById('set-scanner-app-browse')?.addEventListener('click', async () => {
    try {
      const path = await window.shell.browseScannerApp()
      if (path && setScannerApp) setScannerApp.value = path
    } catch (err) {
      console.warn('[shell] scans:browse-app failed:', err)
    }
  })
  document.getElementById('set-scan-folder-add')?.addEventListener('click', async () => {
    try {
      const path = await window.shell.browseScanFolder()
      if (!path) return
      const current = config?.scanFolders ?? []
      if (current.some((f) => f.path.toLowerCase() === path.toLowerCase())) {
        setStatus('папка уже добавлена')
        return
      }
      config = await window.shell.setConfig({ scanFolders: [...current, { path }] })
      void renderScanFolders()
    } catch (err) {
      console.warn('[shell] scans:browse-folder failed:', err)
    }
  })
  document.getElementById('set-clear-session')?.addEventListener('click', () => void clearSessionAndLogout())
  document.getElementById('set-reload-app')?.addEventListener('click', () => {
    // Ручная проверка обновлений на GitHub. Если версия есть — покажется
    // updatebar «Доступно обновление», если нет — тост «у вас последняя версия».
    closeSettings()
    manualUpdateCheck = true
    setStatus('проверяем обновления…')
    window.shell.checkForUpdates().catch((err) => {
      manualUpdateCheck = false
      const msg = err instanceof Error && err.message ? err.message : String(err ?? '')
      // В dev хендлера нет вообще («No handler registered») — честно говорим,
      // что проверка только в сборке; таймаут и прочие — текстом ошибки.
      setStatus(/no handler/i.test(msg) ? 'проверка доступна только в установленной версии' : msg || 'не удалось проверить')
    })
  })
  document
    .getElementById('set-clear-cache')
    ?.addEventListener('click', () => void clearStorageTarget('cache'))
  document
    .getElementById('set-clear-cookies')
    ?.addEventListener('click', () => void clearStorageTarget('cookies'))
  document.getElementById('acc-add')?.addEventListener('click', () => openAccountForm())
  document.getElementById('acc-save')?.addEventListener('click', () => void saveAccountForm())
  document.getElementById('acc-cancel')?.addEventListener('click', closeAccountForm)
  document.getElementById('acc-eye')?.addEventListener('click', (event) => {
    if (!accPassword) return
    const show = accPassword.type === 'password'
    accPassword.type = show ? 'text' : 'password'
    ;(event.target as HTMLElement).innerHTML = show ? '&#128064;' : '&#128065;'
  })
  document.getElementById('accounts-cancel')?.addEventListener('click', closeAccounts)
  setStartUrl?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') void saveSettings()
  })
}

// ---------- Хранилище: использование, куки, выборочная очистка ----------

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 Б'
  return formatBytes(bytes)
}

function renderCookies(cookies: CookieInfo[]): void {
  if (!setCookies) return
  setCookies.innerHTML = ''
  if (cookies.length === 0) {
    const empty = document.createElement('span')
    empty.textContent = 'Нет куки'
    setCookies.append(empty)
    return
  }
  for (const cookie of cookies) {
    const row = document.createElement('div')
    row.className = 'cookie-row'
    const expiry = cookie.session
      ? 'сессионная'
      : cookie.expirationDate
        ? new Date(cookie.expirationDate * 1000).toLocaleDateString('ru-RU')
        : '—'
    const info = document.createElement('span')
    info.textContent =
      `${cookie.name} @ ${cookie.domain} · ${expiry} · ${formatSize(cookie.size)}` +
      `${cookie.httpOnly ? ' · httpOnly' : ''}`
    info.title = `Путь: ${cookie.path}${cookie.secure ? ' · secure' : ''}`
    const del = document.createElement('button')
    del.textContent = '✕'
    del.title = `Удалить куку ${cookie.name}`
    del.addEventListener('click', () => void removeCookie(cookie))
    row.append(info, del)
    setCookies.append(row)
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** IPC с таймаутом: зависший вызов превращается в читаемую ошибку, а не вечное «считаем…» */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`таймаут чтения ${label}`)), ms),
    ),
  ])
}

async function refreshStoragePanel(): Promise<void> {
  if (setStorageUsage) setStorageUsage.textContent = 'считаем…'
  try {
    // Запросы независимы: показываем то, что прочиталось, и точный текст ошибки того, что нет
    const [usageRes, cookiesRes] = await Promise.allSettled([
      withTimeout(window.shell.getStorageUsage(), 10000, 'кэша'),
      withTimeout(window.shell.listCookies(), 10000, 'куки'),
    ])
    const parts: string[] = []
    if (usageRes.status === 'fulfilled' && typeof usageRes.value?.cacheBytes === 'number') {
      parts.push(`HTTP-кэш: ${formatSize(usageRes.value.cacheBytes)}`)
    } else {
      const reason = usageRes.status === 'rejected' ? usageRes.reason : new Error('нет данных')
      console.warn('[shell] storage usage failed:', reason)
      parts.push(`кэш: ошибка (${errText(reason)})`)
    }
    if (cookiesRes.status === 'fulfilled' && Array.isArray(cookiesRes.value)) {
      parts.push(`куки: ${cookiesRes.value.length} шт`)
      renderCookies(cookiesRes.value)
    } else {
      const reason =
        cookiesRes.status === 'rejected' ? cookiesRes.reason : new Error('нет данных')
      console.warn('[shell] cookies list failed:', reason)
      parts.push(`куки: ошибка (${errText(reason)})`)
      renderCookies([])
    }
    try {
      const estimate = (await guestJS<{ usage: number } | null>(
        'storage-estimate',
        'navigator.storage && navigator.storage.estimate ' +
          '? navigator.storage.estimate().then((e) => ({ usage: e.usage ?? 0 })).catch(() => null) ' +
          ': Promise.resolve(null)',
      ))
      if (estimate) parts.push(`данные сайта: ${formatSize(estimate.usage)}`)
    } catch {
      // страница не готова — показываем без данных сайта
    }
    if (setStorageUsage) setStorageUsage.textContent = parts.join(' · ')
  } catch (err) {
    console.warn('[shell] storage panel refresh failed:', err)
    if (setStorageUsage) setStorageUsage.textContent = `не удалось прочитать: ${errText(err)}`
  }
}

async function removeCookie(cookie: CookieInfo): Promise<void> {
  try {
    await window.shell.removeCookie(cookie)
    await refreshStoragePanel()
  } catch (err) {
    console.warn('[shell] remove cookie failed:', err)
  }
}

async function clearStorageTarget(target: 'cache' | 'cookies'): Promise<void> {
  if (target === 'cookies' && !window.confirm('Очистить все куки? Придётся заново войти в SEW.')) {
    return
  }
  try {
    await window.shell.clearStorage(target)
    if (target === 'cookies') webview.reload()
    await refreshStoragePanel()
    setStatus(target === 'cache' ? 'кэш очищен' : 'куки очищены')
  } catch (err) {
    console.warn('[shell] clear storage failed:', err)
    setStatus('не удалось очистить')
  }
}

// ---------- Аккаунты SEW ----------

const accountsOverlay = document.getElementById('accounts-overlay') as HTMLElement | null
const setAccounts = document.getElementById('set-accounts') as HTMLElement | null
const accForm = document.getElementById('acc-form') as HTMLElement | null
const accFio = document.getElementById('acc-fio') as HTMLInputElement | null
const accTabNum = document.getElementById('acc-tabnum') as HTMLInputElement | null
const accPassword = document.getElementById('acc-password') as HTMLInputElement | null
let accountsOpen = false
let loginPrompted = false
let editingAccountId: string | null = null

function accountLabel(a: AccountInfo): string {
  return a.fio ? `${a.fio} · ${a.tabNum}` : a.tabNum
}

/** Список аккаунтов в окне «Аккаунты SEW»: войти / изменить / удалить */
async function renderAccountsList(): Promise<AccountInfo[]> {
  if (setAccounts) setAccounts.innerHTML = ''
  let accounts: AccountInfo[] = []
  try {
    accounts = await window.shell.listAccounts()
  } catch (err) {
    console.warn('[shell] list accounts failed:', err)
  }
  if (!setAccounts) return accounts
  if (accounts.length === 0) {
    const empty = document.createElement('span')
    empty.textContent = 'Нет сохранённых аккаунтов'
    setAccounts.append(empty)
    return accounts
  }
  for (const a of accounts) {
    const row = document.createElement('div')
    row.className = 'account-row'
    const info = document.createElement('span')
    info.textContent = accountLabel(a)
    const login = document.createElement('button')
    login.textContent = 'Войти'
    login.className = 'login-btn'
    login.title = 'Подставить логин и пароль, войти'
    login.addEventListener('click', () => void fillLogin(a.id))
    const edit = document.createElement('button')
    edit.textContent = '✎'
    edit.title = 'Изменить'
    edit.addEventListener('click', () => openAccountForm(a))
    const del = document.createElement('button')
    del.textContent = '✕'
    del.title = 'Удалить'
    del.addEventListener('click', () => void deleteAccount(a))
    row.append(info, login, edit, del)
    setAccounts.append(row)
  }
  return accounts
}

async function deleteAccount(a: AccountInfo): Promise<void> {
  if (!window.confirm(`Удалить аккаунт «${accountLabel(a)}»?`)) return
  try {
    await window.shell.removeAccount(a.id)
    if (editingAccountId === a.id) closeAccountForm()
    await renderAccountsList()
    setStatus('аккаунт удалён')
  } catch (err) {
    console.warn('[shell] remove account failed:', err)
  }
}

function openAccountForm(a?: AccountInfo): void {
  editingAccountId = a?.id ?? null
  if (accFio) accFio.value = a?.fio ?? ''
  if (accTabNum) accTabNum.value = a?.tabNum ?? ''
  if (accPassword) {
    accPassword.value = ''
    accPassword.placeholder = a ? 'Пусто — не менять' : 'Пароль'
    accPassword.type = 'password'
  }
  const eye = document.getElementById('acc-eye')
  if (eye) eye.innerHTML = '&#128065;'
  if (accForm) accForm.hidden = false
  accTabNum?.focus()
}

function closeAccountForm(): void {
  editingAccountId = null
  if (accForm) accForm.hidden = true
}

async function saveAccountForm(): Promise<void> {
  const tabNum = accTabNum?.value.trim() ?? ''
  const password = accPassword?.value ?? ''
  if (!tabNum) {
    setStatus('укажите табельный номер')
    return
  }
  if (!editingAccountId && !password) {
    setStatus('укажите пароль')
    return
  }
  try {
    await window.shell.saveAccount({
      id: editingAccountId ?? undefined,
      fio: accFio?.value ?? '',
      tabNum,
      password,
    })
    closeAccountForm()
    await renderAccountsList()
    setStatus('аккаунт сохранён')
  } catch (err) {
    console.warn('[shell] save account failed:', err)
    setStatus(`не удалось сохранить: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------- Окно «Аккаунты SEW»: выбор для входа + управление ----------

async function openAccounts(manual: boolean): Promise<void> {
  const accounts = await renderAccountsList()
  if (accounts.length === 0) {
    // Авто-обнаружение формы входа: предлагать нечего — молча выходим.
    // Ручное открытие: сразу показываем форму добавления.
    if (!manual) return
    openAccountForm()
    setStatus('добавьте аккаунт SEW для автовхода')
  }
  if (!accountsOverlay) return
  accountsOverlay.hidden = false
  accountsOpen = true
}

function closeAccounts(): void {
  accountsOpen = false
  closeAccountForm()
  if (accountsOverlay) accountsOverlay.hidden = true
}

/** Есть ли на странице видимое поле пароля (форма входа)? */
async function hasLoginForm(): Promise<boolean> {
  try {
    const found = await guestJS<unknown>(
      'login-form',
      '!!document.querySelector(\'input[type="password"]:not([disabled])\')',
    )
    return found === true
  } catch {
    return false
  }
}

async function checkLoginForm(manual: boolean): Promise<void> {
  if (accountsOpen) return
  if (!manual && loginPrompted) return
  if (!(await hasLoginForm())) return
  loginPrompted = true
  await openAccounts(false)
}

/**
 * Подставляет табельный номер + пароль и нажимает «Войти».
 * Значения задаём через нативный сеттер value + события input/change,
 * иначе React/Vue-формы не заметят программную подстановку.
 */
async function fillLogin(accountId: string): Promise<void> {
  closeAccounts()
  let secrets: { tabNum: string; password: string } | null = null
  try {
    secrets = await window.shell.getAccountSecrets(accountId)
  } catch (err) {
    console.warn('[shell] get secrets failed:', err)
  }
  if (!secrets) {
    setStatus('не удалось получить данные аккаунта')
    return
  }
  const payload = JSON.stringify({ tabNum: secrets.tabNum, password: secrets.password })
  secrets = null
  const script =
    '(function(creds){' +
    'var pass=document.querySelector(\'input[type="password"]:not([disabled])\');' +
    'if(!pass) return "no-password-field";' +
    'var inputs=Array.prototype.slice.call(document.querySelectorAll("input")).filter(function(el){' +
    'return el!==pass&&!el.disabled&&el.type!=="hidden"&&el.type!=="submit"&&el.type!=="checkbox"' +
    '&&el.type!=="radio"&&el.type!=="password"&&el.offsetParent!==null;});' +
    'var user=inputs.find(function(el){return /user|login|email|tabnum|account|name/i' +
    '.test(el.name+" "+el.id+" "+el.placeholder);})||inputs[0];' +
    'function setVal(el,v){var desc=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value")' +
    '||Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");' +
    'if(desc&&desc.set)desc.set.call(el,v);else el.value=v;' +
    'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}' +
    'if(user)setVal(user,creds.tabNum);' +
    'setVal(pass,creds.password);' +
    'var form=pass.form||(user&&user.form);' +
    'var submit=form?form.querySelector(\'button[type="submit"],input[type="submit"]\')' +
    ':document.querySelector(\'button[type="submit"]\');' +
    'setTimeout(function(){if(submit)submit.click();else if(form)' +
    '{if(form.requestSubmit)form.requestSubmit();else form.submit();}},300);' +
    'return "ok";})(' +
    payload +
    ')'
  try {
    await guestJS<unknown>('fill-login', script)
    setStatus('вход…')
  } catch (err) {
    console.warn('[shell] autofill failed:', err)
    setStatus('не удалось заполнить форму')
  }
}

// ---------- Загрузки ----------

interface DownloadState {
  name: string
  status: 'active' | 'done' | 'error'
  percent: number
  received: number
  path?: string
}

const downloads = new Map<number, DownloadState>()
let downloadsHideTimer: ReturnType<typeof setTimeout> | null = null

function formatBytes(n: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`
  return `${(n / 1024 / 1024).toFixed(1)} МБ`
}

function renderDownloads(): void {
  if (!downloadsEl) return
  if (downloadsHideTimer) {
    clearTimeout(downloadsHideTimer)
    downloadsHideTimer = null
  }
  const active = [...downloads.entries()].filter(([, d]) => d.status === 'active')
  if (active.length > 0) {
    const [[, current], ...rest] = active
    const extra = rest.length > 0 ? ` (+${rest.length})` : ''
    const progress =
      current.percent >= 0 ? ` — ${current.percent}%` : ` — ${formatBytes(current.received)}`
    downloadsEl.textContent = `↓ ${current.name}${progress}${extra}`
    downloadsEl.classList.toggle('done', false)
    downloadsEl.onclick = null
    downloadsEl.hidden = false
    return
  }
  const last = [...downloads.values()].pop()
  if (!last) {
    downloadsEl.hidden = true
    downloadsEl.onclick = null
    return
  }
  if (last.status === 'done') {
    downloadsEl.textContent = `✓ ${last.name}`
    downloadsEl.classList.toggle('done', true)
    const path = last.path
    downloadsEl.onclick = path ? () => void window.shell.showItemInFolder(path) : null
  } else {
    downloadsEl.textContent = `✕ ${last.name}`
    downloadsEl.classList.toggle('done', false)
    downloadsEl.onclick = null
  }
  downloadsEl.hidden = false
  downloadsHideTimer = setTimeout(() => {
    if (downloadsEl) downloadsEl.hidden = true
  }, 6000)
}

function pruneDownloads(): void {
  while (downloads.size > 20) {
    const oldestDone = [...downloads.keys()].find((id) => downloads.get(id)?.status !== 'active')
    if (oldestDone === undefined) break
    downloads.delete(oldestDone)
  }
}

function wireDownloads(): void {
  document.getElementById('btn-downloads')?.addEventListener('click', () => void openDownloads())
  document.getElementById('downloads-close')?.addEventListener('click', closeDownloads)
  document.getElementById('downloads-clear')?.addEventListener('click', () => void clearDownloadsHistory())
  downloadsFilter?.addEventListener('change', () => renderDownloadsHistory(downloadsRecords))
  window.shell.onDownload((event) => {
    if (event.type === 'started') {
      downloads.set(event.id, {
        name: event.name,
        status: 'active',
        percent: -1,
        received: 0,
        path: event.path,
      })
    } else if (event.type === 'progress') {
      const current = downloads.get(event.id)
      if (current && current.status === 'active') {
        current.percent = event.percent ?? -1
        current.received = event.received ?? 0
      }
    } else if (event.ok) {
      const current = downloads.get(event.id)
      if (current) {
        current.status = 'done'
        current.path = event.path
      } else {
        downloads.set(event.id, { name: event.name, status: 'done', percent: 100, received: 0, path: event.path })
      }
    } else if (event.cancelled) {
      downloads.delete(event.id)
    } else {
      const current = downloads.get(event.id)
      if (current) current.status = 'error'
      else downloads.set(event.id, { name: event.name, status: 'error', percent: -1, received: 0 })
    }
    pruneDownloads()
    renderDownloads()
    // Окно истории открыто — подтягиваем свежие записи
    if (downloadsOpen) void refreshDownloadsHistory()
  })
}

// ---------- Окно «Загрузки»: история файлов ----------

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function whoLabel(rec: DownloadedFile): string {
  if (!rec.fio) return 'неизвестно'
  return rec.tabNum ? `${rec.fio} (${rec.tabNum})` : rec.fio
}

function rebuildDownloadsFilter(): void {
  if (!downloadsFilter) return
  const current = downloadsFilter.value
  const seen = new Set<string>()
  downloadsFilter.innerHTML = ''
  const all = document.createElement('option')
  all.value = ''
  all.textContent = 'Все сотрудники'
  downloadsFilter.append(all)
  for (const rec of downloadsRecords) {
    const key = rec.fio ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    const opt = document.createElement('option')
    opt.value = key
    opt.textContent = rec.fio ? whoLabel(rec) : 'Неизвестно'
    downloadsFilter.append(opt)
  }
  // Выбор переживает обновление, если сотрудник ещё есть в списке
  downloadsFilter.value = Array.from(downloadsFilter.options).some((o) => o.value === current)
    ? current
    : ''
}

function renderDownloadsHistory(records: DownloadedFile[]): void {
  if (!downloadsHistory) return
  downloadsRecords = records
  rebuildDownloadsFilter()
  const filter = downloadsFilter?.value ?? ''
  const visible = filter ? records.filter((r) => (r.fio ?? '') === filter) : records
  downloadsHistory.innerHTML = ''
  if (visible.length === 0) {
    const empty = document.createElement('span')
    empty.textContent = records.length === 0 ? 'Пока ничего не скачано' : 'Нет записей для этого сотрудника'
    downloadsHistory.append(empty)
    return
  }
  for (const rec of visible) {
    const row = document.createElement('div')
    row.className = 'download-row'
    const icon = document.createElement('span')
    icon.className = 'download-icon'
    icon.textContent = rec.state === 'done' ? '✓' : '✕'
    const info = document.createElement('div')
    info.className = 'download-info'
    const name = document.createElement('span')
    name.className = 'download-name'
    name.textContent = rec.name
    name.title = rec.path || rec.name
    name.addEventListener('click', () => void openHistoryFile(rec))
    const meta = document.createElement('span')
    meta.className = 'download-meta'
    const sizePart = rec.bytes > 0 ? `${formatSize(rec.bytes)} · ` : ''
    const whoPart = rec.fio ? ` · ${whoLabel(rec)}` : ' · неизвестно'
    meta.textContent = `${sizePart}${formatDateTime(rec.finishedAt)}${whoPart}${rec.state === 'error' ? ' · ошибка' : ''}`
    info.append(name, meta)
    const show = document.createElement('button')
    show.textContent = '📁'
    show.title = 'Показать в папке'
    show.addEventListener('click', () => void showHistoryFile(rec))
    const del = document.createElement('button')
    del.className = 'dl-remove'
    del.textContent = '✕'
    del.title = 'Убрать из списка'
    del.addEventListener('click', () => void deleteHistoryRecord(rec.id))
    row.append(icon, info, show, del)
    downloadsHistory.append(row)
  }
}

async function refreshDownloadsHistory(): Promise<void> {
  try {
    renderDownloadsHistory(await window.shell.listDownloads())
  } catch (err) {
    console.warn('[shell] downloads history failed:', err)
  }
}

async function openDownloads(): Promise<void> {
  if (!downloadsOverlay) return
  downloadsOverlay.hidden = false
  downloadsOpen = true
  await refreshDownloadsHistory()
}

function closeDownloads(): void {
  downloadsOpen = false
  if (downloadsOverlay) downloadsOverlay.hidden = true
}

async function openHistoryFile(rec: DownloadedFile): Promise<void> {
  try {
    const ok = await window.shell.openDownloadFile(rec.id)
    if (!ok) setStatus('файл не найден (перемещён или удалён)')
  } catch (err) {
    console.warn('[shell] open download failed:', err)
  }
}

async function showHistoryFile(rec: DownloadedFile): Promise<void> {
  try {
    const ok = await window.shell.showDownload(rec.id)
    if (!ok) setStatus('файл не найден (перемещён или удалён)')
  } catch (err) {
    console.warn('[shell] show download failed:', err)
  }
}

async function deleteHistoryRecord(id: string): Promise<void> {
  try {
    renderDownloadsHistory(await window.shell.removeDownload(id))
  } catch (err) {
    console.warn('[shell] remove download failed:', err)
  }
}

async function clearDownloadsHistory(): Promise<void> {
  try {
    renderDownloadsHistory(await window.shell.clearDownloads())
  } catch (err) {
    console.warn('[shell] clear downloads failed:', err)
  }
}

// ---------- Внешние протоколы (mailto:, tel:) ----------

/** Не http(s) — отдаём внешнему приложению, а не оверлею ошибки */
function isExternalProtocol(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol !== 'http:' && protocol !== 'https:'
  } catch {
    return false
  }
}

// ---------- Шорткаты ----------

async function handleShortcut(name: string): Promise<void> {
  switch (name as ShortcutName) {
    case 'reload':
      webview.reload()
      break
    case 'hard-reload':
      webview.reloadIgnoringCache()
      setStatus('перезагрузка мимо кэша')
      break
    case 'focus-address':
      addressInput?.focus()
      addressInput?.select()
      break
    case 'accounts':
      void openAccounts(true)
      break
    case 'templates':
      void openTemplates()
      break
    case 'back':
      webview.goBack()
      break
    case 'forward':
      webview.goForward()
      break
    case 'fullscreen':
      try {
        isFullscreen = await window.shell.setFullscreen()
      } catch (err) {
        console.warn('[shell] fullscreen toggle failed:', err)
      }
      break
    case 'print':
      try {
        await webview.print()
      } catch (err) {
        console.warn('[shell] print failed:', err)
        setStatus('печать не удалась')
      }
      break
    case 'find':
      openFind()
      break
    case 'zoom-in':
      void changeZoom(1)
      break
    case 'zoom-out':
      void changeZoom(-1)
      break
    case 'zoom-reset':
      void changeZoom('reset')
      break
    case 'settings':
      openSettings()
      break
    case 'escape':
      if (templatesManageOpen) closeTemplatesManage()
      else if (templatesOpen) closeTemplates()
      else if (accountsOpen) closeAccounts()
      else if (downloadsOpen) closeDownloads()
      else if (tabsOpen) closeTabs()
      else if (findActive) closeFind()
      else if (settingsOverlay && !settingsOverlay.hidden) closeSettings()
      else if (document.activeElement === addressInput && addressInput) addressInput.blur()
      else if (isFullscreen) {
        isFullscreen = false
        try {
          await window.shell.setFullscreen(false)
        } catch {
          // игнорируем
        }
      }
      break
    default:
      break
  }
}

/** Буквы — по event.code (не зависит от раскладки клавиатуры) */
function shortcutFromEvent(event: KeyboardEvent): ShortcutName | null {
  const mod = event.ctrlKey || event.metaKey
  const { key, code } = event
  if (key === 'F5') return mod ? 'hard-reload' : 'reload'
  if (mod && code === 'KeyR') return 'reload'
  if (mod && event.shiftKey && code === 'KeyL') return 'accounts'
  if (mod && event.shiftKey && code === 'KeyT') return 'templates'
  if (mod && code === 'KeyL') return 'focus-address'
  if (mod && code === 'KeyF') return 'find'
  if (mod && code === 'KeyP') return 'print'
  if (mod && (key === '=' || key === '+')) return 'zoom-in'
  if (mod && (key === '-' || key === '_')) return 'zoom-out'
  if (mod && key === '0') return 'zoom-reset'
  if (mod && code === 'Comma') return 'settings'
  if (event.altKey && key === 'ArrowLeft') return 'back'
  if (event.altKey && key === 'ArrowRight') return 'forward'
  if (key === 'F11') return 'fullscreen'
  if (key === 'Escape') return 'escape'
  return null
}

function wireShortcuts(): void {
  // Шорткаты, когда фокус в shell-UI (тулбар, адресная строка).
  // Когда фокус внутри страницы — те же имена прилетают из main-процесса
  // через before-input-event (см. window.shell.onShortcut ниже).
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    const name = shortcutFromEvent(event)
    if (!name) return
    // Esc в поле поиска обрабатывается локально в wireFindbar
    if (event.target === findInput && event.key === 'Escape') return
    event.preventDefault()
    void handleShortcut(name)
  })
  window.shell.onShortcut((name) => void handleShortcut(name))
}

function wireToolbar(): void {
  document.getElementById('btn-back')?.addEventListener('click', () => webview.goBack())
  document.getElementById('btn-forward')?.addEventListener('click', () => webview.goForward())
  document.getElementById('btn-home')?.addEventListener('click', () => {
    if (config) void navigate(config.startUrl)
  })
  document.getElementById('btn-mvideo')?.addEventListener('click', () => {
    void navigate('https://www.mvideo.ru/')
  })
  document.getElementById('btn-reload')?.addEventListener('click', () => webview.reload())
  document.getElementById('btn-barcode')?.addEventListener('click', () => {
    void navigate('https://monutor.github.io/warehouse-barcode-generator/')
  })
  document.getElementById('btn-products')?.addEventListener('click', () => {
    void navigate('https://monutor.github.io/DataBaseProducts/')
  })
  document.getElementById('btn-accounts')?.addEventListener('click', () => void openAccounts(true))
  // NB: btn-templates подписывается в wireTemplates() — дубль здесь давал
  // двойной openTemplates() и задвоенный список шаблонов.

  if (addressInput) {
    addressInput.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') void navigate(addressInput.value)
    })
  }

  document.getElementById('btn-min')?.addEventListener('click', () => window.shell.windowMin())
  document.getElementById('btn-max')?.addEventListener('click', () => window.shell.windowMax())
  document.getElementById('btn-close')?.addEventListener('click', () => window.shell.windowClose())

  document.getElementById('btn-scans')?.addEventListener('click', async () => {
    try {
      await guestJS<void>('scans-open', '(function(){try{window.dispatchEvent(new CustomEvent("scans-block:open"))}catch(e){}})()')
    } catch (err) {
      console.warn('[shell] failed to open scans block:', err)
    }
  })

  // DevTools webview — только в debug-режиме
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i' && config?.debug) {
      event.preventDefault()
      webview.openDevTools()
    }
  })
}

// Последний разрешённый URL — точка возврата при срабатывании allowlist.
// (preventDefault() в will-navigate у webview не работает, поэтому запрещённую
// навигацию откатываем обратно через loadURL.)
let lastAllowedUrl = ''

function wireWebviewEvents(): void {
  webview.addEventListener('dom-ready', () => {
    // Привязка гостевого webContents для перехвата хоткеев внутри страницы
    try {
      window.shell.attachGuest(webview.getWebContentsId())
    } catch (err) {
      console.warn('[shell] guest attach failed:', err)
    }
  })
  webview.addEventListener('did-navigate', (event) => {
    console.log('[shell] did-navigate:', event.url)
    if (isAllowed(event.url)) {
      lastAllowedUrl = event.url
      updateAddressBar()
      applyZoomForCurrentPage()
      updateActiveTab()
    } else {
      // Показываем заблокированный хост — так проще дополнять allowlist
      setStatus(`blocked: ${hostOf(event.url) || event.url}`)
      void webview.loadURL(lastAllowedUrl).catch((err) => console.warn('[shell] bounce-back failed:', err))
    }
  })
  webview.addEventListener('did-navigate-in-page', updateAddressBar)
  webview.addEventListener('did-finish-load', () => {
    void injectPlugins()
    // Появилась форма входа? Предлагаем выбрать аккаунт (с паузой —
    // SPA достраивает форму уже после события загрузки)
    setTimeout(() => void checkLoginForm(false), 1200)
  })
  webview.addEventListener('did-fail-load', (event) => {
    if (!event.isMainFrame) return
    // -3 (ERR_ABORTED) — прерванная загрузка, например откат allowlist; не ошибка
    if (event.errorCode === -3) return
    // Ссылки на внешние приложения (mailto:, tel:) — открываем снаружи
    if (isExternalProtocol(event.url)) {
      setStatus('открыто во внешнем приложении')
      void window.shell.openExternal(event.url)
      return
    }
    console.error('[shell] did-fail-load:', event.errorCode, event.errorDescription)
    setStatus(`fail: ${event.errorDescription}`)
    showError(`${event.errorDescription} (код ${event.errorCode})`)
  })
  webview.addEventListener('did-start-loading', () => {
    hideError()
    loginPrompted = false
    toolbar?.classList.add('loading')
  })
  webview.addEventListener('did-stop-loading', () => toolbar?.classList.remove('loading'))
}

function startStatusPolling(): void {
  setInterval(async () => {
    try {
      const count = await guestJS<unknown>('datalog-count', '(window.__sewDataLog || []).length')
      setStatus(config?.debug ? `req: ${count} · debug` : `req: ${count}`, false)
    } catch {
      // страница ещё не готова — игнорируем
    }
  }, 2000)
}

// ---------- Автообновление (уведомление + кнопка) ----------

const updatebar = document.getElementById('updatebar') as HTMLElement | null
const updateText = document.getElementById('update-text') as HTMLElement | null
const updateAction = document.getElementById('update-action') as HTMLButtonElement | null

type UpdaterUiState = 'idle' | 'available' | 'downloading' | 'ready'
let updaterState: UpdaterUiState = 'idle'
/** Ручная проверка из настроек (флаг отличает её от тихого автостарта) */
let manualUpdateCheck = false
let updaterVersion = ''
let updaterPercent = 0

function renderUpdater(): void {
  if (!updatebar || !updateText || !updateAction) return
  if (updaterState === 'idle') {
    updatebar.hidden = true
    return
  }
  updatebar.hidden = false
  updateAction.disabled = false
  if (updaterState === 'available') {
    updateText.textContent = `Доступно обновление ${updaterVersion}`
    updateAction.textContent = 'Скачать и установить'
    updateAction.onclick = (): void => {
      updaterState = 'downloading'
      updaterPercent = 0
      renderUpdater()
      window.shell.downloadUpdate().catch((err) => {
        console.warn('[shell] download update failed:', err)
        updaterState = 'available'
        renderUpdater()
        setStatus(String(err?.message ?? 'не удалось скачать обновление'))
      })
    }
  } else if (updaterState === 'downloading') {
    updateText.textContent = `Скачивание обновления… ${updaterPercent}%`
    updateAction.textContent = 'Скачивается…'
    updateAction.disabled = true
    updateAction.onclick = null
  } else {
    updateText.textContent = `Обновление ${updaterVersion} готово`
    updateAction.textContent = 'Перезапустить'
    updateAction.onclick = (): void => window.shell.installUpdate()
  }
}

function wireUpdater(): void {
  document.getElementById('update-close')?.addEventListener('click', () => {
    if (updatebar) updatebar.hidden = true
  })
  window.shell.onUpdater((event) => {
    if (event.type === 'available') {
      manualUpdateCheck = false
      updaterState = 'available'
      updaterVersion = event.version ?? ''
    } else if (event.type === 'progress') {
      updaterState = 'downloading'
      updaterPercent = event.percent ?? 0
    } else if (event.type === 'ready') {
      updaterState = 'ready'
      updaterVersion = event.version ?? updaterVersion
    } else if (event.type === 'uptodate') {
      // Тихо при автостарте; тост — только по ручной проверке из настроек
      if (!manualUpdateCheck) return
      manualUpdateCheck = false
      setStatus('у вас последняя версия')
    } else {
      // error — показываем только если пользователь уже в процессе
      if (manualUpdateCheck) {
        manualUpdateCheck = false
        setStatus(`не удалось проверить: ${event.message ?? 'ошибка'}`)
        return
      }
      // во время скачивания показывает catch у downloadUpdate()
      if (updaterState === 'idle' || updaterState === 'downloading') return
      setStatus(`обновление: ${event.message ?? 'ошибка'}`)
      return
    }
    renderUpdater()
  })
}

// ---------- Шаблоны SEW (порт расширения SEW-Pattern) ----------
const TEMPLATES_PLUGIN = 'sew-pattern'

interface TemplateItem {
  id: string
  name?: string
  preset?: string
  fields?: Record<string, string>
}

async function loadTemplateItems(): Promise<TemplateItem[]> {
  try {
    const data = await window.shell.pluginDataGet(TEMPLATES_PLUGIN, ['sew_templates'])
    return Array.isArray(data.sew_templates) ? (data.sew_templates as TemplateItem[]) : []
  } catch (err) {
    console.warn('[templates] load failed:', err)
    return []
  }
}

/** chrome-совместимая прослойка для options.js расширения (выполняется в shell-окне) */
function makeShellChrome(pluginName: string): unknown {
  const pickGet = (
    keys: unknown,
    cb?: (res: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> | undefined => {
    const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : undefined
    const p = window.shell.pluginDataGet(pluginName, list).then((all) => {
      if (keys === undefined || keys === null) return all
      if (typeof keys === 'string') return all[keys] !== undefined ? { [keys]: all[keys] } : {}
      const out: Record<string, unknown> = {}
      for (const k of list ?? []) out[k] = all[k]
      return out
    })
    if (typeof cb === 'function') {
      p.then(cb)
      return undefined
    }
    return p
  }
  return {
    storage: {
      local: {
        get: pickGet,
        set: (obj: Record<string, unknown>, cb?: () => void): Promise<boolean> | undefined => {
          const p = window.shell.pluginDataSet(pluginName, obj)
          if (typeof cb === 'function') {
            p.then(() => cb())
            return undefined
          }
          return p
        },
        remove: (keys: string[], cb?: () => void): Promise<boolean> | undefined => {
          const p = window.shell.pluginDataRemove(pluginName, keys)
          if (typeof cb === 'function') {
            p.then(() => cb())
            return undefined
          }
          return p
        },
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, { newValue: unknown }>, area: string) => void): void => {
          window.shell.onPluginDataChanged(({ plugin }) => {
            if (plugin !== pluginName) return
            try {
              fn({ sew_templates: { newValue: true } }, 'local')
            } catch {
              // игнорируем
            }
          })
        },
        removeListener: (): void => {},
      },
    },
    runtime: { lastError: undefined as undefined },
  }
}

let templatesRefreshCall = 0

async function refreshTemplatesList(): Promise<void> {
  if (!templatesList) return
  const myCall = ++templatesRefreshCall
  templatesList.innerHTML = ''
  const templates = await loadTemplateItems()
  // Пока грузили, мог прийти более свежий вызов (двойной клик, хоткей + кнопка) —
  // устаревший результат не рисуем, иначе строки задвоятся.
  if (myCall !== templatesRefreshCall) return
  if (templates.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'settings-row'
    empty.textContent = 'Нет шаблонов. Откройте «Управление шаблонами» и создайте первый.'
    templatesList.append(empty)
    return
  }
  for (const tpl of templates) {
    const fieldCount = tpl.fields ? Object.keys(tpl.fields).length : 0
    const presetName = tpl.preset === 'trn' ? 'ТрН' : tpl.preset || 'ТрН'
    const row = document.createElement('div')
    row.className = 'templates-row'
    const name = document.createElement('span')
    name.className = 'tpl-name'
    name.textContent = tpl.name || 'Без имени'
    const meta = document.createElement('span')
    meta.className = 'tpl-meta'
    meta.textContent = `${presetName} · ${fieldCount} полей`
    row.append(name, meta)
    row.addEventListener('click', () => void applyTemplateFromShell(tpl.id))
    templatesList.append(row)
  }
}

async function openTemplates(): Promise<void> {
  if (!templatesOverlay) return
  await refreshTemplatesList()
  templatesOverlay.hidden = false
  templatesOpen = true
}

function closeTemplates(): void {
  if (!templatesOverlay) return
  templatesOverlay.hidden = true
  templatesOpen = false
}

/** Применить шаблон к открытой форме SEW — через onMessage-подписку content-скрипта */
async function applyTemplateFromShell(id: string): Promise<void> {
  try {
    const delivered = await guestJS<boolean>(
      'apply-template',
      `typeof window.__chromeShimReceive === 'function'` +
        ` ? (window.__chromeShimReceive({action:'applyTemplate',templateId:${JSON.stringify(id)}}), true)` +
        ` : false`,
    )
    closeTemplates()
    setStatus(delivered ? 'шаблон применён' : 'откройте форму в SEW и повторите')
  } catch (err) {
    console.warn('[templates] apply failed:', err)
    setStatus('не удалось применить шаблон')
  }
}

function openTemplatesManage(): void {
  if (!templatesManageOverlay) return
  templatesManageOverlay.hidden = false
  templatesManageOpen = true
}

function closeTemplatesManage(): void {
  if (!templatesManageOverlay) return
  templatesManageOverlay.hidden = true
  templatesManageOpen = false
}

// ---------- Вкладки навигации ----------

function openTabs(): void {
  if (!tabsOverlay) return
  editingTabId = null
  tabForm && (tabForm.hidden = true)
  refreshTabsList()
  tabsOverlay.hidden = false
  tabsOpen = true
}

function closeTabs(): void {
  if (!tabsOverlay) return
  tabsOverlay.hidden = true
  tabsOpen = false
  editingTabId = null
  tabForm && (tabForm.hidden = true)
}

function generateTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

async function saveTabs(tabs: NavTab[]): Promise<void> {
  const updated = await window.shell.setConfig({ tabs })
  if (updated && 'tabs' in updated) config = updated as ShellConfig
  renderStrip()
  refreshTabsList()
}

function currentViewUrl(): string {
  try {
    return webview.getURL() ?? ''
  } catch {
    return ''
  }
}

// Лента вкладок во второй строке тулбара. Всегда видима (даже при пустом
// списке), иначе кнопки +/⋮ внутри скрытой ленты недостижимы, а в тулбаре
// отдельной кнопки не было — на чистой установке вкладки нельзя было создать.
function renderStrip(): void {
  if (!tabstrip || !tabsEl || !config) return
  tabstrip.hidden = false
  tabsEl.innerHTML = ''
  const current = currentViewUrl()
  for (const tab of config.tabs) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tab' + (tab.url === current ? ' active' : '')
    btn.dataset.url = tab.url
    btn.textContent = tab.name
    btn.title = tab.url
    btn.addEventListener('click', () => void navigate(tab.url))
    tabsEl.append(btn)
  }
}

// Точечное обновление активного класса без пересборки ленты (без потери фокуса).
function updateActiveTab(): void {
  if (!tabsEl) return
  const current = currentViewUrl()
  for (const el of tabsEl.querySelectorAll<HTMLElement>('.tab')) {
    el.classList.toggle('active', el.dataset.url === current)
  }
}

// Список вкладок в оверлее управления. Клик по строке — навигация; кнопки
// перемещения/редактирования/удаления работают через stopPropagation.
function refreshTabsList(): void {
  if (!tabsList || !config) return
  tabsList.innerHTML = ''
  config.tabs.forEach((tab, index) => {
    const row = document.createElement('div')
    row.className = 'tab-row'
    const info = document.createElement('div')
    info.className = 'tab-info'
    const name = document.createElement('span')
    name.className = 'tab-name'
    name.textContent = tab.name
    name.title = tab.url
    const url = document.createElement('span')
    url.className = 'tab-url'
    url.textContent = tab.url
    info.append(name, url)
    row.append(info)
    row.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest('.tab-row button')) return
      void closeTabs()
      void navigate(tab.url)
    })
    const up = document.createElement('button')
    up.type = 'button'
    up.textContent = '↑'
    up.title = 'Поднять выше'
    up.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); void moveTab(tab.id, -1) })
    const down = document.createElement('button')
    down.type = 'button'
    down.textContent = '↓'
    down.title = 'Опустить ниже'
    down.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); void moveTab(tab.id, 1) })
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.textContent = '✎'
    edit.title = 'Редактировать'
    edit.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); openEditForm(tab) })
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'tab-del'
    del.textContent = '🗑'
    del.title = 'Удалить'
    del.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); void deleteTab(tab.id) })
    row.append(up, down, edit, del)
    tabsList.append(row)
  })
}

function openEditForm(tab: NavTab): void {
  editingTabId = tab.id
  if (tabNameInput) tabNameInput.value = tab.name
  if (tabUrlInput) tabUrlInput.value = tab.url
  tabForm && (tabForm.hidden = false)
  tabNameInput?.focus()
}

function resetForm(): void {
  editingTabId = null
  if (tabNameInput) tabNameInput.value = ''
  if (tabUrlInput) tabUrlInput.value = ''
  tabForm && (tabForm.hidden = true)
}

async function saveCurrentTab(): Promise<void> {
  const name = tabNameInput?.value.trim() ?? ''
  const urlRaw = tabUrlInput?.value.trim() ?? ''
  if (!name || !urlRaw) {
    setStatus('Укажите название и ссылку')
    return
  }
  const url = normalizeUrl(urlRaw)
  const tabs = [...(config?.tabs ?? [])]
  if (editingTabId) {
    const i = tabs.findIndex((t) => t.id === editingTabId)
    if (i !== -1) tabs[i] = { ...tabs[i], name, url }
  } else {
    tabs.push({ id: generateTabId(), name, url })
  }
  await saveTabs(tabs)
  resetForm()
}

async function deleteTab(id: string): Promise<void> {
  if (!config || !window.confirm('Удалить вкладку?')) return
  const tabs = config.tabs.filter((t) => t.id !== id)
  await saveTabs(tabs)
}

async function moveTab(id: string, dir: number): Promise<void> {
  if (!config) return
  const tabs = [...config.tabs]
  const i = tabs.findIndex((t) => t.id === id)
  const j = i + dir
  if (i === -1 || j < 0 || j >= tabs.length) return
  ;[tabs[i], tabs[j]] = [tabs[j], tabs[i]]
  await saveTabs(tabs)
}

/** Формат файла: заголовок для валидации + массив вкладок. */
const TABS_FILE_FORMAT = 'sewbrowser-tabs'
const TABS_FILE_VERSION = 1

interface TabFilePayload {
  format: string
  version: number
  tabs: NavTab[]
}

function buildTabsJson(): string {
  const payload: TabFilePayload = {
    format: TABS_FILE_FORMAT,
    version: TABS_FILE_VERSION,
    tabs: (config?.tabs ?? []).map((t) => ({ id: t.id, name: t.name, url: t.url })),
  }
  return JSON.stringify(payload, null, 2)
}

async function exportTabs(): Promise<void> {
  const tabs = config?.tabs ?? []
  if (!tabs.length) {
    setStatus('Нет вкладок для экспорта')
    return
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const ok = await window.shell.saveTabsFile(buildTabsJson(), `sewbrowser-tabs-${stamp}.json`)
  setStatus(ok ? `Экспорт: ${tabs.length} вкладок сохранён` : 'Экпорт отменён')
}

function importTabs(file: File): void {
  const reader = new FileReader()
  reader.onload = async () => {
    let data: Partial<TabFilePayload>
    try {
      data = JSON.parse(String(reader.result ?? '')) as Partial<TabFilePayload>
    } catch {
      setStatus('Файл не является валидным JSON')
      return
    }
    if (data.format !== TABS_FILE_FORMAT || !Array.isArray(data.tabs)) {
      setStatus('Неверный формат файла (ожидался экспорт вкладок SEWBrowser)')
      return
    }
    const tabs: NavTab[] = []
    for (const raw of data.tabs) {
      if (!raw || typeof raw !== 'object') continue
      const name = String((raw as NavTab).name ?? '').trim()
      const urlRaw = String((raw as NavTab).url ?? '').trim()
      if (!name || !urlRaw) continue
      tabs.push({ id: generateTabId(), name, url: normalizeUrl(urlRaw) })
    }
    if (!tabs.length) {
      setStatus('В файле нет валидных вкладок')
      return
    }
    if (!window.confirm(`Заменить текущие ${config?.tabs.length ?? 0} вкладок на ${tabs.length} импортированные?`)) {
      return
    }
    await saveTabs(tabs)
    setStatus(`Импорт: ${tabs.length} вкладок из ${file.name}`)
  }
  reader.onerror = () => setStatus('Не удалось прочитать файл')
  reader.readAsText(file)
}

function wireTabs(): void {
  document.getElementById('tab-add')?.addEventListener('click', () => void openTabs())
  document.getElementById('tab-manage')?.addEventListener('click', () => void openTabs())
  document.getElementById('tab-add-new')?.addEventListener('click', () => { resetForm(); openEditForm({ id: '', name: '', url: '' }) })
  tabsExport?.addEventListener('click', () => void exportTabs())
  tabsImport?.addEventListener('click', () => { if (tabsImportFile) tabsImportFile.click() })
  tabsImportFile?.addEventListener('change', (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) void importTabs(file)
    // Снимаем значение, чтобы повторный выбор того же файла снова сработал
    if (tabsImportFile) tabsImportFile.value = ''
  })
  document.getElementById('tab-save')?.addEventListener('click', () => void saveCurrentTab())
  document.getElementById('tab-cancel')?.addEventListener('click', () => { resetForm() })
  document.getElementById('tabs-close')?.addEventListener('click', closeTabs)
  tabNameInput?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void saveCurrentTab() })
  tabUrlInput?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void saveCurrentTab() })
}

function wireTemplates(): void {
  document.getElementById('btn-templates')?.addEventListener('click', () => void openTemplates())
  document.getElementById('templates-manage')?.addEventListener('click', () => {
    closeTemplates()
    openTemplatesManage()
  })
  document.getElementById('templates-close')?.addEventListener('click', closeTemplates)
  document.getElementById('manageCloseBtn')?.addEventListener('click', closeTemplatesManage)
  // options.js расширения — дословно, с shell-прослойкой вместо chrome.*
  // Нюанс: options.js ждёт DOMContentLoaded, но документ оболочки к этому
  // моменту давно загружен — подписку перехватываем и вызываем колбэк сразу.
  const pattern = plugins.find((p) => p.name === TEMPLATES_PLUGIN)
  if (pattern?.options) {
    const pendingDcl: Array<(event: Event) => void> = []
    const origAddEventListener = document.addEventListener.bind(document)
    function patchedAddEventListener(type: string, listener: unknown, options?: unknown): void {
      if (type === 'DOMContentLoaded' && typeof listener === 'function' && document.readyState !== 'loading') {
        pendingDcl.push(listener as (event: Event) => void)
        return
      }
      ;(origAddEventListener as (...args: unknown[]) => void)(type, listener, options)
    }
    document.addEventListener = patchedAddEventListener as typeof document.addEventListener
    try {
      const runOptions = new Function('chrome', pattern.options) as (chrome: unknown) => void
      runOptions(makeShellChrome(TEMPLATES_PLUGIN))
    } catch (err) {
      console.warn('[templates] options init failed:', err)
    } finally {
      document.addEventListener = origAddEventListener
    }
    for (const cb of pendingDcl) {
      try {
        cb(new Event('DOMContentLoaded'))
      } catch (err) {
        console.warn('[templates] options DCL callback failed:', err)
      }
    }
  }
  // Список применения — живой: обновляем при изменении шаблонов
  window.shell.onPluginDataChanged(({ plugin }) => {
    if (plugin === TEMPLATES_PLUGIN && templatesOpen) void refreshTemplatesList()
  })
}

// Клик строго по фону оверлея (мимо карточки) закрывает модалку
function wireOverlayDismiss(): void {
  const pairs: Array<[HTMLElement | null, () => void]> = [
    [settingsOverlay, closeSettings],
    [accountsOverlay, closeAccounts],
    [downloadsOverlay, closeDownloads],
    [tabsOverlay, closeTabs],
    [templatesOverlay, closeTemplates],
    [templatesManageOverlay, closeTemplatesManage],
  ]
  for (const [overlay, close] of pairs) {
    overlay?.addEventListener('click', (event: MouseEvent) => {
      if (event.target === overlay) close()
    })
  }
}

function applyAppVersion(): void {
  const el = document.getElementById('app-version') as HTMLElement | null
  if (!el) return
  window.shell.getVersion().then((v) => {
    if (v) el.textContent = 'v' + v
  }).catch(() => { /* noop */ })
}

async function init(): Promise<void> {
  config = await window.shell.getConfig()
  plugins = await window.shell.getPlugins()
  try {
    allPlugins = await window.shell.getAllPlugins()
  } catch {
    allPlugins = []
  }
  applyAppVersion()

  wireToolbar()
  wireShortcuts()
  wireFindbar()
  wireErrorOverlay()
  wireSettings()
  wireDownloads()
  wireTemplates()
  wireTabs()
  wireUpdater()
  wireOverlayDismiss()
  wireWebviewEvents()
  startStatusPolling()
  startSewHelperBridge()
  startScansBridge()
  // Данные плагинов меняются из оверлеев оболочки — перепушиваем снапшот в страницу
  window.shell.onPluginDataChanged(() => void pushPluginStores())
  // Живые обновления папки сканов: main шлёт 'scans:changed' при каждом изменении —
  // форвардим список в гостя событием 'scans-block:update' (блок перерисуется сам).
  window.shell.onScansChanged((files) => {
    void guestJS<void>(
      'scans-push',
      '(function(list){try{window.dispatchEvent(new CustomEvent("scans-block:update",{detail:list}))}catch(e){}})(' +
        JSON.stringify(files ?? []) +
        ')',
    ).catch(() => {
      // страница не готова — гость подтянет список сам через bridgeSend('list')
    })
  })

  if (addressInput) addressInput.value = config.startUrl
  lastAllowedUrl = config.startUrl
  // Стартовую навигацию задаём атрибутом src — срабатывает даже до attach webview
  webview.setAttribute('src', config.startUrl)
  renderStrip()
  setStatus(config.debug ? 'debug' : '')
}

void init().catch((err) => {
  console.error('[shell] init failed:', err)
  setStatus(`init: ${String(err)}`)
})
