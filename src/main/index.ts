import { app, BrowserWindow, Notification, globalShortcut, ipcMain, net, session, webContents, Menu, dialog, shell, clipboard } from 'electron'
import type { Input, MenuItemConstructorOptions, WebContents } from 'electron'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { autoUpdater } from 'electron-updater'
import { getConfig, isDebugMode, saveConfig } from './config'
import { loadPlugins } from './plugins/loader'
import { getPluginData, removePluginData, setPluginData } from './plugins/store'
import { getAccountSecrets, getLastUsedAccountId, listAccounts, removeAccount, saveAccount, setLastUsedAccountId } from './credentials/store'
import { appendDownloadRecord, clearDownloadHistory, loadDownloadHistory, removeDownloadRecord } from './downloads/history'
import { combinePagesToPdf, detectWiaDevices, scanViaWia, type ScanPageInput } from './scanner'

let mainWindow: BrowserWindow | null = null

/**
 * Маппинг клавиш гостевой страницы в имена шорткатов оболочки.
 * Буквы — по input.code (не зависит от раскладки: Ctrl+Ф = Ctrl+A и т.п.).
 */
function guestShortcutName(input: Input): string | null {
  const mod = input.control || input.meta
  const { key, code } = input
  if (key === 'F5') return mod ? 'hard-reload' : 'reload'
  if (mod && code === 'KeyR') return 'reload'
  if (mod && input.shift && code === 'KeyL') return 'accounts'
  if (mod && input.shift && code === 'KeyT') return 'templates'
  if (mod && code === 'KeyL') return 'focus-address'
  if (mod && code === 'KeyF') return 'find'
  if (mod && code === 'KeyP') return 'print'
  if (mod && (key === '=' || key === '+' || key === 'Add' || key === 'numadd')) return 'zoom-in'
  if (mod && (key === '-' || key === '_' || key === 'Subtract' || key === 'numsub')) return 'zoom-out'
  if (mod && key === '0') return 'zoom-reset'
  if (mod && code === 'Comma') return 'settings'
  if (input.alt && (key === 'Left' || key === 'ArrowLeft')) return 'back'
  if (input.alt && (key === 'Right' || key === 'ArrowRight')) return 'forward'
  if (key === 'F11') return 'fullscreen'
  if (key === 'Escape' || key === 'Esc') return 'escape'
  return null
}

/** Схемы, которые разрешено открывать во внешнем приложении */
const EXTERNAL_SCHEME_RE = /^(https?|mailto|tel):/i

/** Единственные URL, доступные через fetch-мост 'net:fetch' (BFF mvideo для sew-helper) */
const BFF_URL_RE = /^https:\/\/www\.mvideo\.ru\/(bff\/product-details\?productId=[\w-]+|products\/[\w-]+)\/?$/

/** Серверная копия allowlist-проверки (renderer делает то же самое локально) */
function isAllowedUrl(url: string): boolean {
  const config = getConfig()
  if (!config.allowlistEnabled) return true
  let host = ''
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return false
  }
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

function createWindow(): void {
  const config = getConfig()
  const debug = isDebugMode()
  const plugins = loadPlugins(config)

  // Иконка окна в dev (в сборке иконку exe ставит electron-builder из resources/icon.png)
  const devIcon = join(__dirname, '..', '..', 'resources', 'icon.png')

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    frame: false,
    icon: existsSync(devIcon) ? devIcon : undefined,
    webPreferences: {
      // NB: preload выполняется в песочнице — node-глобалов
      // (__filename, __dirname) внутри него нет.
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      webviewTag: true,
    },
  })

  // Dev-URL выставляет electron-vite (см. AGENTS.md, ловушка 10)
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  console.log('[SEWBrowser] startUrl:', config.startUrl)
  if (debug) {
    mainWindow.webContents.openDevTools()
    // В debug-режиме HTTP-кэш чистим на старте, чтобы разработка шла
    // на свежих файлах. Инжектируемый код плагинов и так всегда свежий —
    // он читается с диска при каждой загрузке страницы.
    session.defaultSession.clearCache().catch((err) => console.warn('[SEWBrowser] clearCache failed:', err))
  }

  // Шорткаты из плагинов (main-процесс)
  for (const plugin of plugins) {
    const hotkeys = plugin.manifest.hotkeys
    if (!hotkeys) continue
    for (const [combo, action] of Object.entries(hotkeys)) {
      try {
        globalShortcut.register(combo, () => {
          new Notification({ title: action.title ?? combo, body: action.body ?? '' })
          console.log(`[plugins:${plugin.name}] hotkey ${combo} triggered`)
        })
      } catch (err) {
        console.warn(`[plugins:${plugin.name}] failed to register ${combo}:`, err)
      }
    }
  }

  // IPC для shell-UI
  ipcMain.handle('config:get', () => ({ ...getConfig(), debug }))
  ipcMain.handle('config:set', (_event, patch) => saveConfig((patch ?? {}) as Parameters<typeof saveConfig>[0]))
  ipcMain.handle('plugins:list', () =>
    plugins.map((p) => ({
      name: p.name,
      code: p.code ?? '',
      styles: p.styles ?? '',
      init: p.manifest.init ?? '',
      options: p.options ?? '',
    })),
  )
  ipcMain.handle('session:clear', async () => {
    await session.defaultSession.clearCache()
    await session.defaultSession.clearStorageData()
    console.log('[SEWBrowser] session storage cleared')
    return true
  })
  // ---------- Хранилище данных плагинов (замена chrome.storage.local) ----------
  ipcMain.handle('plugin-data:get', (_event, plugin: unknown, keys: unknown) => {
    if (typeof plugin !== 'string') return {}
    const list = Array.isArray(keys)
      ? keys.filter((k): k is string => typeof k === 'string')
      : undefined
    return getPluginData(plugin, list)
  })
  ipcMain.handle('plugin-data:set', (_event, plugin: unknown, obj: unknown) => {
    if (typeof plugin !== 'string' || !obj || typeof obj !== 'object') return false
    const ok = setPluginData(plugin, obj as Record<string, unknown>)
    if (ok) mainWindow?.webContents.send('plugin-data:changed', { plugin })
    return ok
  })
  ipcMain.handle('plugin-data:remove', (_event, plugin: unknown, keys: unknown) => {
    if (typeof plugin !== 'string' || !Array.isArray(keys)) return false
    const ok = removePluginData(plugin, keys.filter((k): k is string => typeof k === 'string'))
    if (ok) mainWindow?.webContents.send('plugin-data:changed', { plugin })
    return ok
  })
  // Полный снапшот данных всех плагинов — оболочка пушит его в гостевую страницу,
  // т.к. у <webview> нет preload и window.shell в странице SEW отсутствует
  ipcMain.handle('plugin-data:get-all', () => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const p of plugins) out[p.name] = getPluginData(p.name)
    return out
  })
  // ---------- Узкий fetch-мост для плагинов (BFF mvideo) ----------
  // Гость не может ходить в BFF напрямую: BFF отдаёт ACAO только www.mvideo.ru,
  // из страницы SEW запрос режется CORS. net.fetch CORS не подвержен, а куки
  // у него общие с webview (default session). URL строго из allowlist ниже.
  ipcMain.handle('net:fetch', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !BFF_URL_RE.test(url)) return { ok: false, status: 0, data: null }
    try {
      const sku = /productId=([\w-]+)/.exec(url)?.[1]
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (sku) {
        // прогрев кук — зеркалит ensureCookies() из background.js расширения
        try {
          await (await net.fetch(`https://www.mvideo.ru/products/${sku}`)).text()
        } catch {
          // прогрев не критичен — пробуем BFF как есть
        }
        headers.Referer = `https://www.mvideo.ru/products/${sku}`
      }
      const res = await net.fetch(url, { headers })
      let data: unknown = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      return { ok: res.ok, status: res.status, data }
    } catch {
      return { ok: false, status: 0, data: null }
    }
  })
  // HTTP-кэш НЕ входит в clearStorageData — для него отдельный clearCache().
  ipcMain.handle('storage:usage', async () => {
    const ses = session.defaultSession
    const [cacheBytes, cookies] = await Promise.all([ses.getCacheSize(), ses.cookies.get({})])
    return { cacheBytes, cookieCount: cookies.length }
  })
  ipcMain.handle('storage:clear', async (_event, target: unknown) => {
    const ses = session.defaultSession
    if (target === 'cache') {
      await ses.clearCache()
    } else if (target === 'cookies') {
      await ses.clearStorageData({ storages: ['cookies'] })
    } else {
      await ses.clearCache()
      await ses.clearStorageData()
    }
    console.log('[SEWBrowser] storage cleared:', target)
    return true
  })
  // Значения куки НЕ отдаём в renderer — там только имена/домены/метаданные
  ipcMain.handle('cookies:list', async () => {
    const all = await session.defaultSession.cookies.get({})
    return all
      .map((c) => ({
        name: c.name,
        domain: c.domain ?? '',
        path: c.path ?? '/',
        secure: c.secure ?? false,
        httpOnly: c.httpOnly ?? false,
        session: c.session ?? false,
        expirationDate: c.expirationDate,
        size: c.name.length + (c.value ?? '').length,
      }))
      .sort((a, b) => `${a.domain}${a.name}`.localeCompare(`${b.domain}${b.name}`))
  })
  ipcMain.handle('cookies:remove', async (_event, cookie: unknown) => {
    const c = (cookie ?? {}) as { name?: unknown; domain?: unknown; path?: unknown; secure?: unknown }
    if (typeof c.name !== 'string' || !c.name) return false
    const host = typeof c.domain === 'string' ? c.domain.replace(/^\./, '') : ''
    if (!host) return false
    const scheme = c.secure === true ? 'https' : 'http'
    const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/'
    await session.defaultSession.cookies.remove(`${scheme}://${host}${path}`, c.name)
    return true
  })
  // ---------- Аккаунты SEW ----------
  // Пароли лежат в шифрохранилище ОС (см. credentials/store.ts).
  // Расшифровка выдаётся только для автозаполнения формы входа.
  ipcMain.handle('credentials:list', () => listAccounts())
  ipcMain.handle('credentials:save', (_event, input: unknown) => {
    const v = (input ?? {}) as { id?: unknown; fio?: unknown; tabNum?: unknown; password?: unknown }
    return saveAccount({
      id: typeof v.id === 'string' ? v.id : undefined,
      fio: typeof v.fio === 'string' ? v.fio : '',
      tabNum: typeof v.tabNum === 'string' ? v.tabNum : '',
      password: typeof v.password === 'string' ? v.password : '',
    })
  })
  ipcMain.handle('credentials:remove', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return false
    return removeAccount(id)
  })
  ipcMain.handle('credentials:get', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return null
    const secrets = getAccountSecrets(id)
    // Аккаунт запросили для автовхода — запоминаем, кто сидит (для атрибуции загрузок)
    if (secrets) setLastUsedAccountId(id)
    return secrets
  })
  ipcMain.on('window:min', () => mainWindow?.minimize())
  ipcMain.handle('shell:open-external', (_event, url: unknown) => {
    if (typeof url !== 'string' || !EXTERNAL_SCHEME_RE.test(url.trim())) return false
    void shell.openExternal(url.trim())
    return true
  })
  ipcMain.handle('downloads:show-item', (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath) return false
    shell.showItemInFolder(filePath)
    return true
  })
  // ---------- История загрузок (окно «Загрузки») ----------
  ipcMain.handle('downloads:list', () => loadDownloadHistory())
  ipcMain.handle('downloads:clear', () => clearDownloadHistory())
  ipcMain.handle('downloads:remove', (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return loadDownloadHistory()
    return removeDownloadRecord(id)
  })
  ipcMain.handle('downloads:show', (_event, id: unknown) => {
    const rec = typeof id === 'string' ? loadDownloadHistory().find((r) => r.id === id) : undefined
    if (!rec || !rec.path || !existsSync(rec.path)) return false
    shell.showItemInFolder(rec.path)
    return true
  })
   ipcMain.handle('downloads:open', async (_event, id: unknown) => {
     const rec = typeof id === 'string' ? loadDownloadHistory().find((r) => r.id === id) : undefined
     if (!rec || !rec.path || !existsSync(rec.path)) return false
     await shell.openPath(rec.path)
     return true
   })
   // ---------- PDF-просмотр (окно с кнопками «Скачать»/«Печать») ----------
   ipcMain.handle('pdf-viewer:save', (_event, payload: unknown) => {
     if (!payload || typeof payload !== 'object') return false
     const { base64, name } = payload as { base64?: unknown; name?: unknown }
     if (typeof base64 !== 'string' || !base64 || typeof name !== 'string') return false
     // Точный размер PDF из standard-base64: на каждые 4 символа — 3 байта минус padding
     const pad = (base64.match(/=+$/) || [''])[0].length
     const bytes = Math.floor(base64.length / 4) * 3 - pad
     // МСК = UTC+3 (без летнего времени)
     const stamp = (() => {
       const d = new Date(Date.now() + 3 * 3600e3)
       const p = (n: number): string => String(n).padStart(2, '0')
       return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
         `-${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`
     })()
     // Реальное имя файла сохраняется; для «дефолтного» названия ставим дату/по МСК
     const base = name.trim()
     const fileName = (base && base.toLowerCase() !== 'документ') ? base : `документ-${stamp}.pdf`
     if (!mainWindow || mainWindow.isDestroyed()) return false
     const filePath = dialog.showSaveDialogSync(mainWindow, {
       title: 'Сохранить документ',
       defaultPath: join(app.getPath('downloads'), fileName),
     })
     if (!filePath) return false
     try {
       writeFileSync(filePath, Buffer.from(base64, 'base64'))
       appendDownloadRecord({
         id: randomUUID(),
         name: fileName,
         path: filePath,
         bytes,
         state: 'done',
         startedAt: new Date().toISOString(),
         finishedAt: new Date().toISOString(),
       })
       return true
      } catch (err) {
        console.warn('[shell] pdf save failed:', err)
        return false
      }
    })
    // Экспорт вкладок в .json: диалог сохранения + запись на диск
    ipcMain.handle('tabs:export', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return false
      const { content, name } = payload as { content?: unknown; name?: unknown }
      if (typeof content !== 'string' || !content || typeof name !== 'string' || !name.trim()) return false
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const fileName = name.trim().endsWith('.json') ? name.trim() : `${name.trim()}.json`
      const filePath = dialog.showSaveDialogSync(mainWindow, {
        title: 'Сохранить вкладки',
        defaultPath: join(app.getPath('downloads'), fileName),
      })
      if (!filePath) return false
      try {
        writeFileSync(filePath, content)
        appendDownloadRecord({
          id: randomUUID(),
          name: fileName,
          path: filePath,
          bytes: Buffer.byteLength(content),
          state: 'done',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        })
        return true
      } catch (err) {
        console.warn('[shell] tabs export failed:', err)
        return false
      }
    })
     ipcMain.handle('pdf-viewer:print', (_event) => {
      const wc = _event.sender
      if (!wc || wc.isDestroyed()) return false
      // print({}) — в Electron 44 обязательный аргумент опций (иначе краш на 'margins')
      try {
        void wc.print({})
        return true
      } catch (err) {
        console.warn('[shell] pdf print failed:', err)
        return false
      }
    })
    // ---------- Сканер (WIA через PowerShell): скан → диалог сохранения в «Загрузки» ----------
    /**
     * Сохранить отсканированные байты в «Загрузки»: диалог сохранения (по умолчанию
     * папка «Загрузки», имя со штамтом по МСК) + запись в историю загрузок оболочки.
     */
    async function saveScanToDownloads(
      buffer: Buffer,
      ext: string,
    ): Promise<{ ok: boolean; error?: string }> {
      const safeExt = ['png', 'jpg', 'bmp', 'gif', 'pdf'].includes(ext) ? (ext as string) : 'jpg'
      // МСК = UTC+3 (без летнего времени) — как у PDF-имён
      const stamp = (() => {
        const d = new Date(Date.now() + 3 * 3600e3)
        const p = (n: number): string => String(n).padStart(2, '0')
        return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
          `-${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`
      })()
      const fileName = `сканирование-${stamp}.${safeExt}`
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'окно оболочки закрыто' }
      const filePath = dialog.showSaveDialogSync(mainWindow, {
        title: 'Сохранить отсканированный документ',
        defaultPath: join(app.getPath('downloads'), fileName),
      })
      if (!filePath) return { ok: false, error: 'отменено' }
      try {
        writeFileSync(filePath, buffer)
        appendDownloadRecord({
          id: randomUUID(),
          name: fileName,
          path: filePath,
          bytes: buffer.length,
          state: 'done',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        })
        return { ok: true }
      } catch (err) {
        console.warn('[shell] scan save failed:', err)
        return { ok: false, error: 'не удалось сохранить файл' }
      }
    }

    // ---------- Сканер (WIA): определение устройств / сканирование / сохранение ----------
    // Сессии многостраничного сканирования: sessionId → отсканированные страницы.
    // Очистка после сохранения защищает long-running main от утечки памяти.
    const scanSessions = new Map<string, ScanPageInput[]>()

    ipcMain.handle('scanner:detect', async () => {
      try {
        return await detectWiaDevices()
      } catch (err) {
        console.warn('[shell] scanner:detect failed:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })

    // Сканирование НЕ сохраняет — возвращает изображение для предосмотра в окне.
    // sessionId === undefined/null — новая сессия (сбрасываем предыдущие страницы);
    // иначе добавляем страницу к существующей сессии (многостраничный режим).
    ipcMain.handle('scanner:scan', async (_event, sessionId?: string) => {
      try {
        const result = await scanViaWia()
        if (!result.ok || !result.buffer) {
          return { ok: false, error: result.error ?? 'сканирование не выполнено' }
        }
        const page: ScanPageInput = { base64: result.buffer.toString('base64'), mime: result.mime }
        if (!sessionId) {
          sessionId = randomUUID()
          scanSessions.set(sessionId, [page])
        } else {
          const existing = scanSessions.get(sessionId)
          if (existing) existing.push(page)
          else scanSessions.set(sessionId, [page])
        }
        return { ok: true, sessionId, count: scanSessions.get(sessionId)!.length, base64: page.base64, mime: result.mime, ext: result.ext }
      } catch (err) {
        console.warn('[shell] scanner:scan failed:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })

    // Собрать все страницы сессии в один PDF и сохранить в «Загрузки».
    ipcMain.handle('scanner:save', async (_event, sessionId?: string) => {
      const pages = typeof sessionId === 'string' ? scanSessions.get(sessionId) : undefined
      if (!pages || pages.length === 0) return { ok: false, error: 'нет данных для сохранения' }
      // Чистим сессию до сборки — защита от утечки в long-running main.
      void scanSessions.delete(sessionId as string)
      try {
        const pdf = await combinePagesToPdf(pages)
        return await saveScanToDownloads(pdf, 'pdf')
      } catch (err) {
        console.warn('[shell] scanner:save pdf failed:', err)
        return { ok: false, error: 'не удалось собрать PDF' }
      }
    })

    ipcMain.on('scanner:open', () => openScanner())
  ipcMain.on('window:max', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:fullscreen', (_event, enable?: boolean) => {
    if (!mainWindow) return false
    const next = typeof enable === 'boolean' ? enable : !mainWindow.isFullScreen()
    mainWindow.setFullScreen(next)
    return mainWindow.isFullScreen()
  })

  // Хоткеи внутри гостевой страницы: фокус находится в webview,
  // shell-UI их не видит — перехватываем через before-input-event
  // и пересылаем в renderer, где живёт единый обработчик.
  const attachedGuests = new Set<number>()
  ipcMain.on('guest:attach', (_event, id: number) => {
    if (typeof id !== 'number' || attachedGuests.has(id)) return
    const guest = webContents.fromId(id)
    if (!guest || guest.isDestroyed()) return
    attachedGuests.add(id)
    // Диагностика навигации гостя: видно каждую загрузку и вердикт allowlist
    guest.on('did-navigate', (_navEvent, url) => {
      console.log('[shell] guest nav:', url.slice(0, 200), isAllowedUrl(url) ? '(allowed)' : '(blocked)')
    })
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const name = guestShortcutName(input)
      if (!name) return
      event.preventDefault()
      mainWindow?.webContents.send('shell:shortcut', name)
    })

    // Попапы и window.open (тег webview имеет атрибут allowpopups):
    // разрешённое — в том же окне, остальное — в системный браузер.
    // blob:/data: — сгенерированные страницей файлы («скачать документ» в SPA):
    // will-download их не видит, скачиваем вручную через downloadGuestUrl.
    guest.setWindowOpenHandler(({ url }) => {
      const target = url.trim()
      console.log('[shell] window.open:', target.slice(0, 200))
      if (/^(blob|data):/i.test(target)) {
        void downloadGuestUrl(guest, target)
        return { action: 'deny' }
      }
      if (!EXTERNAL_SCHEME_RE.test(target)) {
        console.log('[shell] window.open denied (non-external scheme):', target.slice(0, 200))
        return { action: 'deny' }
      }
      if (!/^https?:/i.test(target)) {
        void shell.openExternal(target)
        return { action: 'deny' }
      }
      if (isAllowedUrl(target)) {
        if (!guest.isDestroyed()) {
          void guest.loadURL(target).catch((err) => console.warn('[shell] popup nav failed:', err))
        }
      } else {
        void shell.openExternal(target)
      }
      return { action: 'deny' }
    })

    // Контекстное меню — у webview его нет из коробки,
    // строим в main по параметрам гостевого webContents.
    guest.on('context-menu', (_menuEvent, params) => {
      if (!mainWindow || mainWindow.isDestroyed() || guest.isDestroyed()) return
      const template: MenuItemConstructorOptions[] = []
      const link = params.linkURL
      if (link) {
        template.push(
          {
            label: 'Открыть ссылку',
            click: () => {
              if (guest.isDestroyed()) return
              if (/^https?:/i.test(link) && isAllowedUrl(link)) {
                void guest.loadURL(link).catch((err) => console.warn('[shell] link nav failed:', err))
              } else if (EXTERNAL_SCHEME_RE.test(link)) {
                void shell.openExternal(link)
              }
            },
          },
          {
            label: 'Открыть ссылку в браузере',
            click: () => {
              if (EXTERNAL_SCHEME_RE.test(link)) void shell.openExternal(link)
            },
          },
          { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(link) },
          { type: 'separator' },
        )
      }
      if (params.mediaType === 'image' && params.srcURL) {
        const src = params.srcURL
        template.push(
          {
            label: 'Сохранить изображение как…',
            click: () => session.defaultSession.downloadURL(src),
          },
          { label: 'Копировать адрес изображения', click: () => clipboard.writeText(src) },
          { type: 'separator' },
        )
      }
      if (params.isEditable) {
        const flags = params.editFlags
        template.push(
          { label: 'Вырезать', enabled: flags.canCut, click: () => { if (!guest.isDestroyed()) guest.cut() } },
          { label: 'Копировать', enabled: flags.canCopy, click: () => { if (!guest.isDestroyed()) guest.copy() } },
          { label: 'Вставить', enabled: flags.canPaste, click: () => { if (!guest.isDestroyed()) guest.paste() } },
          { type: 'separator' },
          { label: 'Выделить всё', enabled: flags.canSelectAll, click: () => { if (!guest.isDestroyed()) guest.selectAll() } },
          { type: 'separator' },
        )
      } else if (params.selectionText.trim()) {
        template.push(
          { label: 'Копировать', click: () => clipboard.writeText(params.selectionText) },
          { type: 'separator' },
        )
      }
      const nav = guest.navigationHistory
      template.push(
        { label: 'Назад', enabled: nav.canGoBack(), click: () => { if (!guest.isDestroyed()) guest.goBack() } },
        { label: 'Вперёд', enabled: nav.canGoForward(), click: () => { if (!guest.isDestroyed()) guest.goForward() } },
        { label: 'Перезагрузить', click: () => { if (!guest.isDestroyed()) guest.reload() } },
        { type: 'separator' },
        { label: 'Печать…', click: () => { if (!guest.isDestroyed()) void guest.print({}) } },
        {
          label: 'Открыть страницу в браузере',
          click: () => {
            if (/^https?:/i.test(params.pageURL)) void shell.openExternal(params.pageURL)
          },
        },
      )
      if (isDebugMode()) {
        template.push(
          { type: 'separator' },
          {
            label: 'Проверить элемент',
            click: () => { if (!guest.isDestroyed()) guest.inspectElement(params.x, params.y) },
          },
        )
      }
      Menu.buildFromTemplate(template).popup({ window: mainWindow })
    })
  })

  // ---------- Загрузки ----------
  // will-download срабатывает для обычных скачиваний (http/https и клики
  // по ссылкам с download-атрибутом). window.open(blob:/data:) сюда НЕ
  // попадает — такие файлы забираем вручную через downloadGuestUrl (ниже).
  let downloadSeq = 0
  const sendDownloadEvent = (id: number, name: string, payload: Record<string, unknown>): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download:event', { id, name, ...payload })
    }
  }

  /** Скачивание blob:/data: URL, открытого через window.open (will-download их не видит) */
  const GUEST_MIME_EXT: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'application/zip': 'zip',
    'image/png': 'png',
    'image/jpeg': 'jpg',
  }
  const MAX_GUEST_FILE_BYTES = 200 * 1024 * 1024

  /**
   * Кто скачивает файл. Приоритет — живая страница (там текущий пользователь
   * даже при ручном входе): ФИО из window.__sewIdentity (см. features/identity).
   * Табельный на странице не светится — берём из аккаунта автовхода, но только
   * если его ФИО совпадает с увиденным на странице (иначе входил другой человек).
   */
  async function resolveAttribution(guest?: WebContents | null): Promise<{ fio?: string; tabNum?: string }> {
    let pageFio = ''
    if (guest && !guest.isDestroyed()) {
      try {
        const ident = (await guest.executeJavaScript('window.__sewIdentity ?? null')) as {
          fio?: unknown
        } | null
        if (ident && typeof ident.fio === 'string' && ident.fio.trim()) {
          pageFio = ident.fio.trim()
        }
      } catch {
        // гость недоступен — довольствуемся аккаунтом
      }
    }
    const lastId = getLastUsedAccountId()
    const acc = lastId ? listAccounts().find((a) => a.id === lastId) : undefined
    if (pageFio) {
      if (acc && acc.fio.trim() === pageFio && acc.tabNum) {
        return { fio: pageFio, tabNum: acc.tabNum }
      }
      return { fio: pageFio }
    }
    if (acc && (acc.fio || acc.tabNum)) {
      return { ...(acc.fio ? { fio: acc.fio } : {}), ...(acc.tabNum ? { tabNum: acc.tabNum } : {}) }
    }
    return {}
  }

  /** Экранирование для вставки имени файла в HTML-атрибуты/строку */
  const htmlEscape = (value: string): string =>
    value.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch]!))

  /** Сборка HTML-страницы PDF-просмотра: тулбар с кнопками «Скачать»/«Печать» + embed viewer'а */
  function buildPdfViewerHtml(dataUrl: string, title: string): string {
    const safeTitle = htmlEscape(title || 'Документ')
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; display: flex; flex-direction: column; background: #3c3f41; }
  #toolbar {
    flex: 0 0 auto; height: 46px; display: flex; align-items: center; gap: 8px;
    padding: 0 12px; background: #2b2d2e; color: #e9e9e9;
    font: 13px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  #toolbar .name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
  #toolbar button {
    background: #3e6dd5; color: #fff; border: 0; padding: 6px 14px; border-radius: 4px;
    cursor: pointer; font: inherit;
  }
  #toolbar button:hover { background: #4a7ae0; }
  #embed { flex: 1 1 auto; width: 100%; height: 100%; border: 0; display: block; }
</style>
</head>
<body>
<div id="toolbar">
  <span class="name">${safeTitle}</span>
  <button id="saveBtn" type="button">Скачать</button>
  <button id="printBtn" type="button">Печать</button>
</div>
<embed id="embed" type="application/pdf" src="${dataUrl}"></embed>
<script>
(function () {
  var embed = document.getElementById('embed');
  document.getElementById('saveBtn').addEventListener('click', function () {
    window.shell.savePdf(embed.getAttribute('src'), ${JSON.stringify(title || 'Документ')});
  });
  document.getElementById('printBtn').addEventListener('click', function () {
    window.shell.printPdf();
  });
})();
</script>
</body>
</html>`
  }

  /** PDF-просмотр: отдельное окно со встроенным viewer'ом Chromium и кнопками «Скачать»/«Печать» */
  function openPdfViewer(dataUrl: string, title: string): void {
    const win = new BrowserWindow({
      width: 1024,
      height: 768,
      minWidth: 480,
      minHeight: 320,
      title,
      icon: existsSync(devIcon) ? devIcon : undefined,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        webviewTag: false,
      },
    })
    // Убираем дефолтное меню Electron (File/Edit/View) — в туларе свои кнопки
    win.setMenu(null)
    const html = buildPdfViewerHtml(dataUrl, title)
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }

  /** Разметка окна сканера: кнопки «Определить сканер»/«Сканировать»/«Сохранить»,
   *  строка статуса и область предосмотра. Предосмотр появляется после скана,
   *  а в «Загрузки» уходит только по нажатию «Сохранить». */
  function buildScannerHtml(): string {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Сканирование</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; display: flex; flex-direction: column; background: #3c3f41; font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; }
  #toolbar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 0 12px; height: 46px; background: #2b2d2e; color: #e9e9e9;
  }
  #toolbar button {
    background: #3e6dd5; color: #fff; border: 0; padding: 6px 14px; border-radius: 4px;
    cursor: pointer; font: inherit;
  }
  #toolbar button:hover { background: #4a7ae0; }
  #toolbar button:disabled { opacity: 0.5; cursor: default; }
  #status { flex: 1 1 auto; min-width: 0; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px; }
  #stage {
    flex: 1 1 auto; display: flex; align-items: center; justify-content: center;
    background: #2b2d2e; overflow: auto; padding: 12px;
  }
  #preview { max-width: 100%; max-height: 100%; background: #fff; box-shadow: 0 0 0 1px rgba(255,255,255,0.15); display: none; }
  #hint { color: #9aa0a4; text-align: center; white-space: pre-line; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="detectBtn" type="button">Определить сканер</button>
  <button id="scanBtn" type="button">Сканировать</button>
  <button id="addBtn" type="button" hidden>Е ещё страницу</button>
  <button id="saveBtn" type="button" disabled>Сохранить</button>
  <span id="status"></span>
</div>
<div id="stage">
  <span id="hint">Нажмите «Определить сканер», затем «Сканировать»<br>Результат появится здесь — сохранить можно кнопкой «Сохранить»<br><br>Если сканер не найден — проверьте, что устройство определено как сканер (не только как принтер), и установлены его драйверы</span>
  <img id="preview" alt="">
</div>
<script>
(function () {
  var statusEl = document.getElementById('status');
  var preview = document.getElementById('preview');
  var hint = document.getElementById('hint');
  var detectBtn = document.getElementById('detectBtn');
  var scanBtn = document.getElementById('scanBtn');
  var addBtn = document.getElementById('addBtn');
  var saveBtn = document.getElementById('saveBtn');
  var sessionId = null;

  function setStatus(text) { statusEl.textContent = text; }

  detectBtn.addEventListener('click', function () {
    setStatus('проверяю сканеры…');
    detectBtn.disabled = true;
    window.shell.detectScanner().then(function (res) {
      detectBtn.disabled = false;
      if (!res || !res.ok) { setStatus(res && res.error ? res.error : 'не удалось проверить сканеры'); return; }
      var devices = (res.devices || []);
      if (devices.length === 0) { setStatus('Сканеры не найдены'); return; }
      setStatus('Найдено сканеров: ' + devices.length + ' — ' + devices.join(', '));
    }).catch(function () { detectBtn.disabled = false; setStatus('ошибка проверки сканеров'); });
  });

  scanBtn.addEventListener('click', function () {
    scanBtn.disabled = true; saveBtn.disabled = true;
    setStatus('сканирование — выберите сканер и отсканируйте документ в диалоге Windows…');
    window.shell.scan(null).then(function (res) {
      if (!res || !res.ok) { setStatus((res && res.error) ? ('ошибка: ' + res.error) : 'сканирование не выполнено'); return; }
      sessionId = res.sessionId || null;
      preview.src = 'data:' + (res.mime || 'image/jpeg') + ';base64,' + res.base64;
      preview.style.display = 'block';
      hint.style.display = 'none';
      saveBtn.disabled = false;
      // Первая страница готова: «Сканировать» заменяем на «Е ещё страницу».
      scanBtn.hidden = true;
      if (addBtn) addBtn.hidden = false;
      setStatus('Отскано · страница ' + (res.count || 1));
    }).catch(function () { scanBtn.disabled = false; setStatus('ошибка сканирования'); });
  });

  // Добавить ещё одну страницу к текущей сессии (многостраничный PDF).
  if (addBtn) {
    addBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      setStatus('сканирование — добавьте ещё страницу в диалоге Windows…');
      window.shell.scan(sessionId).then(function (res) {
        saveBtn.disabled = false;
        if (!res || !res.ok) { setStatus((res && res.error) ? ('ошибка: ' + res.error) : 'сканирование не выполнено'); return; }
        preview.src = 'data:' + (res.mime || 'image/jpeg') + ';base64,' + res.base64;
        setStatus('Отскано · страница ' + (res.count || 1));
      }).catch(function () { setStatus('ошибка сканирования'); });
    });
  }

  saveBtn.addEventListener('click', function () {
    if (!sessionId) return;
    saveBtn.disabled = true;
    window.shell.saveScan(sessionId).then(function (res) {
      saveBtn.disabled = false;
      if (!res || !res.ok) setStatus((res && res.error) ? ('не удалось сохранить: ' + res.error) : 'отменено');
      else setStatus('Сохранено в «Загрузки» — PDF');
    }).catch(function () { saveBtn.disabled = false; setStatus('ошибка сохранения'); });
  });
})();
</script>
</body>
</html>`
  }

  /** Окно сканера: отдельное BrowserWindow со своим preload (window.shell) */
  function openScanner(): void {
    const win = new BrowserWindow({
      width: 720,
      height: 820,
      minWidth: 420,
      minHeight: 520,
      title: 'Сканирование',
      icon: existsSync(devIcon) ? devIcon : undefined,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        webviewTag: false,
      },
    })
    win.setMenu(null)
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildScannerHtml())}`)
  }

  async function downloadGuestUrl(guest: WebContents, url: string): Promise<void> {
    const id = ++downloadSeq
    const startedAt = new Date().toISOString()
    const who = await resolveAttribution(guest)
    const fail = (message: string): void => {
      console.warn('[shell] guest download failed:', message)
      sendDownloadEvent(id, 'файл', { type: 'done', ok: false, state: 'failed' })
      appendDownloadRecord({
        id: randomUUID(),
        name: 'файл',
        path: '',
        bytes: 0,
        state: 'error',
        startedAt,
        finishedAt: new Date().toISOString(),
        ...who,
      })
    }
    try {
      let base64 = ''
      let mime = ''
      let size = 0
      if (/^data:/i.test(url)) {
        // data: разбираем прямо в main — гостевая страница не нужна
        const m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(url)
        if (!m) {
          fail('bad data URL')
          return
        }
        mime = (m[1] || '').toLowerCase()
        base64 = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3]), 'utf8').toString('base64')
        size = Buffer.byteLength(base64, 'base64')
      } else {
        // blob: живёт в контексте страницы — вытягиваем через fetch в госте
        if (guest.isDestroyed()) return
        const res = (await guest.executeJavaScript(
          `(async () => { const res = await fetch(${JSON.stringify(url)});` +
            ' const blob = await res.blob(); const buf = new Uint8Array(await blob.arrayBuffer());' +
            ' let bin = ""; for (let i = 0; i < buf.length; i += 32768)' +
            ' { bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); }' +
            ' return { base64: btoa(bin), mime: blob.type || "", size: blob.size }; })()',
        )) as { base64?: unknown; mime?: unknown; size?: unknown }
        if (!res || typeof res.base64 !== 'string') {
          fail('empty blob')
          return
        }
        base64 = res.base64
        mime = typeof res.mime === 'string' ? res.mime.toLowerCase() : ''
        size = typeof res.size === 'number' ? res.size : Buffer.byteLength(base64, 'base64')
      }
      if (size <= 0 || size > MAX_GUEST_FILE_BYTES) {
        fail(`bad size: ${size}`)
        return
      }
      // PDF → окно просмотра вместо диалога сохранения (там свои кнопки скачать/печать)
      if (mime === 'application/pdf') {
        openPdfViewer(`data:application/pdf;base64,${base64}`, 'Документ')
        return
      }
      const ext = GUEST_MIME_EXT[mime] ?? 'bin'
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const name = `документ-${stamp}.${ext}`
      if (!mainWindow || mainWindow.isDestroyed()) return
      sendDownloadEvent(id, name, { type: 'started' })
      const filePath = dialog.showSaveDialogSync(mainWindow, {
        title: 'Сохранить файл',
        defaultPath: join(app.getPath('downloads'), name),
      })
      if (!filePath) {
        sendDownloadEvent(id, name, { type: 'done', ok: false, cancelled: true })
        return
      }
      writeFileSync(filePath, Buffer.from(base64, 'base64'))
      sendDownloadEvent(id, name, { type: 'progress', received: size, total: size, percent: 100 })
      sendDownloadEvent(id, name, { type: 'done', ok: true, path: filePath, state: 'completed' })
      appendDownloadRecord({
        id: randomUUID(),
        name,
        path: filePath,
        bytes: size,
        state: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        ...who,
      })
    } catch (err) {
      fail(String((err as Error)?.message ?? err))
    }
  }

  session.defaultSession.on('will-download', (_event, item, wc) => {
    console.log('[shell] will-download:', item.getFilename() || item.getURL())
    const id = ++downloadSeq
    const name = item.getFilename() || 'файл'
    const startedAt = new Date().toISOString()
    const send = (payload: Record<string, unknown>): void => sendDownloadEvent(id, name, payload)
    if (!mainWindow || mainWindow.isDestroyed()) {
      item.cancel()
      return
    }
    // PDF по http(s) → окно просмотра вместо диалога сохранения.
    // Байты тянем сами и открываем data URL: при Content-Disposition: attachment
    // прямой loadURL повторно срабатывает will-download (зацикление).
    // data:/blob: в ветку не пускаем — это уже финальный файл (например, из самого viewer'а).
    const url = item.getURL()
    if (/^https?:/i.test(url) && (item.getMimeType() === 'application/pdf' || /\.pdf$/i.test(name))) {
      item.cancel()
      void (async () => {
        try {
          const res = await net.fetch(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const buf = Buffer.from(await res.arrayBuffer())
          openPdfViewer(`data:application/pdf;base64,${buf.toString('base64')}`, name)
        } catch (err) {
          console.warn('[shell] pdf viewer failed:', err)
        }
      })()
      return
    }
    // Синхронный диалог: пока пользователь выбирает путь, скачивание не убегает вперёд
    const filePath = dialog.showSaveDialogSync(mainWindow, {
      title: 'Сохранить файл',
      defaultPath: join(app.getPath('downloads'), name),
    })
    if (!filePath) {
      item.cancel()
      send({ type: 'done', ok: false, cancelled: true })
      return
    }
    item.setSavePath(filePath)
    send({ type: 'started', path: filePath })
    item.on('updated', () => {
      const total = item.getTotalBytes()
      const received = item.getReceivedBytes()
      send({
        type: 'progress',
        received,
        total,
        percent: total > 0 ? Math.round((received / total) * 100) : -1,
      })
    })
    item.on('done', (_doneEvent, state) => {
      const savePath = item.getSavePath()
      const ok = state === 'completed'
      // Отмены в историю не пишем — только завершённые и упавшие
      if (state !== 'cancelled') {
        void (async () => {
          const who = await resolveAttribution(wc)
          appendDownloadRecord({
            id: randomUUID(),
            name,
            path: savePath,
            bytes: item.getTotalBytes(),
            state: ok ? 'done' : 'error',
            startedAt,
            finishedAt: new Date().toISOString(),
            ...who,
          })
        })()
      }
      send({ type: 'done', ok, path: savePath, state })
    })
  })

  // ---------- Разрешения страницы ----------
  const SAFE_PERMISSIONS = new Set(['notifications', 'fullscreen', 'pointerLock'])
  const PROMPT_PERMISSIONS: Record<string, string> = {
    camera: 'камера',
    microphone: 'микрофон',
    geolocation: 'геолокация',
    'clipboard-read': 'чтение буфера обмена',
  }
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (SAFE_PERMISSIONS.has(permission)) {
      callback(true)
      return
    }
    const label = PROMPT_PERMISSIONS[permission]
    if (!label || !mainWindow || mainWindow.isDestroyed()) {
      console.log(`[permissions] denied: ${permission}`)
      callback(false)
      return
    }
    const from = details.requestingUrl ? `\nЗапрашивает: ${details.requestingUrl}` : ''
    void dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Разрешить', 'Запретить'],
        defaultId: 1,
        cancelId: 1,
        title: 'SEWBrowser',
        message: `Страница запрашивает доступ: ${label}.${from}`,
      })
      .then(({ response }) => callback(response === 0))
      .catch(() => callback(false))
  })

  if (debug) console.log('[SEWBrowser] debug mode enabled')
}

app.whenReady().then(() => {
  createWindow()

  // Автообновление через GitHub Releases (только в собранном приложении).
  // Скачивание — только по кнопке пользователя, установка — по кнопке
  // после скачивания. Прогресс уходит в shell-UI событием 'updater:event'.
  if (!process.env.ELECTRON_RENDERER_URL) {
    autoUpdater.autoDownload = false
    const sendUpdater = (payload: Record<string, unknown>): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:event', payload)
      }
    }
    autoUpdater.on('checking-for-update', () => console.log('[updater] checking'))
    autoUpdater.on('update-available', (info) => {
      console.log('[updater] available:', info.version)
      sendUpdater({ type: 'available', version: info.version })
    })
    autoUpdater.on('update-not-available', () => {
      console.log('[updater] up to date')
      sendUpdater({ type: 'uptodate' })
    })
    autoUpdater.on('download-progress', (progress) => {
      sendUpdater({ type: 'progress', percent: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[updater] downloaded:', info.version)
      sendUpdater({ type: 'ready', version: info.version })
    })
    autoUpdater.on('error', (err) => {
      console.log('[updater] error:', err)
      sendUpdater({ type: 'error', message: String(err?.message ?? err) })
    })
    ipcMain.handle('updater:check', async () => {
      // Ручная проверка из настроек. Результат придёт событием
      // 'updater:event' (available | uptodate | error) — как и при автостарте.
      await autoUpdater.checkForUpdates()
      return true
    })
    ipcMain.handle('updater:download', async () => {
      await autoUpdater.downloadUpdate()
      return true
    })
    ipcMain.on('updater:install', () => autoUpdater.quitAndInstall(false, true))
    void autoUpdater.checkForUpdates().catch((err) => console.log('[updater] check failed:', err))
  }
})

app.on('window-all-closed', () => {
  void (async () => {
    const mode = getConfig().clearOnExit
    try {
      if (mode === 'cache') {
        await session.defaultSession.clearCache()
      } else if (mode === 'all') {
        await session.defaultSession.clearCache()
        await session.defaultSession.clearStorageData()
      }
    } catch (err) {
      console.warn('[SEWBrowser] clear-on-exit failed:', err)
    }
    app.quit()
  })()
})
