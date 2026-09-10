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
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
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

interface StorageUsage {
  cacheBytes: number
  cookieCount: number
}

type StorageClearTarget = 'cache' | 'cookies' | 'all'

interface UpdaterEvent {
  type: 'available' | 'progress' | 'ready' | 'error'
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

type ShortcutName =
  | 'reload'
  | 'hard-reload'
  | 'focus-address'
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
  getStorageUsage(): Promise<StorageUsage>
  clearStorage(target: StorageClearTarget): Promise<boolean>
  listCookies(): Promise<CookieInfo[]>
  removeCookie(cookie: { name: string; domain: string; path: string; secure: boolean }): Promise<boolean>
  onUpdater(cb: (event: UpdaterEvent) => void): void
  downloadUpdate(): Promise<boolean>
  installUpdate(): void
}

interface Window {
  shell: ShellApi
}
