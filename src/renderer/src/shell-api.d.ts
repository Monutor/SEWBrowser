declare module '*.css'

interface SewWebViewElement extends HTMLIFrameElement {
  src: string
  getCurrentURL(): string
  goBack(): void
  goForward(): void
  reload(): void
  executeJavaScript(code: string): Promise<unknown>
  openDevTools(): void
  on(event: 'will-navigate', listener: (event: { url: string; preventDefault(): void }) => void): void
  on(event: 'new-window', listener: (event: { url: string; preventDefault(): void }) => void): void
  on(event: 'did-navigate' | 'did-finish' | 'did-start-loading' | 'did-stop-loading', listener: () => void): void
}

interface ShellConfig {
  startUrl: string
  debug: boolean
  allowlistEnabled: boolean
  allowlist: string[]
}

interface PluginInfo {
  name: string
  code: string
}

interface ShellApi {
  getConfig(): Promise<ShellConfig>
  getPlugins(): Promise<PluginInfo[]>
  windowMin(): void
  windowMax(): void
  windowClose(): void
}

interface Window {
  shell: ShellApi
}
