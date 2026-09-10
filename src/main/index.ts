import { app, BrowserWindow, Notification, globalShortcut, ipcMain, session, webContents, Menu, dialog, shell, clipboard } from 'electron'
import type { Input, MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { getConfig, isDebugMode, saveConfig } from './config'
import { loadPlugins } from './plugins/loader'

let mainWindow: BrowserWindow | null = null

/**
 * Маппинг клавиш гостевой страницы в имена шорткатов оболочки.
 * Буквы — по input.code (не зависит от раскладки: Ctrl+Ф = Ctrl+A и т.п.).
 */
function guestShortcutName(input: Input): string | null {
  const mod = input.control || input.meta
  const { key, code } = input
  if (key === 'F5' || (mod && code === 'KeyR')) return 'reload'
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

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      webviewTag: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  console.log('[SEWBrowser] startUrl:', config.startUrl)
  if (debug) mainWindow.webContents.openDevTools()

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
  ipcMain.handle('plugins:list', () => plugins.map((p) => ({ name: p.name, code: p.code ?? '' })))
  ipcMain.handle('session:clear', async () => {
    await session.defaultSession.clearStorageData()
    console.log('[SEWBrowser] session storage cleared')
    return true
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
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const name = guestShortcutName(input)
      if (!name) return
      event.preventDefault()
      mainWindow?.webContents.send('shell:shortcut', name)
    })

    // Попапы и window.open (тег webview имеет атрибут allowpopups):
    // разрешённое — в том же окне, остальное — в системный браузер.
    guest.setWindowOpenHandler(({ url }) => {
      const target = url.trim()
      if (!EXTERNAL_SCHEME_RE.test(target)) return { action: 'deny' }
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
  // will-download срабатывает для любых скачиваний гостевой страницы.
  let downloadSeq = 0
  session.defaultSession.on('will-download', (_event, item) => {
    const id = ++downloadSeq
    const name = item.getFilename() || 'файл'
    const send = (payload: Record<string, unknown>): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download:event', { id, name, ...payload })
      }
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      item.cancel()
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
      send({ type: 'done', ok: state === 'completed', path: item.getSavePath(), state })
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

  // Автообновление через GitHub Releases (только в собранном приложении)
  if (!process.env.VITE_DEV_SERVER_URL) {
    autoUpdater.on('error', (err) => console.log('[updater] error:', err))
    void autoUpdater.checkForUpdates().then((available) => {
      console.log(`[updater] update available: ${available}`)
    })
  }
})

app.on('window-all-closed', () => app.quit())
