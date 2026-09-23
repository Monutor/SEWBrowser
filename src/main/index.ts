import { app, BrowserWindow, ClipboardItem, Notification, globalShortcut, ipcMain, net, session, webContents, Menu, dialog, shell, clipboard } from 'electron'
import type { Input, MenuItemConstructorOptions, WebContents } from 'electron'
import { dirname, join, basename } from 'node:path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { autoUpdater } from 'electron-updater'
import { getConfig, isDebugMode, saveConfig, type ScanFolder } from './config'
import { loadPlugins, listAllPlugins } from './plugins/loader'
import { getPluginData, removePluginData, setPluginData } from './plugins/store'
import { clearFolderPassword, isFolderPasswordEncryptionAvailable, saveFolderPassword, verifyFolderPassword } from './credentials/folderPasswords'
import { getAccountSecrets, getLastUsedAccountId, listAccounts, removeAccount, saveAccount, setLastUsedAccountId } from './credentials/store'
import { appendDownloadRecord, clearDownloadHistory, loadDownloadHistory, removeDownloadRecord } from './downloads/history'
import { screenshotFileName } from './screenshot'
import { clearSoundFile, mimeForSoundExt, readSoundFile, saveSoundFile } from './sounds/store'
import { isSoundSizeOk, isSoundSlot, pickSoundExt } from './sounds/validate'
import {
  createScanWatcher,
  deleteScanFile,
  launchScannerApp,
  collectScanFiles,
  readScanFile,
  stopScanWatcher,
  type ScanFile,
  type ScanFileContent,
} from './scans'

let mainWindow: BrowserWindow | null = null
// Мониторинг папок HP-софта (по одной на каждую папку из scanFolders в настройках).
let scanWatchers: ReturnType<typeof createScanWatcher>[] = []

// Периодическая проверка обновлений (только в собранном приложении).
const UPDATER_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000 // раз в 2 часа
// Если checkForUpdates не ответил за это время — значит GitHub недоступен
// или запрос повис; показываем ошибку вместо вечного «проверяем…».
const UPDATER_CHECK_TIMEOUT_MS = 30 * 1000 // 30 сек
let updaterInterval: NodeJS.Timeout | null = null

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
  if (mod && input.shift && code === 'KeyS') return 'screenshot'
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

/**
 * Санитизация имени файла от remote-источника (getFilename, title PDF):
 * basename против `../`, вырезать запрещённое в Windows, точки/пробелы по краям,
 * лимит длины. Пустое/«дефолтное» — fallback.
 */
function sanitizeFileName(raw: unknown, fallback: string, ext?: string): string {
  let base = typeof raw === 'string' ? raw : ''
  base = basename(base.trim())
  base = base.replace(/[\0-\x1f<>:\"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim()
  if (!base || base.toLowerCase() === 'документ') base = fallback
  if (ext && !new RegExp(`\\.${ext}$`, 'i').test(base)) base = `${base}.${ext}`
  if (base.length > 180) base = base.slice(0, 180)
  return base || fallback
}

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

/** Пересоздать вотчер папки сканов из актуального конфига и слать 'scans:changed' в shell-UI */

/** Собрать все файлы сканов из всех настроенных папок (рекурсивно с подпапками). */
function collectAllScans(): ScanFile[] {
  const folders = getConfig().scanFolders
  if (!Array.isArray(folders)) return []
  const out: ScanFile[] = []
  for (const folder of folders) {
    if (!folder || typeof folder.path !== 'string' || !folder.path || !folder.id) continue
    out.push(...collectScanFiles(folder.path, folder.id))
  }
  return out
}

/** Пересобрать список и расслать 'scans:changed' в shell-UI (по любому изменению любой папки). */
function broadcastScans(): void {
  const files = collectAllScans()
  if (getConfig().debug) console.log(`[shell] в папках сканов: ${files.length} файл(ов)`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scans:changed', files)
  }
}

/** Пересоздать вотчеры всех папок из актуального конфига. */
function restartAllWatchers(): void {
  for (const w of scanWatchers) stopScanWatcher(w)
  scanWatchers = []
  const folders = getConfig().scanFolders
  if (!Array.isArray(folders)) return
  for (const folder of folders) {
    if (!folder || typeof folder.path !== 'string' || !folder.path || !folder.id) continue
    const w = createScanWatcher(folder.path, folder.id, () => broadcastScans(), (err: unknown) => {
      // Папка стала недоступна уже после подписки (удалили, отвалась сеть,
      // заблокировал антивирус) — живые обновления выключаем, приложение живёт.
      console.warn('[shell] scan watcher error (папка недоступна, live-обновления выкл):', err)
    })
    if (w) scanWatchers.push(w)
  }
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
          new Notification({ title: action.title ?? combo, body: action.body ?? '' }).show()
          console.log(`[plugins:${plugin.name}] hotkey ${combo} triggered`)
        })
      } catch (err) {
        console.warn(`[plugins:${plugin.name}] failed to register ${combo}:`, err)
      }
    }
  }

  // IPC для shell-UI
  ipcMain.handle('config:get', () => ({ ...getConfig(), debug }))
  ipcMain.handle('shell:getVersion', () => app.getVersion())
  ipcMain.handle('config:set', (_event, patch) => {
        const prevFolders = getConfig().scanFolders
    const next = saveConfig((patch ?? {}) as Parameters<typeof saveConfig>[0])
    // Смена списка папок сканов применяется сразу, без рестарта оболочки.
    if (
      prevFolders.length !== next.scanFolders.length ||
      prevFolders.some(
        (f, i) => f.id !== next.scanFolders[i]?.id || f.path !== next.scanFolders[i]?.path,
      )
    ) {
      restartAllWatchers()
    }
    return next
  })
  ipcMain.handle('plugins:list', () =>
    plugins.map((p) => ({
      name: p.name,
      code: p.code ?? '',
      styles: p.styles ?? '',
      init: p.manifest.init ?? '',
      options: p.options ?? '',
    })),
  )
  // Полный список (включая выключенные) — для настроек, чтобы выключенное можно было включить обратно
  ipcMain.handle('plugins:list-all', () => listAllPlugins(getConfig()))
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
  // Уведомления tasks-notify: пачка за тик → одно OS-уведомление (или по одному при <=3)
  ipcMain.handle('notify:tasks', (_event, items: unknown) => {
    const list = Array.isArray(items) ? items.filter((x): x is { id: number; title: string; body: string; url: string } =>
      !!x && typeof x === 'object' && typeof (x as {id:unknown}).id === 'number' && typeof (x as {title:unknown}).title === 'string') : []
    if (list.length === 0 || !mainWindow || mainWindow.isDestroyed()) return false
    const showOne = (title: string, body: string, url: string): void => {
      const n = new Notification({ title, body })
      n.on('click', () => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()
            mainWindow.flashFrame(false)
            const wc = mainWindow.webContents
            wc.send('tasks:open-url', url || '/v2/relocation/tasks')
          }
        } catch { /* ignore */ }
      })
      n.show()
    }
    if (list.length <= 3) {
      for (const it of list) showOne(it.title, typeof it.body === 'string' ? it.body : '', typeof it.url === 'string' ? it.url : '/v2/relocation/tasks')
    } else {
      showOne(`Новые задания: ${list.length}`, list.slice(0, 3).map((x) => x.title).join('\n'), '/v2/relocation/tasks')
    }
    try { mainWindow.flashFrame(true) } catch { /* ignore */ }
    return true
  })
  // Пользовательский звук tasks-notify по слотам ('rel' — перемещение, 'ho' — выдача).
  // Файлы: userData/sounds/custom-<slot>.<ext>. В plugin-data только имя файла, бинарь — на диске.
  ipcMain.handle('sound:pick', async (_event, slot: unknown) => {
    if (!isSoundSlot(slot)) return null
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const paths = await dialog.showOpenDialogSync(mainWindow, {
      title: 'Выберите звук уведомления',
      filters: [
        { name: 'Аудио', extensions: ['mp3', 'wav', 'ogg'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (!Array.isArray(paths) || paths.length === 0) return null
    const src = paths[0]
    const ext = pickSoundExt(basename(src))
    if (!ext) return null
    let bytes: Buffer
    try {
      bytes = readFileSync(src)
    } catch {
      return null
    }
    if (!isSoundSizeOk(bytes.length)) return null
    const file = saveSoundFile(bytes, ext, slot)
    return { file, name: basename(src) }
  })
  // Байты сохранённого звука слота для проигрывания в renderer (dataURL собирает renderer).
  ipcMain.handle('sound:get', (_event, slot: unknown) => {
    if (!isSoundSlot(slot)) return null
    const found = readSoundFile(slot)
    if (!found) return null
    return { file: found.file, mime: mimeForSoundExt(found.ext), base64: found.base64 }
  })
  ipcMain.handle('sound:clear', (_event, slot: unknown) => {
    if (!isSoundSlot(slot)) return false
    clearSoundFile(slot)
    return true
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
  // Значения куки НЕ отдаём в renderer — там только имена/домены/метаданные.
  // size считаем БЕЗ длины значения (иначе палим длину секрета, напр. сессии).
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
        size: c.name.length,
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
   // ---------- Пароли к папкам вкладок ----------
   // Хранятся в шифрохранилище ОС (см. credentials/folderPasswords.ts).
   ipcMain.handle('folder-passwords:save', (_event, input: unknown) => {
     const v = (input ?? {}) as { folderId?: unknown; password?: unknown }
     if (typeof v.folderId !== 'string' || !v.folderId) return null
     return saveFolderPassword(v.folderId, typeof v.password === 'string' ? v.password : '')
   })
   ipcMain.handle('folder-passwords:clear', (_event, folderId: unknown) => {
     if (typeof folderId !== 'string' || !folderId) return
     clearFolderPassword(folderId)
   })
   ipcMain.handle('folder-passwords:verify', (_event, input: unknown) => {
     const v = (input ?? {}) as { folderId?: unknown; password?: unknown }
     if (typeof v.folderId !== 'string' || !v.folderId) return false
     if (!isFolderPasswordEncryptionAvailable()) return false
     return verifyFolderPassword(v.folderId, typeof v.password === 'string' ? v.password : '')
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
     try {
       const err = await shell.openPath(rec.path)
       return err === ''
     } catch (err) {
       console.warn('[shell] downloads:open failed:', err)
       return false
     }
   })
   // ---------- Скриншот видимой области вкладки (PNG в папку загрузок + история) ----------
   async function captureGuestScreenshot(guestId: unknown): Promise<{ ok: boolean; path?: string }> {
     const guest = typeof guestId === 'number' ? webContents.fromId(guestId) : undefined
     if (!guest || guest.isDestroyed()) return { ok: false }
     let png: Buffer
     try {
       png = await guest.capturePage().then((image) => image.toPNG())
     } catch (err) {
       console.warn('[shell] screenshot capture failed:', err)
       return { ok: false }
     }
     if (!png.length) return { ok: false }
     const fileName = screenshotFileName()
     const filePath = join(app.getPath('downloads'), fileName)
     try {
       writeFileSync(filePath, png)
     } catch (err) {
       console.warn('[shell] screenshot save failed:', err)
       return { ok: false }
     }
     const now = new Date().toISOString()
     try {
       appendDownloadRecord({
         id: randomUUID(),
         name: fileName,
         path: filePath,
         bytes: png.length,
         state: 'done',
         startedAt: now,
         finishedAt: now,
         ...(await resolveAttribution(guest)),
       })
     } catch (err) {
       console.warn('[shell] screenshot history failed:', err)
     }
     return { ok: true, path: filePath }
   }
   ipcMain.handle('screenshot:capture', (_event, guestId: unknown) => captureGuestScreenshot(guestId))
   ipcMain.handle('screenshot:copy-image', async (_event, filePath: unknown) => {
     // Путь прилетает из renderer — принимаем только нашу папку загрузок.
     if (typeof filePath !== 'string' || !filePath) return false
     try {
       if (dirname(filePath) !== app.getPath('downloads')) return false
       const png = readFileSync(filePath)
       if (!png.length) return false
       // Electron 44: синхронного clipboard.writeImage больше нет —
       // только новый ClipboardItem-API (Blob вместо NativeImage).
       await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
       return true
     } catch (err) {
       console.warn('[shell] screenshot copy failed:', err)
       return false
     }
   })
   // ---------- PDF-просмотр (окно с кнопками «Скачать»/«Печать») ----------
    ipcMain.handle('pdf-viewer:save', async (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return false
      const { base64, name } = payload as { base64?: unknown; name?: unknown }
      if (typeof base64 !== 'string' || !base64 || typeof name !== 'string') return false
      // Сюда прилетает data URL целиком (см. buildPdfViewerHtml: savePdf(embed.src)),
      // а не чистый base64. Префикс «data:…;base64,» декодировать нельзя —
      // иначе в начало файла пишется мусор и PDF открывается как «повреждённый».
      let raw = base64.trim()
      if (raw.startsWith('data:')) {
        const comma = raw.indexOf(',')
        if (comma === -1) return false
        raw = raw.slice(comma + 1)
      }
      raw = raw.replace(/\s+/g, '')
      if (!raw) return false
      let pdf: Buffer
      try {
        pdf = Buffer.from(raw, 'base64')
      } catch (err) {
        console.warn('[shell] pdf save failed (bad base64):', err)
        return false
      }
      if (pdf.length === 0 || pdf.slice(0, 4).toString('latin1') !== '%PDF') {
        console.warn('[shell] pdf save failed: decoded bytes are not a PDF')
        return false
      }
      const bytes = pdf.length
      // МСК = UTC+3 (без летнего времени)
      const stamp = (() => {
        const d = new Date(Date.now() + 3 * 3600e3)
        const p = (n: number): string => String(n).padStart(2, '0')
        return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
          `-${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`
      })()
      // Реальное имя файла сохраняется; для «дефолтного» названия ставим дату/по МСК.
      // Имя от remote — через sanitize (basename против `../`, запрещённые символы).
      const fileName = sanitizeFileName(name, `документ-${stamp}.pdf`, 'pdf')
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const filePath = dialog.showSaveDialogSync(mainWindow, {
        title: 'Сохранить документ',
        defaultPath: join(app.getPath('downloads'), fileName),
      })
      if (!filePath) return false
      try {
        writeFileSync(filePath, pdf)
        appendDownloadRecord({
          id: randomUUID(),
          name: basename(filePath),
          path: filePath,
          bytes,
          state: 'done',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          // Сохранение инициировано из оболочки — геста нет, но аккаунт известен.
          ...(await resolveAttribution()),
        })
        return true
      } catch (err) {
        console.warn('[shell] pdf save failed:', err)
        return false
      }
    })
    // Экспорт вкладок в .json: диалог сохранения + запись на диск
    ipcMain.handle('tabs:export', async (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return false
      const { content, name } = payload as { content?: unknown; name?: unknown }
      if (typeof content !== 'string' || !content || typeof name !== 'string' || !name.trim()) return false
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const fileName = sanitizeFileName(name, 'sewbrowser-tabs.json', 'json')
      const filePath = dialog.showSaveDialogSync(mainWindow, {
        title: 'Сохранить вкладки',
        defaultPath: join(app.getPath('downloads'), fileName),
      })
      if (!filePath) return false
      try {
        writeFileSync(filePath, content)
        appendDownloadRecord({
          id: randomUUID(),
          name: basename(filePath),
          path: filePath,
          bytes: Buffer.byteLength(content),
          state: 'done',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          // Экспорт инициирован из оболочки — геста нет, но аккаунт известен.
          ...(await resolveAttribution()),
        })
        return true
      } catch (err) {
        console.warn('[shell] tabs export failed:', err)
        return false
      }
    })
     ipcMain.handle('pdf-viewer:print', (_event) => {
      const sender = _event.sender
      if (!sender || sender.isDestroyed()) return false
      // Печатаем сам документ (все страницы), а не обёртку окна просмотра.
      const doc = pdfViewerDocs.get(sender.id)
      if (!doc) {
        console.warn('[shell] pdf print failed: no document for this window')
        return false
      }
      try {
        let title = doc.title || 'Документ'
        try {
          const t = sender.getTitle()
          if (t) title = t
        } catch {
          // заголовок не критичен — печатаем с дефолтным
        }
        printPdfDocument(pathToFileURL(doc.filePath).toString(), title)
        return true
      } catch (err) {
        console.warn('[shell] pdf print failed:', err)
        return false
      }
    })
    // Сохранение текущего PDF из окна просмотра (байты уже во временном файле —
    // base64 через IPC не гоняем, иначе большие файлы рвут лимиты).
    ipcMain.handle('pdf-viewer:save-current', async (_event) => {
      const sender = _event.sender
      if (!sender || sender.isDestroyed()) return false
      const doc = pdfViewerDocs.get(sender.id)
      if (!doc || !existsSync(doc.filePath)) return false
      const viewerWin = BrowserWindow.fromWebContents(sender)
      if (!viewerWin || viewerWin.isDestroyed()) return false
      const safeName = sanitizeFileName(doc.title, 'документ.pdf', 'pdf')
      const filePath = dialog.showSaveDialogSync(viewerWin, {
        title: 'Сохранить документ',
        defaultPath: join(app.getPath('downloads'), safeName),
      })
      if (!filePath) return false
      try {
        const pdf = readFileSync(doc.filePath)
        writeFileSync(filePath, pdf)
        appendDownloadRecord({
          id: randomUUID(),
          name: basename(filePath),
          path: filePath,
          bytes: pdf.length,
          state: 'done',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          // Сохранение инициировано из оболочки — геста нет, но аккаунт известен.
          ...(await resolveAttribution()),
        })
        return true
      } catch (err) {
        console.warn('[shell] pdf save failed:', err)
        return false
      }
    })
    // ---------- Сканы (внешний HP-софт + папка) ----------
    // launch — запустить софт по пути из настроек; list — файлы в scanFolder;
    // delete/open/show — операции с файлами; scans:changed — рассылка окну «Сканы».
    ipcMain.handle('scans:launch', () => launchScannerApp(getConfig().scannerAppPath, getConfig().scannerAppArgs ?? ''))
    ipcMain.handle('scans:list', () => collectAllScans())
    ipcMain.handle('scans:folders', () => getConfig().scanFolders)
    ipcMain.handle('scans:delete', (_event, id: unknown) => {
      if (typeof id !== 'string') return []
      deleteScanFile(id)
      return collectAllScans()
    })
    ipcMain.handle('scans:open', async (_event, filePath: unknown) => {
      if (typeof filePath !== 'string') return false
      try {
        const err = await shell.openPath(filePath)
        return err === ''
      } catch (err) {
        console.warn('[shell] scans:open failed:', err)
        return false
      }
    })
    ipcMain.handle('scans:show', (_event, filePath: unknown) => {
      if (typeof filePath !== 'string') return false
      try {
        shell.showItemInFolder(filePath)
        return true
      } catch (err) {
        console.warn('[shell] scans:show failed:', err)
        return false
      }
    })
    // Читать содержимое файла в base64 — для предосмотра и drag-n-drop в госте.
    ipcMain.handle('scans:read', (_event, id: unknown) => {
      if (typeof id !== 'string') return null
      const content = readScanFile(id)
      if (!content) console.warn('[shell] scans:read failed for:', id)
      return content
    })
    // Выбор файла с диска (альтернатива HP-софту): диалог → чтение в base64.
    ipcMain.handle('scans:pick', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null
      const paths = await dialog.showOpenDialogSync(mainWindow, {
        title: 'Выберите файл для переноса в SEW',
        filters: [
          { name: 'Документы', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff'] },
          { name: 'Все файлы', extensions: ['*'] },
        ],
        properties: ['openFile'],
      })
      if (!Array.isArray(paths) || paths.length === 0) return null
      const content = readScanFile(paths[0])
      if (!content) return null
      // Метка «picked» отличает выбранный с диска файл от файла из папки HP.
      return { ...content, id: 'picked::' + content.path }
    })
    // Выбор пути к программе сканера (EXE) — для настройки scannerAppPath.
    ipcMain.handle('scans:browse-app', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return ''
      const paths = await dialog.showOpenDialogSync(mainWindow, {
        title: 'Выберите программу сканера (EXE)',
        filters: [{ name: 'Программа', extensions: ['exe'] }],
        properties: ['openFile'],
      })
      return Array.isArray(paths) && paths.length > 0 ? paths[0] : ''
    })
    // Выбор павки автосохранения сканов — для настройки scanFolder.
    ipcMain.handle('scans:browse-folder', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return ''
      const paths = await dialog.showOpenDialogSync(mainWindow, {
        title: 'Выберите папку автосохранения сканов',
        properties: ['openDirectory'],
      })
      return Array.isArray(paths) && paths.length > 0 ? paths[0] : ''
    })

    // Мониторинг папки HP-софта: новые файлы пересылаем в shell-UI
    // событием 'scans:changed' (renderer форвардит его в гостя),
    // а renderer по нему же может обновить окно «Сканы».
    restartAllWatchers()

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
    // Чистим сет при уничтожении геста (пересоздание webview/crash),
    // иначе id копились бы вечно.
    guest.once('destroyed', () => {
      attachedGuests.delete(id)
    })
    // Диагностика навигации гостя: видно каждую загрузку и вердикт allowlist
    guest.on('did-navigate', (_navEvent, url) => {
      console.log('[shell] guest nav:', url.slice(0, 200), isAllowedUrl(url) ? '(allowed)' : '(blocked)')
    })
    // Блокировка ДО коммита: запрещённый URL не исполняется вообще.
    // (bounce-back в renderer на did-navigate оставляем как вторую линию —
    // на случай гонки, но сюда в норме уже ничего не должно долетать.)
    const denyBlocked = (event: Electron.Event, url: string): void => {
      if (!isAllowedUrl(url)) {
        event.preventDefault()
        console.log('[shell] nav blocked:', url.slice(0, 200))
      }
    }
    guest.on('will-navigate', (event, url) => denyBlocked(event, url))
    guest.on('will-redirect', (event, url) => denyBlocked(event, url))
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const name = guestShortcutName(input)
      if (!name) return
      // Escape НЕ preventDefault'им: страница SEW сама использует Esc
      // (закрытие дропдаунов/модалок). Shell-оверлеи renderer закроет
      // по событию, а страница при этом тоже получит клавишу — двойное
      // закрытие в редком кейсе лучше, чем сглотнутый Esc.
      if (name !== 'escape') event.preventDefault()
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
        {
          label: 'Снимок вкладки',
          click: () => {
            if (guest.isDestroyed()) return
            // Тост с кнопкой «Копировать» покажет renderer по событию.
            void captureGuestScreenshot(guest.id).then((result) => {
              if (!mainWindow || mainWindow.isDestroyed()) return
              mainWindow.webContents.send('screenshot:saved', result)
            })
          },
        },
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

  /** Сборка HTML-страницы PDF-просмотра: только embed viewer'а на всё окно.
   *  pdfSrc — file:// URL временного PDF (не data:, иначе большие файлы рвут лимиты URL).
   *  Саму обёртку тоже грузим через file:// из temp, а не через data:text/html:
   *  страницу data: Chromium считает opaque origin и режет в ней file:// сабресурсы
   *  («Not allowed to load local resource») — embed оставался пустым серым полем.
   *  Своего тулбара нет: у встроенного viewer'а Chromium свои кнопки
   *  «Скачать»/«Печать», дублей не делаем. */
  function buildPdfViewerHtml(pdfSrc: string, title: string): string {
    const safeTitle = htmlEscape(title || 'Документ')
    const safeSrc = htmlEscape(pdfSrc)
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: #3c3f41; }
  #embed { width: 100%; height: 100%; border: 0; display: block; }
</style>
</head>
<body>
<embed id="embed" type="application/pdf" src="${safeSrc}"></embed>
</body>
</html>`
  }

  /** PDF-просмотр: отдельное окно со встроенным viewer'ом Chromium и кнопками «Скачать»/«Печать» */
  // Временные PDF по webContentsId окна просмотра. Байты лежат в файле
  // в temp (не в data: URL — большие PDF рвали лимиты длины URL).
  const pdfViewerDocs = new Map<number, { filePath: string; title: string }>()
  // Скрытые окна печати держим в сете, чтобы их не собрал GC до конца печати.
  const pdfPrintWindows = new Set<BrowserWindow>()

  function getPdfTempDir(): string {
    const dir = join(app.getPath('temp'), 'sewbrowser-pdfs')
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch {
      // fallback — системный temp
      return tmpdir()
    }
    return dir
  }

  /**
   * Печать PDF-документа целиком. Скрытое окно грузит сам PDF-файл (без обёртки
   * с тулбаром), поэтому Chromium печатает все страницы документа. Печать
   * обёртки через wc.print() давала растровый «скриншот» видимой области
   * embed'а вместо документа.
   */
  function printPdfDocument(fileUrl: string, title: string): void {
    const printWin = new BrowserWindow({
      show: false,
      title,
      icon: existsSync(devIcon) ? devIcon : undefined,
      webPreferences: {
        contextIsolation: true,
        webviewTag: false,
      },
    })
    printWin.setMenu(null)
    pdfPrintWindows.add(printWin)
    let done = false
    const cleanup = (): void => {
      pdfPrintWindows.delete(printWin)
      if (!printWin.isDestroyed()) printWin.destroy()
    }
    const finish = (): void => {
      if (done) return
      done = true
      // Даём спулеру забрать задание, затем гасим скрытое окно
      setTimeout(cleanup, 2000)
    }
    printWin.webContents.on('did-finish-load', () => {
      if (printWin.isDestroyed() || done) return
      // Отсекаем чужие finish (стартовый about:blank и т.п.) — печатаем
      // только когда загрузился именно наш PDF.
      let url = ''
      try {
        url = printWin.webContents.getURL()
      } catch {
        return
      }
      if (!url.startsWith('file:')) return
      // PDF-плагину нужно время на инициализацию и первую отрисовку после
      // did-finish-load (готовность через DOM не отследить — хост-страница
      // вьювера в main-мире пуста). Печать раньше даёт пустой белый лист,
      // особенно при холодном старте вьювера на медленной машине.
      setTimeout(() => {
        if (printWin.isDestroyed() || done) return
        try {
          printWin.webContents.print({}, () => finish())
        } catch (err) {
          console.warn('[shell] pdf print failed:', err)
          finish()
        }
      }, 2500)
    })
    printWin.webContents.once('did-fail-load', (_e, code, desc) => {
      console.warn('[shell] pdf print load failed:', code, desc)
      finish()
    })
    // Страховка: не висим скрытым окном вечно (диалог печати закрыли — колбэк всё равно придёт)
    setTimeout(finish, 120_000)
    void printWin.loadURL(fileUrl)
  }

  function openPdfViewer(pdf: Buffer, title: string): void {
    // Пишем во временный файл: data: URL с base64 рвал лимиты на больших PDF.
    // Обёртку кладём рядом (.html) и грузим через file:// — data:-страница
    // не может показать file:// embed (см. buildPdfViewerHtml).
    let pdfPath = ''
    let htmlPath = ''
    try {
      const base = join(getPdfTempDir(), randomUUID())
      pdfPath = `${base}.pdf`
      htmlPath = `${base}.html`
      writeFileSync(pdfPath, pdf)
      writeFileSync(htmlPath, buildPdfViewerHtml(pathToFileURL(pdfPath).toString(), title), 'utf-8')
    } catch (err) {
      console.warn('[shell] pdf viewer failed (temp write):', err)
      return
    }
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
    // id забираем сразу: после 'closed' геттер win.webContents бросает
    // «Object has been destroyed» (uncaughtException при закрытии окна).
    const wcId = win.webContents.id
    pdfViewerDocs.set(wcId, { filePath: pdfPath, title })
    win.on('closed', () => {
      pdfViewerDocs.delete(wcId)
      for (const p of [pdfPath, htmlPath]) {
        try {
          if (p) unlinkSync(p)
        } catch {
          // temp подчистит ОС
        }
      }
    })
    void win.loadURL(pathToFileURL(htmlPath).toString())
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
        openPdfViewer(Buffer.from(base64, 'base64'), 'Документ')
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
    // Байты тянем сами и открываем viewer: при Content-Disposition: attachment
    // прямой loadURL повторно срабатывает will-download (зацикление).
    // data:/blob: в ветку не пускаем — это уже финальный файл (например, из самого viewer'а).
    // ВАЖНО: item сразу НЕ cancel'им, а pause — оригинальный запрос может быть POST'ом
    // (GET-перекачка вернёт HTML/ошибку). Валидируем %PDF-магию, иначе — fallback
    // на обычное скачивание исходного item (иначе файл терялся).
    const url = item.getURL()
    if (/^https?:/i.test(url) && (item.getMimeType() === 'application/pdf' || /\.pdf$/i.test(name))) {
      try {
        item.pause()
      } catch {
        // старый Electron без pause — идём старым путём
      }
      void (async () => {
        try {
          const res = await net.fetch(url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const buf = Buffer.from(await res.arrayBuffer())
          const isPdf = buf.length > 4 && buf.slice(0, 4).toString('latin1') === '%PDF'
          if (!isPdf) throw new Error('not a PDF (probably POST-generated or HTML)')
          try {
            item.cancel()
          } catch {
            // ignore
          }
          openPdfViewer(buf, name)
        } catch (err) {
          console.warn('[shell] pdf viewer failed, fallback to normal download:', err)
          try {
            item.resume()
          } catch {
            // resume не удался — дальше обычный диалог всё равно покажем,
            // но item уже мёртв; просто выходим чтобы не зависнуть
            return
          }
          startNormalDownload(item, wc, id, name, startedAt, send)
        }
      })()
      return
    }
    startNormalDownload(item, wc, id, name, startedAt, send)
  })

  /** Обычное скачивание через диалог сохранения (вынесено для fallback из PDF-ветки) */
  function startNormalDownload(
    item: Electron.DownloadItem,
    wc: WebContents,
    id: number,
    name: string,
    startedAt: string,
    send: (payload: Record<string, unknown>) => void,
  ): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
      try {
        item.cancel()
      } catch {
        // ignore
      }
      return
    }
    // Синхронный диалог: пока пользователь выбирает путь, скачивание не убегает вперёд.
    // Имя от remote — через sanitize (иначе `../` убегало из папки загрузок).
    const safeName = sanitizeFileName(name, 'файл')
    const filePath = dialog.showSaveDialogSync(mainWindow, {
      title: 'Сохранить файл',
      defaultPath: join(app.getPath('downloads'), safeName),
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
  }

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
  // Windows: без AppUserModelId ОС-тосты (Notification) молча не показываются,
  // особенно в dev. Id совпадает с appId из electron-builder.yml.
  if (process.platform === 'win32') app.setAppUserModelId('com.sewbrowser.app')
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
      // Реальные ошибки уже уходят событием 'error' выше — здесь их глотаем.
      // Таймаут (GitHub повис) событием НЕ отправляем, а кидаем в invoke:
      // иначе таймаут-ошибка + поздний реальный результат давали бы
      // двойной статус («ошибка», а следом «доступно»). Позднее событие
      // теперь просто доводит UI до корректного состояния само.
      let timer: NodeJS.Timeout | null = null
      let timedOut = false
      try {
        await Promise.race([
          autoUpdater.checkForUpdates(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              console.log('[updater] check timed out')
              reject(new Error('проверка не ответила — проверьте соединение с GitHub'))
            }, UPDATER_CHECK_TIMEOUT_MS)
          }),
        ])
      } catch (err) {
        if (timedOut) throw err
        console.log('[updater] check failed:', err)
      } finally {
        if (timer) clearTimeout(timer)
      }
      return true
    })
    ipcMain.handle('updater:download', async () => {
      try {
        await autoUpdater.downloadUpdate()
        return true
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err)
        console.log('[updater] download failed:', err)
        throw new Error(`Не удалось скачать обновление: ${reason}`)
      }
    })
    ipcMain.on('updater:install', () => autoUpdater.quitAndInstall(false, true))
    void autoUpdater.checkForUpdates().catch((err) => console.log('[updater] check failed:', err))
    // Периодическая проверка каждые 2 часа. Результат (available/ready)
    // придёт событием 'updater:event' и отобразится в shell-UI;
    // 'uptodate'/'error' без ручной проверки — тихо, как и автостарт.
    updaterInterval = setInterval(() => {
      void autoUpdater.checkForUpdates().catch((err) => console.log('[updater] check failed:', err))
    }, UPDATER_CHECK_INTERVAL_MS)
  }
})

app.on('window-all-closed', () => {
  if (updaterInterval) {
    clearInterval(updaterInterval)
    updaterInterval = null
  }
  for (const w of scanWatchers) stopScanWatcher(w)
  scanWatchers = []
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
