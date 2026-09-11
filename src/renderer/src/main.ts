import './styles.css'

const webview = document.getElementById('site') as unknown as SewWebViewElement
const addressInput = document.getElementById('address') as HTMLInputElement | null
const statusEl = document.getElementById('status') as HTMLElement | null
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

let config: ShellConfig | null = null
let plugins: PluginInfo[] = []
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
  return config.allowlist.some((pattern) => {
    const p = pattern.toLowerCase()
    if (p.startsWith('*.')) {
      const domain = p.slice(2)
      return host === domain || host.endsWith(`.${domain}`)
    }
    return host === p
  })
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text
}

/**
 * Минимальный window.chrome для перенесённых content-скриптов Chrome-расширений.
 * storage.local — через window.shell (файлы плагинов в main-процессе, см. plugins/store.ts),
 * сообщения от оболочки — через window.__chromeShimReceive (fan-out по onMessage-подписчикам).
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
    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || {};
    window.chrome.storage.local = {
      get: function (keys, cb) {
        var k = normKeys(keys);
        return withCallback(
          window.shell.pluginDataGet(pluginName(), k || undefined).then(function (all) { return pick(all, k); }),
          cb,
        );
      },
      set: function (obj, cb) {
        return withCallback(window.shell.pluginDataSet(pluginName(), obj || {}), cb);
      },
      remove: function (keys, cb) {
        return withCallback(window.shell.pluginDataRemove(pluginName(), normKeys(keys) || []), cb);
      },
    };
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
          local: {
            get: function (keys, cb) {
              var k = normKeys(keys);
              return withCallback(
                window.shell.pluginDataGet(plugin, k || undefined).then(function (all) { return pick(all, k); }),
                cb,
              );
            },
            set: function (obj, cb) {
              return withCallback(window.shell.pluginDataSet(plugin, obj || {}), cb);
            },
            remove: function (keys, cb) {
              return withCallback(window.shell.pluginDataRemove(plugin, normKeys(keys) || []), cb);
            },
          },
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
      await webview.executeJavaScript(CHROME_SHIM)
      if (!plugin.code) continue
      const key = JSON.stringify(plugin.name)
      await webview.executeJavaScript(
        `window.__shellPluginName = ${key};` +
          `window.__shellPlugins = window.__shellPlugins || {};` +
          `if (!window.__shellPlugins[${key}]) {` +
          // Код выполняется в IIFE с собственным `chrome`, привязанным к стору
          // этого плагина: отложенные вызовы (наблюдатели, обработчики) видят
          // свои данные, а не 'default' (имя в __shellPluginName уже сброшено).
          `window.__shellPlugins[${key}] = 1;\n(() => {\nconst chrome = window.__shellChromeFor(${key});\n${plugin.code}\n})();}`,
      )
      if (plugin.init) {
        try {
          await webview.executeJavaScript(plugin.init)
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
    await webview.executeJavaScript('window.__shellPluginName = null;')
  } catch {
    // страница могла уже уйти — игнорируем
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
    for (const plugin of plugins) {
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.dataset.plugin = plugin.name
      checkbox.checked = config.plugins[plugin.name] ?? true
      label.append(checkbox, document.createTextNode(plugin.name))
      setPlugins.append(label)
    }
    if (plugins.length === 0) {
      const empty = document.createElement('span')
      empty.textContent = 'Нет загруженных плагинов'
      setPlugins.append(empty)
    }
  }
  if (setClearOnExit) setClearOnExit.value = config.clearOnExit
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

function wireSettings(): void {
  document.getElementById('btn-settings')?.addEventListener('click', openSettings)
  document.getElementById('set-save')?.addEventListener('click', () => void saveSettings())
  document.getElementById('set-cancel')?.addEventListener('click', closeSettings)
  document.getElementById('set-clear-session')?.addEventListener('click', () => void clearSessionAndLogout())
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
      const estimate = (await webview.executeJavaScript(
        'navigator.storage && navigator.storage.estimate ' +
          '? navigator.storage.estimate().then((e) => ({ usage: e.usage ?? 0 })).catch(() => null) ' +
          ': Promise.resolve(null)',
      )) as { usage: number } | null
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
    const found = await webview.executeJavaScript(
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
    await webview.executeJavaScript(script)
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
  document.getElementById('btn-reload')?.addEventListener('click', () => webview.reload())
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
      const count = await webview.executeJavaScript('(window.__sewDataLog || []).length')
      setStatus(config?.debug ? `req: ${count} · debug` : `req: ${count}`)
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
        setStatus('не удалось скачать обновление')
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
      updaterState = 'available'
      updaterVersion = event.version ?? ''
    } else if (event.type === 'progress') {
      updaterState = 'downloading'
      updaterPercent = event.percent ?? 0
    } else if (event.type === 'ready') {
      updaterState = 'ready'
      updaterVersion = event.version ?? updaterVersion
    } else {
      // error — показываем только если пользователь уже в процессе
      if (updaterState === 'idle') return
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
    const delivered = (await webview.executeJavaScript(
      `typeof window.__chromeShimReceive === 'function'` +
        ` ? (window.__chromeShimReceive({action:'applyTemplate',templateId:${JSON.stringify(id)}}), true)` +
        ` : false`,
    )) as boolean
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
    [templatesOverlay, closeTemplates],
    [templatesManageOverlay, closeTemplatesManage],
  ]
  for (const [overlay, close] of pairs) {
    overlay?.addEventListener('click', (event: MouseEvent) => {
      if (event.target === overlay) close()
    })
  }
}

async function init(): Promise<void> {
  config = await window.shell.getConfig()
  plugins = await window.shell.getPlugins()

  wireToolbar()
  wireShortcuts()
  wireFindbar()
  wireErrorOverlay()
  wireSettings()
  wireDownloads()
  wireTemplates()
  wireUpdater()
  wireOverlayDismiss()
  wireWebviewEvents()
  startStatusPolling()

  if (addressInput) addressInput.value = config.startUrl
  lastAllowedUrl = config.startUrl
  // Стартовую навигацию задаём атрибутом src — срабатывает даже до attach webview
  webview.setAttribute('src', config.startUrl)
  setStatus(config.debug ? 'debug' : '')
}

void init().catch((err) => {
  console.error('[shell] init failed:', err)
  setStatus(`init: ${String(err)}`)
})
