declare module '*.css'

/**
 * Подмножество реального API тега <webview> (см. Electron docs, webview-tag).
 * Важно: события — ТОЛЬКО через addEventListener (метода .on нет);
 * навигация — через loadURL()/атрибут src; preventDefault() в will-navigate
 * НЕ работает; события 'new-window' у webview НЕТ.
 */
interface SewWebViewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  goBack(): void
  goForward(): void
  reload(): void
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
    listener: (event: { errorCode: number; errorDescription: string; isMainFrame: boolean }) => void,
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
}

interface PluginInfo {
  name: string
  code: string
}

type ShortcutName =
  | 'reload'
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
}

interface Window {
  shell: ShellApi
}
