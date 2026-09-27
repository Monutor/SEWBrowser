declare module '*.css'

/** Размер бумаги, который понимает printToPDF (A3, A4, A5, A6, Legal, Letter, Tabloid).
 *  У принтера набор уже — см. PrintPaperName: A6 в списке webview.print нет. */
type PrintPageSizeName = 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid'

/** Размер бумаги, который понимает webview.print (A6 в этом списке отсутствует) */
type PrintPaperName = 'A3' | 'A4' | 'A5' | 'Legal' | 'Letter' | 'Tabloid'

/** Диапазон страниц для webview.print: индексы 0-based, last — включительно.
 *  ВНИМАНИЕ: у printToPDF pageRanges — строка '1-5, 8' с индексами 1-based. */
interface PrintPageRange {
  from: number
  to: number
}

/** Поля для printToPDF — в ДЮЙМАХ (PrintToPDFMargins), по умолчанию ~0.4" */
interface PrintPdfMargins {
  top?: number
  bottom?: number
  left?: number
  right?: number
}

/** Поля для webview.print — в ПИКСЕЛЯХ (Margins). Свои поля Electron принимает
 *  ТОЛЬКО при marginType: 'custom', поэтому здесь он обязателен, как и все четыре
 *  стороны. Из миллиметров настроек конвертирует print-dialog. */
interface PrintMarginsPx {
  marginType: 'custom'
  top: number
  bottom: number
  left: number
  right: number
}

interface PrintOptionsLike {
  silent?: boolean
  printBackground?: boolean
  /** Системное имя принтера из списка (не displayName!) */
  deviceName?: string
  landscape?: boolean
  /** Имя размера бумаги или свой размер; объект — в МИКРОНАХ (только у принтера) */
  pageSize?: PrintPaperName | { width: number; height: number }
  /** Взять размер бумаги по умолчанию у принтера. Взаимоисключающе с pageSize,
   *  по умолчанию false: без pageSize И без этого флага Electron бросает ошибку. */
  usePrinterDefaultPageSize?: boolean
  copies?: number
  /** Масштаб 0.1..2 (у printToPDF это scale). Настройка хранится в процентах, здесь доля */
  scaleFactor?: number
  /** Диапазоны страниц, индексы 0-based */
  pageRanges?: PrintPageRange[]
  margins?: PrintMarginsPx
}

interface PrintToPdfOptionsLike {
  landscape?: boolean
  printBackground?: boolean
  /** 0.1..2; настройка хранится в процентах, здесь доля */
  scale?: number
  displayHeaderFooter?: boolean
  /** Имя размера бумаги или свой размер; объект — в ДЮЙМАХ (у принтера — микроны) */
  pageSize?: PrintPageSizeName | { width: number; height: number }
  /** Поля в дюймах */
  margins?: PrintPdfMargins
  /** Страницы для печати, формат как в Electron: '1-5, 8, 11-13', индексы 1-based.
   *  Пустая строка или отсутствие поля = все страницы. */
  pageRanges?: string
}

/** Принтер системы: name идёт в deviceName, displayName — в UI */
interface ShellPrinter {
  name: string
  displayName: string
  description: string
}

/** Настройки диалога печати; пишутся в config.json при печати/сохранении */
interface PrintSettings {
  destination: 'pdf' | 'printer'
  deviceName: string
  rangeMode: 'all' | 'current' | 'custom'
  rangeFrom: number
  rangeTo: number
  copies: number
  landscape: boolean
  /** A6 хранить можно (PDF его понимает), но принтеру такое имя не отправить */
  pageSize: PrintPageSizeName
  /** Поля в миллиметрах */
  marginTop: number
  marginBottom: number
  marginLeft: number
  marginRight: number
  /** Проценты, 10..200 */
  scale: number
  printBackground: boolean
  displayHeaderFooter: boolean
}

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
  getTitle(): string
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
  print(options?: PrintOptionsLike): Promise<void>
  printToPDF(options: PrintToPdfOptionsLike): Promise<Uint8Array>
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
  addEventListener(event: 'page-title-updated', listener: (event: { title: string; explicitSet: boolean }) => void): this
  /** Клик мышью по содержимому гостя — нужен для перевода фокуса между панелями */
  addEventListener(event: 'mousedown', listener: (event: MouseEvent) => void): this
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
  print?: PrintSettings
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

/** Результат снимка вкладки: PNG приходит как data URL, на диск ничего не пишется */
interface ScreenshotResult {
  ok: boolean
  dataUrl?: string
  name?: string
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
  | 'screenshot'
  | 'find'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'settings'
  | 'escape'
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'tab-1'
  | 'tab-2'
  | 'tab-3'
  | 'tab-4'
  | 'tab-5'
  | 'tab-6'
  | 'tab-7'
  | 'tab-8'
  | 'tab-9'

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
  captureScreenshot(webContentsId: number): Promise<ScreenshotResult>
  copyScreenshotImage(dataUrl: string): Promise<boolean>
  saveScreenshotAs(dataUrl: string, guestId: number): Promise<{ ok: boolean; path?: string }>
  onScreenshotPreview(cb: (result: ScreenshotResult) => void): void
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
  /** Иконка вкладки: main качает картинку и отдаёт data-URL (null — нечем заменить букву) */
  fetchFavicon(url: string): Promise<string | null>
  /** Уведомления tasks-notify: пачка новых заданий → OS Notification в main */
  notifyTasks(items: { id: number; title: string; body: string; url: string }[]): Promise<boolean>
  /** Клик по OS-уведомлению tasks-notify: main шлёт 'tasks:open-url' — renderer переходит */
  onTasksOpen(cb: (url: string) => void): void
  /** main просит открыть новую вкладку с URL (напр. из ссылки в письме/уведомлении) */
  onOpenNewTab(cb: (url: string) => void): void
  /** Контекстное меню оболочки (напр. ПКМ по вкладке): native-попап в main */
  popupMenu(items: { label: string; action: string }[]): Promise<boolean>
  /** Клик по пункту контекстного меню: main шлёт 'shell:menu-action' */
  onMenuAction(cb: (action: string) => void): void
  /** Копирование текста в системный буфер обмена (меню адреса) */
  copyText(text: string): Promise<boolean>
  /** Принтеры системы (список одинаков для всех webContents) */
  listPrinters(): Promise<ShellPrinter[]>
  /** ПКМ по странице → «Печать…»: main шлёт 'shell:open-print' */
  onOpenPrint(cb: () => void): void
  /** Выбрать свой звук уведомления для слота ('rel' | 'ho'); null — отмена/неподходящий файл */
  pickSound(slot: 'rel' | 'ho'): Promise<{ file: string; name: string } | null>
  /** Байты сохранённого звука слота для проигрывания (null — нет своего файла) */
  getSound(slot: 'rel' | 'ho'): Promise<{ file: string; mime: string; base64: string } | null>
  /** Удалить свой звук слота (откат на стандартный бип) */
  clearSound(slot: 'rel' | 'ho'): Promise<boolean>
   onPluginDataChanged(cb: (event: { plugin: string }) => void): () => void
  onUpdater(cb: (event: UpdaterEvent) => void): void
  downloadUpdate(): Promise<boolean>
  checkForUpdates(): Promise<boolean>
  installUpdate(): void
  getVersion(): Promise<string>
}

interface Window {
  shell: ShellApi
}
