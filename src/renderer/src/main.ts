import './styles.css'

const webview = document.getElementById('site') as unknown as SewWebViewElement
const addressInput = document.getElementById('address') as HTMLInputElement | null
const statusEl = document.getElementById('status') as HTMLElement | null
const toolbar = document.getElementById('toolbar') as HTMLElement | null

let config: ShellConfig | null = null
let plugins: PluginInfo[] = []

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

/** Логика совпадает с allowlist в конфиге (проверка синхронная, в will-navigate) */
function isAllowed(url: string): boolean {
  if (!config || !config.allowlistEnabled) return true
  let host = ''
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return false
  }
  return config.allowlist.some((pattern) => {
    const p = pattern.toLowerCase()
    if (p.startsWith('*.')) {
      const domain = p.slice(2)
      return host === domain || host.endsWith(`.${domain}`)
    }
    return host === p
  })
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text
}

async function injectPlugins(): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.code) continue
    try {
      await webview.executeJavaScript(plugin.code)
    } catch (err) {
      console.warn(`[plugins:${plugin.name}] injection failed:`, err)
    }
  }
}

function updateAddressBar(): void {
  if (!addressInput) return
  addressInput.value = webview.getCurrentURL() ?? ''
}

async function navigate(url: string): Promise<void> {
  const target = normalizeUrl(url)
  if (!target) return
  if (isAllowed(target)) {
    webview.src = target
  } else {
    setStatus('blocked by allowlist')
  }
}

function wireToolbar(): void {
  document.getElementById('btn-back')?.addEventListener('click', () => webview.goBack())
  document.getElementById('btn-forward')?.addEventListener('click', () => webview.goForward())
  document.getElementById('btn-reload')?.addEventListener('click', () => webview.reload())

  if (addressInput) {
    addressInput.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') void navigate(addressInput.value)
    })
  }

  document.getElementById('btn-min')?.addEventListener('click', () => window.shell.windowMin())
  document.getElementById('btn-max')?.addEventListener('click', () => window.shell.windowMax())
  document.getElementById('btn-close')?.addEventListener('click', () => window.shell.windowClose())

  // DevTools webview — только в debug-режиме
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i' && config?.debug) {
      event.preventDefault()
      webview.openDevTools()
    }
  })
}

function wireWebviewEvents(): void {
  webview.on('did-navigate', (event) => {
    console.log('[shell] did-navigate:', event.url)
    updateAddressBar()
  })
  webview.on('did-finish', () => void injectPlugins())
  webview.on('did-fail-load', (event) => {
    if (!event.isMainFrame) return
    console.error('[shell] did-fail-load:', event.errorCode, event.errorDescription)
    setStatus(`fail: ${event.errorDescription}`)
  })
  webview.on('did-start-loading', () => toolbar?.classList.add('loading'))
  webview.on('did-stop-loading', () => toolbar?.classList.remove('loading'))

  webview.on('will-navigate', (event) => {
    if (!isAllowed(event.url)) {
      event.preventDefault()
      setStatus('blocked by allowlist')
    }
  })

  webview.on('new-window', (event) => {
    // новые окна открываем в том же webview, либо блокируем по allowlist
    event.preventDefault()
    if (isAllowed(event.url)) webview.src = event.url
  })
}

function startStatusPolling(): void {
  setInterval(async () => {
    try {
      const count = await webview.executeJavaScript('(window.__sewDataLog || []).length')
      setStatus(config?.debug ? `req: ${count} · debug` : `req: ${count}`)
    } catch {
      // страница ещё не готова — игнорируем
    }
  }, 2000)
}

async function init(): Promise<void> {
  config = await window.shell.getConfig()
  plugins = await window.shell.getPlugins()

  wireToolbar()
  wireWebviewEvents()
  startStatusPolling()

  if (addressInput) addressInput.value = config.startUrl
  webview.src = config.startUrl
  setStatus(config.debug ? 'debug' : '')
}

void init().catch((err) => {
  console.error('[shell] init failed:', err)
  setStatus(`init: ${String(err)}`)
})
