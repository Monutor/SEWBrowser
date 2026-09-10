import { app, BrowserWindow, Notification, globalShortcut, ipcMain, session, webContents } from 'electron'
import type { Input } from 'electron'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { getConfig, isDebugMode, saveConfig } from './config'
import { loadPlugins } from './plugins/loader'

let mainWindow: BrowserWindow | null = null

/**
 * electron-vite в dev-режиме кладёт URL dev-сервера сюда
 * (НЕ VITE_DEV_SERVER_URL — такой переменной нет, dev молча
 * грузил бы stale-билд из out/ и дёргал апдейтер).
 */
const devServerUrl = process.env.ELECTRON_RENDERER_URL

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

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
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
  })

  // В debug-режиме логируем неуспешные сетевые запросы (URL + код),
  // чтобы было видно виновника вроде ERR_SSL_PROTOCOL_ERROR (-107).
  if (debug) {
    session.defaultSession.webRequest.onErrorOccurred((details) => {
      console.warn(`[net] request failed: ${details.url} (${details.error})`)
    })
    console.log('[SEWBrowser] debug mode enabled')
  }
}

// Одна копия оболочки: повторный запуск фокусирует уже открытое окно,
// а не плодит зомби-процессы с занятым портом dev-сервера.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    createWindow()

    // Автообновление через GitHub Releases (только в собранном приложении)
    if (!devServerUrl) {
      autoUpdater.on('error', (err) => console.log('[updater] error:', err))
      void autoUpdater.checkForUpdates().then((available) => {
        console.log(`[updater] update available: ${available}`)
      })
    }
  })
}

app.on('window-all-closed', () => app.quit())
