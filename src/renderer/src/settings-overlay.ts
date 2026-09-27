import { setStatus } from './status-ui'
import { normalizeUrl, formatSize, withTimeout, errText } from './util'
import { guestJS } from './guest'
import { activeTab, listTabs } from './tabs'
import {
  normalizeTnAlertTtl,
  playTnSound,
  resetTnCustomAudio,
  setTnSoundFile,
  setTnSoundFiles,
  tnSoundFile,
} from './bridges'
import { checkForUpdatesManually } from './updatebar'

export interface SettingsDeps {
  config(): ShellConfig | null
  setConfig(patch: Partial<ShellConfig>): Promise<ShellConfig>
  plugins(): PluginInfo[]
  allPlugins(): { name: string; enabled: boolean }[]
  /** Прогнать новый startUrl: обновить адресную строку и уйти на страницу. */
  gotoStartUrl(url: string): void
}

let deps: SettingsDeps
let config: ShellConfig | null = null

export function initSettings(d: SettingsDeps): void {
  deps = d
  config = d.config()
}

const el = {
  overlay: () => document.getElementById('settings-overlay') as HTMLElement | null,
  startUrl: () => document.getElementById('set-starturl') as HTMLInputElement | null,
  allowlistEnabled: () => document.getElementById('set-allowlist-enabled') as HTMLInputElement | null,
  allowlist: () => document.getElementById('set-allowlist') as HTMLTextAreaElement | null,
  plugins: () => document.getElementById('set-plugins') as HTMLElement | null,
  tnObjectId: () => document.getElementById('set-tn-objectid') as HTMLInputElement | null,
  tnInterval: () => document.getElementById('set-tn-interval') as HTMLInputElement | null,
  tnAlertTtl: () => document.getElementById('set-tn-alert-ttl') as HTMLInputElement | null,
  tnSound: () => document.getElementById('set-tn-sound') as HTMLInputElement | null,
  tnSoundName: () => document.getElementById('set-tn-sound-name') as HTMLElement | null,
  tnSoundHoName: () => document.getElementById('set-tn-sound-ho-name') as HTMLElement | null,
  storageUsage: () => document.getElementById('set-storage-usage') as HTMLElement | null,
  cookies: () => document.getElementById('set-cookies') as HTMLElement | null,
  clearOnExit: () => document.getElementById('set-clear-on-exit') as HTMLSelectElement | null,
  scannerApp: () => document.getElementById('set-scanner-app') as HTMLInputElement | null,
  scannerArgs: () => document.getElementById('set-scanner-args') as HTMLInputElement | null,
  scanFoldersList: () => document.getElementById('set-scan-folders') as HTMLElement | null,
}

export function isSettingsOpen(): boolean {
  return el.overlay()?.hidden === false
}

export function settingsOverlayEl(): HTMLElement | null {
  return el.overlay()
}

/** Настройки tasks-notify из plugin-data (тот же ключ 'settings', что читает гость каждый тик) */
async function loadTnSettings(): Promise<void> {
  try {
    const data = await window.shell.pluginDataGet('tasks-notify', ['settings'])
    const s = (data?.settings ?? {}) as { objectId?: unknown; intervalSec?: unknown; alertTtlSec?: unknown; sound?: unknown; soundFile?: unknown; soundName?: unknown; soundFileHo?: unknown; soundNameHo?: unknown }
    const setTnObjectId = el.tnObjectId()
    const setTnInterval = el.tnInterval()
    const setTnAlertTtl = el.tnAlertTtl()
    const setTnSound = el.tnSound()
    const setTnSoundName = el.tnSoundName()
    const setTnSoundHoName = el.tnSoundHoName()
    if (setTnObjectId) setTnObjectId.value = typeof s.objectId === 'string' && s.objectId ? s.objectId : 'S187'
    if (setTnInterval) {
      setTnInterval.value = String(
        typeof s.intervalSec === 'number' && s.intervalSec >= 15 ? Math.floor(s.intervalSec) : 60,
      )
    }
    if (setTnAlertTtl) setTnAlertTtl.value = String(normalizeTnAlertTtl(s.alertTtlSec))
    if (setTnSound) setTnSound.checked = s.sound !== false
    setTnSoundFiles(
      typeof s.soundFile === 'string' ? s.soundFile : '',
      typeof s.soundFileHo === 'string' ? s.soundFileHo : '',
    )
    if (setTnSoundName) {
      setTnSoundName.textContent =
        tnSoundFile('rel') && typeof s.soundName === 'string' && s.soundName ? s.soundName : 'Стандартный звук'
    }
    if (setTnSoundHoName) {
      setTnSoundHoName.textContent =
        tnSoundFile('ho') && typeof s.soundNameHo === 'string' && s.soundNameHo ? s.soundNameHo : 'Стандартный звук'
    }
  } catch (err) {
    console.warn('[shell] failed to load tasks-notify settings:', err)
  }
}

export function openSettings(): void {
  if (!config || !el.overlay()) return
  const setStartUrl = el.startUrl()
  const setAllowlistEnabled = el.allowlistEnabled()
  const setAllowlist = el.allowlist()
  const setPlugins = el.plugins()
  const setClearOnExit = el.clearOnExit()
  if (setStartUrl) setStartUrl.value = config.startUrl
  if (setAllowlistEnabled) setAllowlistEnabled.checked = config.allowlistEnabled
  if (setAllowlist) setAllowlist.value = config.allowlist.join('\n')
  if (setPlugins) {
    setPlugins.innerHTML = ''
    // Показываем ВСЕ плагины (включая выключенные), иначе выключенный
    // пропадал из списка и его нельзя было включить обратно.
    const allPlugins = deps.allPlugins()
    const plugins = deps.plugins()
    const list = allPlugins.length > 0 ? allPlugins : plugins.map((p) => ({ name: p.name, enabled: true }))
    for (const plugin of list) {
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.dataset.plugin = plugin.name
      checkbox.checked = config!.plugins[plugin.name] ?? plugin.enabled ?? true
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
  void loadTnSettings()
  const setScannerApp = el.scannerApp()
  const setScannerArgs = el.scannerArgs()
  if (setScannerApp) setScannerApp.value = config.scannerAppPath ?? ''
  if (setScannerArgs) setScannerArgs.value = (config as ShellConfig).scannerAppArgs ?? ''
  void renderScanFolders()
  el.overlay()!.hidden = false
  void refreshStoragePanel()
}

export function closeSettings(): void {
  const overlay = el.overlay()
  if (overlay) overlay.hidden = true
}

async function saveSettings(): Promise<void> {
  if (!config) return
  const setPlugins = el.plugins()
  const setStartUrl = el.startUrl()
  const setAllowlistEnabled = el.allowlistEnabled()
  const setAllowlist = el.allowlist()
  const setClearOnExit = el.clearOnExit()
  const setScannerApp = el.scannerApp()
  const setScannerArgs = el.scannerArgs()
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
    config = await deps.setConfig(patch)
    // Настройки tasks-notify — в plugin-data плагина; гость подхватит со следующего тика.
    // Пишем отдельно: их падение не отменяет уже сохранённый основной конфиг.
    try {
      const setTnInterval = el.tnInterval()
      const setTnAlertTtl = el.tnAlertTtl()
      const setTnSound = el.tnSound()
      const setTnObjectId = el.tnObjectId()
      const setTnSoundName = el.tnSoundName()
      const setTnSoundHoName = el.tnSoundHoName()
      const tnInterval = Math.floor(Number(setTnInterval?.value))
      const tnAlertTtl = normalizeTnAlertTtl(setTnAlertTtl?.value)
      await window.shell.pluginDataSet('tasks-notify', {
        settings: {
          objectId: setTnObjectId?.value.trim() || 'S187',
          intervalSec: Number.isFinite(tnInterval) && tnInterval >= 15 ? tnInterval : 60,
          alertTtlSec: tnAlertTtl,
          sound: setTnSound?.checked !== false,
          soundFile: tnSoundFile('rel'),
          soundName: setTnSoundName?.textContent ?? '',
          soundFileHo: tnSoundFile('ho'),
          soundNameHo: setTnSoundHoName?.textContent ?? '',
        },
      })
    } catch (tnErr) {
      console.warn('[shell] failed to save tasks-notify settings:', tnErr)
      setStatus('настройки сохранены, но настройки уведомлений — нет')
      return
    }
    closeSettings()
    setStatus('настройки сохранены')
    if (config.startUrl !== oldStartUrl) {
      deps.gotoStartUrl(config.startUrl)
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
    // Сессия общая для всего окна — перезагружаем ВСЕ вкладки, иначе неактивные
    // продолжают рендерить залогиненную SEW до ручного F5.
    for (const tab of listTabs()) {
      try {
        tab.view.reload()
      } catch (err) {
        console.warn('[shell] tab reload failed:', err)
      }
    }
    setStatus('сессия очищена')
  } catch (err) {
    console.warn('[shell] failed to clear session:', err)
    setStatus('не удалось очистить сессию')
  }
}

async function renderScanFolders(): Promise<void> {
  const setScanFoldersList = el.scanFoldersList()
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
      config = await deps.setConfig({ scanFolders: next })
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
    const setScannerApp = el.scannerApp()
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
      config = await deps.setConfig({ scanFolders: [...current, { path }] })
      void renderScanFolders()
    } catch (err) {
      console.warn('[shell] scans:browse-folder failed:', err)
    }
  })
  const setTnSoundName = el.tnSoundName()
  const setTnSoundHoName = el.tnSoundHoName()
  const wireTnSoundSlot = (
    slot: 'rel' | 'ho',
    pickId: string,
    previewId: string,
    resetId: string,
    nameEl: HTMLElement | null,
    setFile: (v: string) => void,
  ): void => {
    document.getElementById(pickId)?.addEventListener('click', async () => {
      try {
        const picked = await window.shell.pickSound(slot)
        if (!picked) return
        setFile(picked.file)
        resetTnCustomAudio(slot)
        if (nameEl) nameEl.textContent = picked.name
      } catch (err) {
        console.warn('[shell] sound:pick failed:', err)
      }
    })
    document.getElementById(previewId)?.addEventListener('click', () => {
      void playTnSound(slot)
    })
    document.getElementById(resetId)?.addEventListener('click', async () => {
      try {
        await window.shell.clearSound(slot)
      } catch (err) {
        console.warn('[shell] sound:clear failed:', err)
      }
      setFile('')
      resetTnCustomAudio(slot)
      if (nameEl) nameEl.textContent = 'Стандартный звук'
    })
  }
  wireTnSoundSlot('rel', 'set-tn-sound-pick', 'set-tn-sound-preview', 'set-tn-sound-reset', setTnSoundName,
    (v) => setTnSoundFile('rel', v))
  wireTnSoundSlot('ho', 'set-tn-sound-ho-pick', 'set-tn-sound-ho-preview', 'set-tn-sound-ho-reset', setTnSoundHoName,
    (v) => setTnSoundFile('ho', v))
  document.getElementById('set-clear-session')?.addEventListener('click', () => void clearSessionAndLogout())
  document.getElementById('set-reload-app')?.addEventListener('click', () => {
    // Ручная проверка обновлений на GitHub. Если версия есть — покажется
    // updatebar «Доступно обновление», если нет — тост «у вас последняя версия».
    closeSettings()
    checkForUpdatesManually()
  })
  document
    .getElementById('set-clear-cache')
    ?.addEventListener('click', () => void clearStorageTarget('cache'))
  document
    .getElementById('set-clear-cookies')
    ?.addEventListener('click', () => void clearStorageTarget('cookies'))
  el.startUrl()?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') void saveSettings()
  })
}

export { wireSettings }

// ---------- Хранилище: использование, куки, выборочная очистка ----------

function renderCookies(cookies: CookieInfo[]): void {
  const setCookies = el.cookies()
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

/** IPC с таймаутом: зависший вызов превращается в читаемую ошибку, а не вечное «считаем…» */
async function refreshStoragePanel(): Promise<void> {
  const setStorageUsage = el.storageUsage()
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
    const tab = activeTab()
    if (tab) {
      try {
        const estimate = (await guestJS<{ usage: number } | null>(
          tab,
          'storage-estimate',
          'navigator.storage && navigator.storage.estimate ' +
            '? navigator.storage.estimate().then((e) => ({ usage: e.usage ?? 0 })).catch(() => null) ' +
            ': Promise.resolve(null)',
        ))
        if (estimate) parts.push(`данные сайта: ${formatSize(estimate.usage)}`)
      } catch {
        // страница не готова — показываем без данных сайта
      }
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
    if (target === 'cookies') {
      // Куки общие для всего окна — перезагружаем ВСЕ вкладки, иначе неактивные
      // продолжают рендерить залогиненную SEW до ручного F5.
      for (const tab of listTabs()) {
        try {
          tab.view.reload()
        } catch (err) {
          console.warn('[shell] tab reload failed:', err)
        }
      }
    }
    await refreshStoragePanel()
    setStatus(target === 'cache' ? 'кэш очищен' : 'куки очищены')
  } catch (err) {
    console.warn('[shell] clear storage failed:', err)
    setStatus('не удалось очистить')
  }
}
