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

interface ShellConfig {
  startUrl: string
  debug: boolean
  allowlistEnabled: boolean
  allowlist: string[]
  plugins: Record<string, boolean>
  zoom: Record<string, number>
  clearOnExit: 'none' | 'cache' | 'all'
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
  printPdf(): Promise<boolean>
  /** Сканер (WIA): список подключённых устройств — для кнопки «Определить сканер» */
  detectScanner(): Promise<{ ok: boolean; devices?: string[]; error?: string }>
  /** Сканер (WIA): отсканировать и вернуть изображение для предосмотра (НЕ сохраняет) */
  scan(sessionId?: string): Promise<{ ok: boolean; sessionId?: string; count?: number; base64?: string; mime?: string; ext?: string; error?: string }>
  /** Сканер (WIA): собрать все страницы сессии в один PDF и сохранить в «Загрузки» */
  saveScan(sessionId: string): Promise<{ ok: boolean; error?: string }>
  /** Открыть окно сканера (отдельное BrowserWindow) */
  openScanner(): void
  getStorageUsage(): Promise<StorageUsage>
  clearStorage(target: StorageClearTarget): Promise<boolean>
  listCookies(): Promise<CookieInfo[]>
  removeCookie(cookie: { name: string; domain: string; path: string; secure: boolean }): Promise<boolean>
  listAccounts(): Promise<AccountInfo[]>
  saveAccount(input: SaveAccountInput): Promise<AccountInfo>
  removeAccount(id: string): Promise<boolean>
  getAccountSecrets(id: string): Promise<{ tabNum: string; password: string } | null>
  pluginDataGet(plugin: string, keys?: string[]): Promise<Record<string, unknown>>
  pluginDataSet(plugin: string, obj: Record<string, unknown>): Promise<boolean>
  pluginDataRemove(plugin: string, keys: string[]): Promise<boolean>
  getAllPluginData(): Promise<Record<string, Record<string, unknown>>>
  /** Алиас preload-имени (оба ведут на 'plugin-data:get-all') */
  pluginDataGetAll(): Promise<Record<string, Record<string, unknown>>>
  /** Узкий fetch-мост main-процесса (только allowlist-URL, напр. BFF mvideo) */
  netFetch(url: string): Promise<NetFetchResult>
  onPluginDataChanged(cb: (event: { plugin: string }) => void): void
  onUpdater(cb: (event: UpdaterEvent) => void): void
  downloadUpdate(): Promise<boolean>
  checkForUpdates(): Promise<boolean>
  installUpdate(): void
}

interface Window {
  shell: ShellApi
}
