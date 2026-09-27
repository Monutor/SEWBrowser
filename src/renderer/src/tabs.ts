import { clampTabIndex, cycleTabIndex, normalizeTabUrl, tabFavicon, tabTitle } from './tabs-core.ts'

/**
 * Менеджер вкладок: по одному живому <webview> на вкладку, все работают одновременно.
 * Единственная точка подмены для остальной оболочки — activeView().
 * Состояние живёт только в памяти: между запусками вкладки не сохраняются.
 */

export interface ShellTab {
  id: number
  view: SewWebViewElement
  isPrimary: boolean
  url: string
  title: string
  lastAllowedUrl: string
  /**
   * Глубина истории вкладки. У <webview> нет canGoBack, поэтому считаем сами:
   * navCount — текущая позиция, maxNav — самая глубокая, до которой доходили.
   * Отслеживается ради тусклых кнопок «назад/вперёд» в тулбаре.
   */
  navCount: number
  maxNav: number
  /** Переход, который мы сами запустили: -1 назад, 1 вперёд, 0 — нет. */
  pendingHistory: -1 | 0 | 1
  /**
   * Оригинальная иконка сайта как data-URL (из `<link rel="icon">`).
   * Пустая строка — картинки нет, рисуем буквенный кружок.
   */
  faviconData: string
}

export interface TabsHooks {
  wire: (tab: ShellTab) => void
  onActivated: (tab: ShellTab) => void
  onClosed: (tab: ShellTab) => void
}

export interface TabsOptions {
  container: HTMLElement
  strip: HTMLElement
  newTabButton: HTMLButtonElement
  startUrl: string
  hooks: TabsHooks
  /** Allowlist-предикат оболочки. Не задан — считаем, что разрешено всё. */
  isAllowed?: (url: string) => boolean
  /** Отказ по allowlist: вкладка не создана, оболочка должна объяснить пользователю. */
  onBlocked?: (url: string) => void
}

let options: TabsOptions | null = null
let tabs: ShellTab[] = []
let activeId = 0
let nextId = 1
/** Вкладка, для которой открыто контекстное меню (ПКМ не активирует вкладку). */
let menuTabId = 0
/** Кнопки полосы по id вкладки: элементы переиспользуются, а не пересоздаются. */
const stripButtons = new Map<number, HTMLButtonElement>()
/** Порядок id, отрисованный в прошлый раз, — по нему решаем, нужна ли пересборка полосы. */
let stripOrder: number[] = []

export function initTabs(opts: TabsOptions): void {
  options = opts
  tabs = []
  activeId = 0
  nextId = 1
  menuTabId = 0
  stripButtons.clear()
  stripOrder = []
  opts.newTabButton.addEventListener('click', () => {
    openTab(opts.startUrl, { activate: true })
  })
  if (typeof window !== 'undefined' && window.shell && typeof window.shell.onMenuAction === 'function') {
    window.shell.onMenuAction((action) => {
      const tab = tabs.find((entry) => entry.id === menuTabId) ?? activeTab()
      menuTabId = 0
      if (tab) handleTabMenuAction(tab, action)
    })
  }
}

export function listTabs(): ShellTab[] {
  return tabs.slice()
}

export function activeTab(): ShellTab | null {
  if (activeId === 0) return null
  return tabs.find((tab) => tab.id === activeId) ?? null
}

export function activeView(): SewWebViewElement | null {
  const tab = activeTab()
  return tab ? tab.view : null
}

export function primaryTab(): ShellTab | null {
  const first = tabs[0]
  return first ?? null
}

export function primaryView(): SewWebViewElement | null {
  const first = primaryTab()
  return first ? first.view : null
}

export function isActiveTab(tab: ShellTab): boolean {
  return tab.id === activeId
}

export function openTab(rawUrl: string, opts?: { activate?: boolean }): ShellTab | null {
  const o = options
  if (!o) return null
  const url = normalizeTabUrl(rawUrl)
  if (!url) return null
  // Allowlist-инвариант живёт здесь: запрещённый хост не должен давать пустую
  // вкладку без объяснения, поэтому вкладку не создаём вовсе и зовём onBlocked.
  if (o.isAllowed && !o.isAllowed(url)) {
    o.onBlocked?.(url)
    return null
  }
  const view = document.createElement('webview') as unknown as SewWebViewElement
  view.setAttribute('allowpopups', '')
  const tab: ShellTab = {
    id: nextId++,
    view,
    isPrimary: tabs.length === 0,
    url,
    title: tabTitle('', url),
    lastAllowedUrl: url,
    navCount: 0,
    maxNav: 0,
    pendingHistory: 0,
    faviconData: '',
  }
  tabs.push(tab)
  o.container.appendChild(view)
  // Порядок важен: сначала обработчики, потом загрузка — иначе did-navigate уйдёт в никуда
  o.hooks.wire(tab)
  view.setAttribute('src', url)
  if (opts?.activate === false) {
    applyVisibility()
    renderTabBar()
  } else {
    activateTab(tab)
  }
  return tab
}

export function closeTab(id: number): void {
  const o = options
  const index = tabs.findIndex((tab) => tab.id === id)
  if (!o || index < 0) return
  const [tab] = tabs.splice(index, 1)
  if (menuTabId === id) menuTabId = 0
  // Первая вкладка — единственный опросный хост (isPrimary). При сдвиге головы списка
  // флаг надо пересчитать, иначе полисер задачи 6 останется без хоста.
  tab.isPrimary = false
  if (tabs.length > 0) tabs[0].isPrimary = true
  o.hooks.onClosed(tab)
  try {
    tab.view.remove()
  } catch {
    /* webview уже мог быть уничтожен — не критично */
  }
  if (tabs.length === 0) {
    activeId = 0
    applyVisibility()
    renderTabBar()
    openTab(o.startUrl, { activate: true })
    return
  }
  if (activeId === id) {
    const next = tabs[index] ?? tabs[tabs.length - 1]
    activeId = next.id
    applyVisibility()
    renderTabBar()
    o.hooks.onActivated(next)
    return
  }
  renderTabBar()
}

export function activateTab(tab: ShellTab): void {
  if (!options || !tabs.includes(tab)) return
  activeId = tab.id
  applyVisibility()
  renderTabBar()
  options.hooks.onActivated(tab)
}

export function cycleTab(delta: number): void {
  if (tabs.length === 0) return
  const current = tabs.findIndex((tab) => tab.id === activeId)
  const next = cycleTabIndex(tabs.length, current, delta)
  if (next < 0) return
  activateTab(tabs[next])
}

export function selectTabIndex(oneBased: number): void {
  const index = clampTabIndex(tabs.length, oneBased)
  if (index < 0) return
  activateTab(tabs[index])
}

export function focusOrOpenTab(rawUrl: string): void {
  const url = normalizeTabUrl(rawUrl)
  if (!url) return
  const found = tabs.find((tab) => tab.url === url)
  if (found) {
    activateTab(found)
    return
  }
  // Проверку allowlist делает openTab — уже открытой вкладке она не нужна
  openTab(url, { activate: true })
}

export function setTabUrl(tab: ShellTab, url: string): void {
  if (!tabs.includes(tab)) return
  tab.url = url
  tab.lastAllowedUrl = url
  renderTabBar()
}

export function setTabTitle(tab: ShellTab, pageTitle: string): void {
  if (!tabs.includes(tab)) return
  tab.title = tabTitle(pageTitle, tab.url)
  renderTabBar()
}

/**
 * Оригинальная иконка сайта (data-URL из `<link rel="icon">`). Пустая строка —
 * иконки нет: возвращаемся к буквенному кружку.
 */
export function setTabFavicon(tab: ShellTab, dataUrl: string): void {
  if (!tabs.includes(tab)) return
  if (tab.faviconData === dataUrl) return
  tab.faviconData = dataUrl
  renderTabBar()
}

/** Отмечаем переход по нашей кнопке «назад/вперёд»: применим его в did-navigate. */
export function noteTabHistory(tab: ShellTab, delta: -1 | 1): void {
  tab.pendingHistory = delta
}

/** Обычная навигация в did-navigate: новая запись истории, хвост обрезается. */
export function noteTabNavigated(tab: ShellTab): void {
  if (tab.pendingHistory !== 0) {
    const next = tab.navCount + tab.pendingHistory
    tab.pendingHistory = 0
    if (next >= 1 && next <= tab.maxNav) {
      tab.navCount = next
      return
    }
  }
  tab.navCount = tab.maxNav + 1
  tab.maxNav = tab.navCount
}

export function canTabGoBack(tab: ShellTab): boolean {
  return tab.navCount > 1
}

export function canTabGoForward(tab: ShellTab): boolean {
  return tab.navCount < tab.maxNav
}

export function refreshTabBar(): void {
  renderTabBar()
}

function applyVisibility(): void {
  for (const tab of tabs) {
    if (tab.id === activeId) tab.view.removeAttribute('data-hidden')
    else tab.view.setAttribute('data-hidden', '')
  }
}

function renderTabBar(): void {
  const o = options
  if (!o) return
  const order = tabs.map((tab) => tab.id)
  const compositionChanged =
    order.length !== stripOrder.length || order.some((id, index) => stripOrder[index] !== id)
  for (const tab of tabs) {
    let button = stripButtons.get(tab.id)
    if (!button) {
      button = createTabButton(tab)
      stripButtons.set(tab.id, button)
    }
    updateTabButton(button, tab)
  }
  for (const id of [...stripButtons.keys()]) {
    if (!tabs.some((tab) => tab.id === id)) stripButtons.delete(id)
  }
  stripOrder = order
  // Пересобираем полосу только когда состав вкладок действительно изменился:
  // did-navigate фоновой вкладки не должен пересоздавать кнопки активной.
  if (!compositionChanged) return
  const buttons: HTMLButtonElement[] = []
  for (const tab of tabs) {
    const button = stripButtons.get(tab.id)
    if (button) buttons.push(button)
  }
  o.strip.replaceChildren(...buttons)
}

function createTabButton(tab: ShellTab): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  const fav = document.createElement('span')
  fav.className = 'tab-btn-fav'
  const label = document.createElement('span')
  label.className = 'tab-btn-label'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'tab-btn-close'
  close.textContent = '×'
  close.title = 'Закрыть вкладку'
  close.addEventListener('click', (event) => {
    const stop = event as { stopPropagation?: () => void }
    if (typeof stop.stopPropagation === 'function') stop.stopPropagation()
    closeTab(tab.id)
  })
  button.append(fav, label, close)
  button.addEventListener('click', () => {
    activateTab(tab)
  })
  button.addEventListener('auxclick', (event) => {
    const mouse = event as MouseEvent
    if (mouse.button === 1) {
      mouse.preventDefault()
      closeTab(tab.id)
    }
  })
  button.addEventListener('contextmenu', (event) => {
    const mouse = event as MouseEvent
    mouse.preventDefault()
    showTabMenu(tab)
  })
  return button
}

function updateTabButton(button: HTMLButtonElement, tab: ShellTab): void {
  button.className = tab.id === activeId ? 'tab-btn active' : 'tab-btn'
  // Подсказка — полный заголовок вкладки (спека §6.3), не URL
  button.title = tab.title
  const fav = button.children[0]
  if (fav) {
    const icon = tabFavicon(tab.url)
    // Оригинальная иконка сайта, если её удалось получить; иначе буква на цветном кружке
    if (tab.faviconData) {
      fav.textContent = ''
      fav.setAttribute('style', `background-image:url("${tab.faviconData}")`)
    } else {
      fav.textContent = icon.letter
      fav.setAttribute('style', `background:${icon.color}`)
    }
  }
  const label = button.children[1]
  if (label) label.textContent = tab.title
}

function showTabMenu(tab: ShellTab): void {
  if (typeof window === 'undefined' || !window.shell || typeof window.shell.popupMenu !== 'function') return
  const index = tabs.findIndex((entry) => entry.id === tab.id)
  const items: Array<{ label: string; action: string }> = [
    { label: 'Закрыть вкладку', action: 'close' },
  ]
  if (tabs.length > 1) items.push({ label: 'Закрыть другие вкладки', action: 'close-others' })
  if (index >= 0 && index < tabs.length - 1) {
    items.push({ label: 'Закрыть вкладки справа', action: 'close-right' })
  }
  // ПКМ не активирует вкладку — запоминаем, к какой вкладке относится меню
  menuTabId = tab.id
  void window.shell.popupMenu(items)
}

function handleTabMenuAction(tab: ShellTab, action: string): void {
  if (action === 'close') {
    closeTab(tab.id)
    return
  }
  if (action === 'close-others') {
    for (const other of listTabs()) {
      if (other.id !== tab.id) closeTab(other.id)
    }
    return
  }
  if (action === 'close-right') {
    const index = tabs.findIndex((entry) => entry.id === tab.id)
    if (index < 0) return
    for (const other of listTabs()) {
      if (tabs.findIndex((entry) => entry.id === other.id) > index) closeTab(other.id)
    }
  }
}
