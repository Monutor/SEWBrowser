import { app, BrowserWindow, Notification, globalShortcut, ipcMain } from 'electron'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { getConfig, isDebugMode } from './config'
import { loadPlugins } from './plugins/loader'

let mainWindow: BrowserWindow | null = null

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
  ipcMain.handle('plugins:list', () => plugins.map((p) => ({ name: p.name, code: p.code ?? '' })))
  ipcMain.on('window:min', () => mainWindow?.minimize())
  ipcMain.on('window:max', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())

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
