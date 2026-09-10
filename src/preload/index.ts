import { contextBridge, ipcRenderer } from 'electron'

interface ShellConfigLike {
  startUrl: string
  debug: boolean
  allowlistEnabled: boolean
  allowlist: string[]
  plugins: Record<string, boolean>
  zoom: Record<string, number>
  clearOnExit: 'none' | 'cache' | 'all'
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

/** Запись истории загрузок (downloads.json в userData) */
interface DownloadedFileLike {
  id: string
  name: string
  path: string
  bytes: number
  state: 'done' | 'error'
  startedAt: string
  finishedAt: string
  /** Кто скачал (может отсутствовать у старых записей) */
  fio?: string
  tabNum?: string
}

interface StorageUsageLike {
  cacheBytes: number
  cookieCount: number
}

interface UpdaterEventLike {
  type: 'available' | 'progress' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
}

/** Метаданные куки БЕЗ значения (значения не покидают main-процесс) */
interface CookieInfoLike {
  name: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  session: boolean
  expirationDate?: number
  size: number
}

/** Публичная часть аккаунта SEW (без пароля) */
interface AccountInfoLike {
  id: string
  fio: string
  tabNum: string
  updatedAt: number
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
  /** История загрузок (окно «Загрузки»): новые — в начале */
  listDownloads: (): Promise<DownloadedFileLike[]> => ipcRenderer.invoke('downloads:list'),
  /** Очистить всю историю (возвращает пустой список) */
  clearDownloads: (): Promise<DownloadedFileLike[]> => ipcRenderer.invoke('downloads:clear'),
  /** Убрать запись из истории (возвращает обновлённый список) */
  removeDownload: (id: string): Promise<DownloadedFileLike[]> =>
    ipcRenderer.invoke('downloads:remove', id),
  /** Показать файл из истории в проводнике */
  showDownload: (id: string): Promise<boolean> => ipcRenderer.invoke('downloads:show', id),
  /** Открыть файл из истории приложением по умолчанию */
  openDownloadFile: (id: string): Promise<boolean> => ipcRenderer.invoke('downloads:open', id),
  /** События автообновления: available | progress | ready | error */
  onUpdater: (cb: (event: UpdaterEventLike) => void): void => {
    ipcRenderer.on('updater:event', (_event, payload: UpdaterEventLike) => cb(payload))
  },
  /** Скачать доступное обновление (по кнопке пользователя) */
  downloadUpdate: (): Promise<boolean> => ipcRenderer.invoke('updater:download'),
  /** Перезапустить оболочку и установить скачанное обновление */
  installUpdate: (): void => ipcRenderer.send('updater:install'),
  /** Размер HTTP-кэша и число куки */
  getStorageUsage: (): Promise<StorageUsageLike> => ipcRenderer.invoke('storage:usage'),
  /** Выборочная очистка: 'cache' | 'cookies' | 'all' */
  clearStorage: (target: 'cache' | 'cookies' | 'all'): Promise<boolean> =>
    ipcRenderer.invoke('storage:clear', target),
  /** Список куки без значений */
  listCookies: (): Promise<CookieInfoLike[]> => ipcRenderer.invoke('cookies:list'),
  removeCookie: (cookie: {
    name: string
    domain: string
    path: string
    secure: boolean
  }): Promise<boolean> => ipcRenderer.invoke('cookies:remove', cookie),
  /** Аккаунты SEW: список без паролей */
  listAccounts: (): Promise<AccountInfoLike[]> => ipcRenderer.invoke('credentials:list'),
  /** Создать/обновить аккаунт (пустой password при id = не менять) */
  saveAccount: (input: {
    id?: string
    fio: string
    tabNum: string
    password: string
  }): Promise<AccountInfoLike> => ipcRenderer.invoke('credentials:save', input),
  removeAccount: (id: string): Promise<boolean> => ipcRenderer.invoke('credentials:remove', id),
  /** Расшифрованные секреты — только для автозаполнения формы входа */
  getAccountSecrets: (id: string): Promise<{ tabNum: string; password: string } | null> =>
    ipcRenderer.invoke('credentials:get', id),
}

contextBridge.exposeInMainWorld('shell', api)
