declare module '*.css'

/**
 * Подмножество реального API тега <webview> (см. Electron docs, webview-tag).
 * Важно: события — ТОЛЬКО через addEventListener (метода .on нет);
 * навигация — через loadURL()/атрибут src; preventDefault() в will-navigate
 * НЕ работает; попапы — через атрибут allowpopups + setWindowOpenHandler
 * в main-процессе (события 'new-window' у webview НЕТ).
 */
interface SewWebViewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  isLoading(): boolean
  isCrashed(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  insertCSS(css: string): Promise<string>
  executeJavaScript(code: string): Promise<unknown>
  openDevTools(): void
  getWebContentsId(): number
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  print(): Promise<void>
  addEventListener(
    event: 'did-navigate' | 'did-navigate-in-page',
    listener: (event: { url: string }) => void,
  ): void
  addEventListener(
    event: 'did-finish-load' | 'did-start-loading' | 'did-stop-loading' | 'dom-ready',
    listener: () => void,
  ): void
  addEventListener(
    event: 'did-fail-load',
    listener: (event: { errorCode: number; errorDescription: string; isMainFrame: boolean; url: string }) => void,
  ): void
  addEventListener(
    event: 'found-in-page',
    listener: (event: {
      result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }
    }) => void,
  ): void
}

interface NavTab {
  id: string
  name: string
  url: string
  /** ID папки (NavFolder.id) или отсутствует — вкладка «без папки». */
  folderId?: string
}

/** Папка для группировки вкладок. Один уровень вложенности. */
interface NavFolder {
  id: string
  name: string
  /** ID записи пароля в шифрохранилище ОС (main/credentials/folderPasswords.ts). Нет — папка без защиты. */
  passwordId?: string
}

interface ShellConfig {
  startUrl: string
  debug: boolean
  allowlistEnabled: boolean
  allowlist: string[]
  plugins: Record<string, boolean>
  zoom: Record<string, number>
  clearOnExit: 'none' | 'cache' | 'all'
  tabs: NavTab[]
  folders: NavFolder[]
  scannerAppPath: string
  scannerAppArgs: string
  scanFolders: ScanFolder[]
}

/** Папка со сканами из настроек оболочки */
interface ScanFolder {
  /** Стабильный id (из настроек); рендерер шлёт без него — main проставляет. */
  id?: string
  path: string
}

interface PluginInfo {
  name: string
  code: string
  styles: string
  init: string
  /** Исходник options-страницы расширения (выполняется в shell-окне с прослойкой) */
  options: string
}

interface DownloadEvent {
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
interface DownloadedFile {
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

/** Результат узкого fetch-моста main-процесса (только allowlist-URL) */
interface NetFetchResult {
  ok: boolean
  status: number
  data: unknown
}

interface StorageUsage {
  cacheBytes: number
  cookieCount: number
}

type StorageClearTarget = 'cache' | 'cookies' | 'all'

interface UpdaterEvent {
  type: 'available' | 'progress' | 'ready' | 'error' | 'uptodate'
  version?: string
  percent?: number
  message?: string
}

/** Метаданные куки БЕЗ значения (значения не покидают main-процесс) */
interface CookieInfo {
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
interface ScanFile {
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

/** Содержимое файла сканов в base64 — для предосмотра и drag-n-drop в госте */
interface ScanFileContent {
  id: string
  name: string
  path: string
  bytes: number
  ext: string
  mime: string
  base64: string
}

/** Публичная часть аккаунта SEW (без пароля) */
interface AccountInfo {
  id: string
  fio: string
  tabNum: string
  updatedAt: number
}

interface SaveAccountInput {
  id?: string
  fio: string
  tabNum: string
  password: string
}

type ShortcutName =
  | 'reload'
  | 'hard-reload'
  | 'focus-address'
  | 'accounts'
  | 'templates'
  | 'back'
  | 'forward'
  | 'fullscreen'
  | 'print'
  | 'find'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'settings'
  | 'escape'

interface ShellApi {
  getConfig(): Promise<ShellConfig>
  setConfig(patch: Partial<ShellConfig>): Promise<ShellConfig>
  getPlugins(): Promise<PluginInfo[]>
  getAllPlugins(): Promise<{ name: string; enabled: boolean }[]>
  clearSession(): Promise<boolean>
  windowMin(): void
  windowMax(): void
  windowClose(): void
  setFullscreen(enable?: boolean): Promise<boolean>
  attachGuest(webContentsId: number): void
  onShortcut(cb: (name: string) => void): void
  openExternal(url: string): Promise<boolean>
  showItemInFolder(filePath: string): Promise<boolean>
  onDownload(cb: (event: DownloadEvent) => void): void
  listDownloads(): Promise<DownloadedFile[]>
  clearDownloads(): Promise<DownloadedFile[]>
  removeDownload(id: string): Promise<DownloadedFile[]>
  showDownload(id: string): Promise<boolean>
  openDownloadFile(id: string): Promise<boolean>
  savePdf(base64: string, name: string): Promise<boolean>
  saveCurrentPdf(): Promise<boolean>
  printPdf(): Promise<boolean>
  /** Сохранить текст (напр. экспорт вкладок) в файл через диалог сохранения */
  saveTabsFile(content: string, name: string): Promise<boolean>
  /** Запустить внешний софт сканера (напр. HP) по его пути из настроек */
  launchScannerApp(): Promise<boolean>
  /** Список файлов в папках «Сканы» (рекурсивно) — новые в начале */
  listScans(): Promise<ScanFile[]>
  /** Папки со сканами из настроек оболочки */
  listScanFolders(): Promise<ScanFolder[]>
  /** Удалить файл из папки «Сканы» (возвращает обновлённый список) */
  deleteScan(id: string): Promise<ScanFile[]>
  /** Открыть файл приложением по умолчанию */
  openScanFile(filePath: string): Promise<boolean>
  /** Показать файл из папки «Сканы» в проводнике */
  showScanInFolder(filePath: string): Promise<boolean>
  /** Изменение папки сканов: прислать свежий список файлов */
  onScansChanged(cb: (event: ScanFile[]) => void): void
  /** Прочитать файл из папки «Сканы» в base64 — для предосмотра/переноса в госте */
  readScanFile(id: string): Promise<ScanFileContent>
  /** Открыть выбор файла с диска и прочитать его в base64 (для переноса в SEW) */
  pickScanFile(): Promise<ScanFileContent | null>
  /** Выбор пути к программе сканера (EXE) через родной диалог — для настроек */
  browseScannerApp(): Promise<string>
  /** Выбор папки автосохранения сканов через родной диалог — для настроек */
  browseScanFolder(): Promise<string>
  getStorageUsage(): Promise<StorageUsage>
  clearStorage(target: StorageClearTarget): Promise<boolean>
  listCookies(): Promise<CookieInfo[]>
  removeCookie(cookie: { name: string; domain: string; path: string; secure: boolean }): Promise<boolean>
  listAccounts(): Promise<AccountInfo[]>
  saveAccount(input: SaveAccountInput): Promise<AccountInfo>
  removeAccount(id: string): Promise<boolean>
  getAccountSecrets(id: string): Promise<{ tabNum: string; password: string } | null>
  /** Сохранить пароль папки (пустой — снятие защиты); возвращает id записи или null */
  saveFolderPassword(folderId: string, password: string): Promise<string | null>
  /** Снять защиту папки удалением записи с паролем */
  clearFolderPassword(folderId: string): Promise<void>
  /** Проверить пароль папки (шифрохранилище недоступно → false) */
  verifyFolderPassword(folderId: string, password: string): Promise<boolean>
  pluginDataGet(plugin: string, keys?: string[]): Promise<Record<string, unknown>>
  pluginDataSet(plugin: string, obj: Record<string, unknown>): Promise<boolean>
  pluginDataRemove(plugin: string, keys: string[]): Promise<boolean>
  getAllPluginData(): Promise<Record<string, Record<string, unknown>>>
  /** Алиас preload-имени (оба ведут на 'plugin-data:get-all') */
  pluginDataGetAll(): Promise<Record<string, Record<string, unknown>>>
  /** Узкий fetch-мост main-процесса (только allowlist-URL, напр. BFF mvideo) */
  netFetch(url: string): Promise<NetFetchResult>
  onPluginDataChanged(cb: (event: { plugin: string }) => void): void
  /** ОС-уведомление о новом задании SEW (показывает main-процесс; клик открывает страницу списка) */
  notifyShow(task: { title: string; body: string; url: string }): Promise<boolean>
  /** Клик по уведомлению о задании: main просит renderer открыть страницу списка */
  onTasksOpen(cb: (event: { url: string }) => void): void
  onUpdater(cb: (event: UpdaterEvent) => void): void
  downloadUpdate(): Promise<boolean>
  checkForUpdates(): Promise<boolean>
  installUpdate(): void
  getVersion(): Promise<string>
}

interface Window {
  shell: ShellApi
}
