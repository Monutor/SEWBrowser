import { activeTab, activeView, canTabGoBack, canTabGoForward, focusOrOpenTab, noteTabHistory } from './tabs'

/** Элементы тулбара, которые нужны для навигации по странице. */
export interface ToolbarElements {
  address: HTMLInputElement | null
  back: HTMLButtonElement | null
  forward: HTMLButtonElement | null
}

export interface ToolbarDeps {
  config(): ShellConfig | null
  navigate(url: string): Promise<void>
  openAccounts(force?: boolean): Promise<void>
  captureActiveTabScreenshot(): Promise<void>
  openPricetags(): void
  wireAddressMenu(): void
  wirePrintDialog(): void
  wireShotPreview(): void
}

/**
 * Подписка кнопок тулбара, адресной строки и кнопок окна. Порядок тот же,
 * что был до выноса: сначала три соседних виджета, потом сами кнопки.
 */
export function wireToolbar(elements: ToolbarElements, deps: ToolbarDeps): void {
  deps.wireAddressMenu()
  deps.wirePrintDialog()
  deps.wireShotPreview()
  elements.back?.addEventListener('click', () => {
    const tab = activeTab()
    if (!tab || !canTabGoBack(tab)) return
    noteTabHistory(tab, -1)
    tab.view.goBack()
  })
  elements.forward?.addEventListener('click', () => {
    const tab = activeTab()
    if (!tab || !canTabGoForward(tab)) return
    noteTabHistory(tab, 1)
    tab.view.goForward()
  })
  document.getElementById('btn-home')?.addEventListener('click', () => {
    const config = deps.config()
    if (config) void deps.navigate(config.startUrl)
  })
  document.getElementById('btn-mvideo')?.addEventListener('click', () => {
    focusOrOpenTab('https://www.mvideo.ru/')
  })
  document.getElementById('btn-reload')?.addEventListener('click', () => {
    const view = activeView()
    if (view) view.reload()
  })
  document.getElementById('btn-barcode')?.addEventListener('click', () => {
    focusOrOpenTab('https://monutor.github.io/warehouse-barcode-generator/')
  })
  document.getElementById('btn-products')?.addEventListener('click', () => {
    focusOrOpenTab('https://monutor.github.io/DataBaseProducts/')
  })
  document.getElementById('btn-accounts')?.addEventListener('click', () => void deps.openAccounts(true))
  document.getElementById('btn-screenshot')?.addEventListener('click', () => void deps.captureActiveTabScreenshot())
  document.getElementById('btn-pricetags')?.addEventListener('click', () => deps.openPricetags())
  // NB: btn-templates подписывается в wireTemplates() — дубль здесь давал
  // двойной openTemplates() и задвоенный список шаблонов.

  if (elements.address) {
    elements.address.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') void deps.navigate(elements.address?.value ?? '')
    })
  }

  document.getElementById('btn-min')?.addEventListener('click', () => window.shell.windowMin())
  document.getElementById('btn-max')?.addEventListener('click', () => window.shell.windowMax())
  document.getElementById('btn-close')?.addEventListener('click', () => window.shell.windowClose())

  // NB: btn-scans подписывается в wireScansToggle() — он стал тумблером блока
  // «Сканы» (открывает/закрывает), здесь он раньше только открывал панель.

  // DevTools webview — только в debug-режиме
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i' && deps.config()?.debug) {
      event.preventDefault()
      const view = activeView()
      if (view) view.openDevTools()
    }
  })
}
