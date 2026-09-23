import { contextBridge, ipcRenderer } from 'electron'

interface NavTabLike {
  id: string
  name: string
  url: string
}

interface ShellConfigLike {
  startUrl: string
  debug: boolean
  allowlistEnabled: boolean
  allowlist: string[]
  plugins: Record<string, boolean>
  zoom: Record<string, number>
  clearOnExit: 'none' | 'cache' | 'all'
  tabs: NavTabLike[]
  scanFolders: ScanFolderLike[]
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
  type: 'available' | 'progress' | 'ready' | 'error' | 'uptodate'
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

/** Запись об отсканированном файле в папке «Сканы» */
interface ScanFileLike {
  id: string
  name: string
  path: string
  bytes: number
  ext: string
  modifiedAt: string
  /** ID папки из настроек (для группировки по папкам) */
  folderId?: string
  /** Относительный путь внутри папки, '/'-сепаратор ('sub/dir/file', у корня '') */
  relPath?: string
  /** Корневая папка (из scanFolders) — для заголовка раздела в блоке. */
  folderPath?: string
}

/** Папка со сканами из настроек оболочки */
interface ScanFolderLike {
  id: string
  path: string
}

/** Содержимое файла сканов в base64 — для предосмотра и drag-n-drop в госте */
interface ScanFileContentLike {
  id: string
  name: string
  path: string
  bytes: number
  ext: string
  mime: string
  base64: string
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
  getVersion: (): Promise<string> => ipcRenderer.invoke('shell:getVersion'),
  getPlugins: (): Promise<
    { name: string; code: string; styles: string; init: string; options: string }[]
  > => ipcRenderer.invoke('plugins:list'),
  /** Все плагины (включая выключенные) — для настроек */
  getAllPlugins: (): Promise<{ name: string; enabled: boolean }[]> =>
    ipcRenderer.invoke('plugins:list-all'),
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
  /** Скриншот видимой области вкладки: PNG в папку загрузок + запись в историю */
  captureScreenshot: (webContentsId: number): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('screenshot:capture', webContentsId),
  /** Положить PNG скриншота (только из папки загрузок) в буфер обмена */
  copyScreenshotImage: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('screenshot:copy-image', filePath),
  /** Скриншот, запущенный из контекстного меню main (там нет возврата invoke) */
  onScreenshotSaved: (cb: (result: { ok: boolean; path?: string }) => void): void => {
    ipcRenderer.on('screenshot:saved', (_event, payload: { ok: boolean; path?: string }) => cb(payload))
  },
  /** PDF-просмотр: сохранить документ в окно просмотра (диалог сохранения) */
  savePdf: (base64: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('pdf-viewer:save', { base64, name }),
  /** PDF-просмотр: сохранить текущий документ окна (байты уже в temp main) */
  saveCurrentPdf: (): Promise<boolean> => ipcRenderer.invoke('pdf-viewer:save-current'),
  /** PDF-просмотр: открыть системный диалог печати */
  printPdf: (): Promise<boolean> => ipcRenderer.invoke('pdf-viewer:print'),
  /** Сохранить текст (напр. экспорт вкладок) в файл через диалог сохранения */
  saveTabsFile: (content: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('tabs:export', { content, name }),
  /** Запустить внешний софт сканера (напр. HP) по его пути из настроек */
  launchScannerApp: (): Promise<boolean> => ipcRenderer.invoke('scans:launch'),
  /** Список файлов в папках «Сканы» (рекурсивно) — новые в начале */
  listScans: (): Promise<ScanFileLike[]> => ipcRenderer.invoke('scans:list'),
  /** Папки со сканами из настроек оболочки */
  listScanFolders: (): Promise<ScanFolderLike[]> => ipcRenderer.invoke('scans:folders'),
  /** Удалить файл из папки «Сканы» (возвращает обновлённый список) */
  deleteScan: (id: string): Promise<ScanFileLike[]> => ipcRenderer.invoke('scans:delete', id),
  /** Открыть файл приложением по умолчанию */
  openScanFile: (filePath: string): Promise<boolean> => ipcRenderer.invoke('scans:open', filePath),
  /** Показать файл из папки «Сканы» в проводнике */
  showScanInFolder: (filePath: string): Promise<boolean> => ipcRenderer.invoke('scans:show', filePath),
  /** Изменение папки сканов: прислать свежий список файлов */
  onScansChanged: (cb: (event: ScanFileLike[]) => void): void => {
    ipcRenderer.on('scans:changed', (_event, payload: ScanFileLike[]) => cb(payload))
  },
  /** Прочитать файл из папки «Сканы» в base64 — для предосмотра/переноса в госте */
  readScanFile: (id: string): Promise<ScanFileContentLike> => ipcRenderer.invoke('scans:read', id),
  /** Открыть выбор файла с диска и прочитать его в base64 (для переноса в SEW) */
  pickScanFile: (): Promise<ScanFileContentLike | null> => ipcRenderer.invoke('scans:pick'),
  /** Выбор пути к программе сканера (EXE) через родной диалог — для настроек */
  browseScannerApp: (): Promise<string> => ipcRenderer.invoke('scans:browse-app'),
  /** Выбор папки автосохранения сканов через родной диалог — для настроек */
  browseScanFolder: (): Promise<string> => ipcRenderer.invoke('scans:browse-folder'),
  /** События автообновления: available | progress | ready | error */
  onUpdater: (cb: (event: UpdaterEventLike) => void): void => {
    ipcRenderer.on('updater:event', (_event, payload: UpdaterEventLike) => cb(payload))
  },
  /** Скачать доступное обновление (по кнопке пользователя) */
  downloadUpdate: (): Promise<boolean> => ipcRenderer.invoke('updater:download'),
  /** Вручную проверить обновления на GitHub (кнопка в настройках) */
  checkForUpdates: (): Promise<boolean> => ipcRenderer.invoke('updater:check'),
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
  /** Сохранить пароль папки (пустой пароль — снятие защиты); возвращает id записи или null */
  saveFolderPassword: (folderId: string, password: string): Promise<string | null> =>
    ipcRenderer.invoke('folder-passwords:save', { folderId, password }),
  /** Снять защиту папки удалением записи с паролем */
  clearFolderPassword: (folderId: string): Promise<void> =>
    ipcRenderer.invoke('folder-passwords:clear', folderId),
  /** Проверить пароль папки (шифрохранилище недоступно → false) */
  verifyFolderPassword: (folderId: string, password: string): Promise<boolean> =>
    ipcRenderer.invoke('folder-passwords:verify', { folderId, password }),
  /** Хранилище данных плагина (замена chrome.storage.local) */
  pluginDataGet: (plugin: string, keys?: string[]): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('plugin-data:get', plugin, keys),
  pluginDataSet: (plugin: string, obj: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('plugin-data:set', plugin, obj),
  pluginDataRemove: (plugin: string, keys: string[]): Promise<boolean> =>
    ipcRenderer.invoke('plugin-data:remove', plugin, keys),
  /** Снапшот данных всех плагинов — для пуша в гостевую страницу (у неё нет window.shell) */
  pluginDataGetAll: (): Promise<Record<string, Record<string, unknown>>> =>
    ipcRenderer.invoke('plugin-data:get-all'),
  /** Алиас для renderer (shell-api.d.ts): тот же снапшот, имя getAllPluginData */
  getAllPluginData: (): Promise<Record<string, Record<string, unknown>>> =>
    ipcRenderer.invoke('plugin-data:get-all'),
  /** Узкий fetch-мост для плагинов: только allowlist-URL (BFF mvideo — CORS режет из страницы) */
  netFetch: (url: string): Promise<{ ok: boolean; status: number; data: unknown }> =>
    ipcRenderer.invoke('net:fetch', url),
   /** Уведомления tasks-notify: пачка новых заданий → OS Notification в main */
  notifyTasks: (items: { id: number; title: string; body: string; url: string }[]): Promise<boolean> =>
    ipcRenderer.invoke('notify:tasks', items),
  /** Клик по OS-уведомлению tasks-notify: main шлёт 'tasks:open-url' — renderer переходит */
  onTasksOpen: (cb: (url: string) => void): void => {
    ipcRenderer.on('tasks:open-url', (_event, url: string) => cb(url))
  },
  /** Выбрать свой звук уведомления (диалог → userData/sounds/); null — отмена/неподходящий файл */
  pickSound: (): Promise<{ file: string; name: string } | null> =>
    ipcRenderer.invoke('sound:pick'),
  /** Байты сохранённого звука для проигрывания (null — нет своего файла) */
  getSound: (): Promise<{ file: string; mime: string; base64: string } | null> =>
    ipcRenderer.invoke('sound:get'),
  /** Удалить свой звук (откат на стандартный бип) */
  clearSound: (): Promise<boolean> => ipcRenderer.invoke('sound:clear'),
  /** Уведомление об изменении данных плагина (для chrome.storage.onChanged).
   *  Возвращает функцию отписки — иначе повторные addListener копят обработчики. */
  onPluginDataChanged: (cb: (event: { plugin: string }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { plugin: string }): void => cb(payload)
    ipcRenderer.on('plugin-data:changed', listener)
    return () => {
      ipcRenderer.removeListener('plugin-data:changed', listener)
    }
  },
}

contextBridge.exposeInMainWorld('shell', api)
