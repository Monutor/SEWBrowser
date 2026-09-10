import { contextBridge, ipcRenderer } from 'electron'

interface ShellConfigLike {
  startUrl: string
  debug: boolean
  allowlistEnabled: boolean
  allowlist: string[]
  plugins: Record<string, boolean>
  zoom: Record<string, number>
}

interface DownloadEventLike {
  id: number
  name: string
  type: 'started' | 'progress' | 'done'
  path?: string
  received?: number
  total?: number
  percent?: number
  ok?: boolean
  cancelled?: boolean
  state?: string
}

const api = {
  getConfig: (): Promise<ShellConfigLike> => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<ShellConfigLike>): Promise<ShellConfigLike> =>
    ipcRenderer.invoke('config:set', patch),
  getPlugins: (): Promise<{ name: string; code: string }[]> => ipcRenderer.invoke('plugins:list'),
  clearSession: (): Promise<boolean> => ipcRenderer.invoke('session:clear'),
  windowMin: (): void => ipcRenderer.send('window:min'),
  windowMax: (): void => ipcRenderer.send('window:max'),
  windowClose: (): void => ipcRenderer.send('window:close'),
  /** enable опущен — переключить; возвращает новое состояние fullscreen */
  setFullscreen: (enable?: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:fullscreen', enable),
  /** Привязка гостевого webContents (для перехвата хоткеев внутри страницы) */
  attachGuest: (webContentsId: number): void => ipcRenderer.send('guest:attach', webContentsId),
  onShortcut: (cb: (name: string) => void): void => {
    ipcRenderer.on('shell:shortcut', (_event, name: string) => cb(name))
  },
  /** Открыть URL во внешнем приложении (системный браузер, почтовый клиент…) */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url),
  /** Показать скачанный файл в проводнике */
  showItemInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('downloads:show-item', filePath),
  /** События загрузок: started | progress | done */
  onDownload: (cb: (event: DownloadEventLike) => void): void => {
    ipcRenderer.on('download:event', (_event, payload: DownloadEventLike) => cb(payload))
  },
}

contextBridge.exposeInMainWorld('shell', api)
