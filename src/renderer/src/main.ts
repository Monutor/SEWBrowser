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

async function injectPlugins(): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.code) continue
    try {
      await webview.executeJavaScript(plugin.code)
    } catch (err) {
      console.warn(`[plugins:${plugin.name}] injection failed:`, err)
    }
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

async function refreshStoragePanel(): Promise<void> {
  if (setStorageUsage) setStorageUsage.textContent = 'считаем…'
  try {
    const [usage, cookies] = await Promise.all([
      window.shell.getStorageUsage(),
      window.shell.listCookies(),
    ])
    let sitePart = ''
    try {
      const estimate = (await webview.executeJavaScript(
        'navigator.storage && navigator.storage.estimate ' +
          '? navigator.storage.estimate().then((e) => ({ usage: e.usage ?? 0 })).catch(() => null) ' +
          ': Promise.resolve(null)',
      )) as { usage: number } | null
      if (estimate) sitePart = ` · данные сайта: ${formatSize(estimate.usage)}`
    } catch {
      // страница не готова — показываем без данных сайта
    }
    if (setStorageUsage) {
      setStorageUsage.textContent =
        `HTTP-кэш: ${formatSize(usage.cacheBytes)} · куки: ${cookies.length} шт` + sitePart
    }
    renderCookies(cookies)
  } catch (err) {
    console.warn('[shell] storage panel refresh failed:', err)
    if (setStorageUsage) setStorageUsage.textContent = 'не удалось прочитать'
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
  })
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
      if (findActive) closeFind()
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
  webview.addEventListener('did-finish-load', () => void injectPlugins())
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

async function init(): Promise<void> {
  config = await window.shell.getConfig()
  plugins = await window.shell.getPlugins()

  wireToolbar()
  wireShortcuts()
  wireFindbar()
  wireErrorOverlay()
  wireSettings()
  wireDownloads()
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
