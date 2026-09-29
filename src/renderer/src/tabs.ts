import { clampTabIndex, cycleTabIndex, isOpenInWindowGesture, normalizeTabUrl, tabFavicon, tabTitle } from './tabs-core.ts'

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
  /**
   * Вкладка загружена: webview создан, src установлен, гость живёт.
   * Фоновые вкладки создаются лениво (см. ensureTabLoaded) — пока флаг снят,
   * webview даже не вставлен в DOM, и гостя за вкладкой просто нет.
   */
  loaded: boolean
  /** id гостевого webContents (0, пока вкладка не загружена) — нужен main для троттлинга. */
  guestId: number
}

export interface TabsHooks {
  wire: (tab: ShellTab) => void
  onActivated: (tab: ShellTab) => void
  onClosed: (tab: ShellTab) => void
  /**
   * Первая вкладка — опросный хост. При перестановке вкладок хост меняется,
   * и оболочка должна гасить опрос в прежней (иначе она продолжает пушить
   * задания в очередь, которую никто не читает). При закрытии вкладки хост
   * просто исчезает вместе с ней, поэтому хук зовется только от moveTab.
   */
  onPrimaryChanged?: (tab: ShellTab) => void
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
/** Разделённое окно: две вкладки пополам. null — обычное окно. */
let split: { leftId: number; rightId: number } | null = null
/** Какая из панелей в фокусе: к ней относятся адресная строка, зум, печать, поиск */
let focusPane: 'left' | 'right' = 'left'
/** Кнопки полосы по id вкладки: элементы переиспользуются, а не пересоздаются. */
const stripButtons = new Map<number, HTMLButtonElement>()
/** Порядок id, отрисованный в прошлый раз, — по нему решаем, нужна ли пересборка полосы. */
let stripOrder: number[] = []
/**
 * Id вкладки, для которой mousedown уже открыл окно: ensuing click не должен
 * ещё и активировать вкладку. Сбрасывается на самом click.
 */
let suppressClickTabId = 0

export function initTabs(opts: TabsOptions): void {
  options = opts
  tabs = []
  activeId = 0
  nextId = 1
  menuTabId = 0
  split = null
  focusPane = 'left'
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

/**
 * Разделённое окно: две вкладки делят ширину пополам. Левая панель — всегда
 * первая по порядку, значит опросный хост (isPrimary) в разделении не прыгает.
 */
export function isSplit(): boolean {
  return split !== null
}

/** Разделение возможно только когда открыто ровно две вкладки и окно не разделено */
export function canSplit(): boolean {
  return split === null && tabs.length === 2
}

/** Какая панель у вкладки; null — вкладка вне разделения */
export function splitPaneOf(tab: ShellTab): 'left' | 'right' | null {
  if (!split) return null
  if (tab.id === split.leftId) return 'left'
  if (tab.id === split.rightId) return 'right'
  return null
}

export function splitView(): boolean {
  const o = options
  if (!o || !canSplit()) return false
  split = { leftId: tabs[0].id, rightId: tabs[1].id }
  focusPane = 'left'
  activeId = split.leftId
  // Обе панели на виду — обе должны быть загружены (вторая могла остаться
  // фоновой и незагруженной).
  ensureTabLoaded(tabs[0])
  ensureTabLoaded(tabs[1])
  applyVisibility()
  renderTabBar()
  o.hooks.onActivated(tabs[0])
  return true
}

export function unsplit(): void {
  const o = options
  if (!o || !split) return
  // Активной остаётся вкладка той панели, где был фокус
  const focused = tabs.find((tab) => tab.id === (focusPane === 'left' ? split!.leftId : split!.rightId)) ?? null
  split = null
  focusPane = 'left'
  if (focused) activeId = focused.id
  applyVisibility()
  renderTabBar()
  if (focused) o.hooks.onActivated(focused)
}

export function setSplitFocus(pane: 'left' | 'right'): void {
  const o = options
  if (!o || !split) return
  const id = pane === 'left' ? split.leftId : split.rightId
  const tab = tabs.find((entry) => entry.id === id)
  if (!tab) return
  if (focusPane === pane && activeId === id) return
  focusPane = pane
  activeId = id
  applyVisibility()
  renderTabBar()
  o.hooks.onActivated(tab)
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
  // В разделении новая вкладка занимает место вкладки активной панели, а вторая
  // панель не трогается. Порядок массива остаётся [левая, правая] — от него зависит
  // выбор опросного хоста.
  if (split) {
    const pane = focusPane
    const oldId = pane === 'left' ? split.leftId : split.rightId
    const oldIndex = tabs.findIndex((entry) => entry.id === oldId)
    if (oldIndex >= 0) {
      const [old] = tabs.splice(oldIndex, 1)
      o.hooks.onClosed(old)
      try {
        old.view.remove()
      } catch {
        /* webview уже мог быть уничтожен — не критично */
      }
    }
    const fresh: ShellTab = {
      id: nextId++,
      view,
      isPrimary: pane === 'left',
      url,
      title: tabTitle('', url),
      lastAllowedUrl: url,
      navCount: 0,
      maxNav: 0,
      pendingHistory: 0,
      faviconData: '',
      loaded: false,
      guestId: 0,
    }
    if (pane === 'left') {
      split.leftId = fresh.id
      tabs.unshift(fresh)
    } else {
      split.rightId = fresh.id
      tabs.push(fresh)
    }
    o.hooks.wire(fresh)
    // Панель становится активной сразу, поэтому грузим без ленивости.
    ensureTabLoaded(fresh)
    focusPane = pane
    activeId = fresh.id
    applyVisibility()
    renderTabBar()
    o.hooks.onActivated(fresh)
    return fresh
  }
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
    loaded: false,
    guestId: 0,
  }
  tabs.push(tab)
  // Порядок важен: сначала обработчики, потом загрузка — иначе did-navigate уйдёт в никуда
  o.hooks.wire(tab)
  if (opts?.activate === false) {
    // Фоновая вкладка: страницу не грузим, пока её не откроют. Экономит
    // отдельный процесс Chromium на каждую вкладку (главный расход памяти).
    applyVisibility()
    renderTabBar()
  } else {
    ensureTabLoaded(tab)
    activateTab(tab)
  }
  publishPollHost()
  return tab
}

/**
 * Вставить webview вкладки в DOM (если ещё не вставлен) и запустить загрузку.
 * До этого вкладка не существует для Chromium: ни гостя, ни его памяти, ни
 * таймеров. Вызывается при активации, при смене опросного хоста и при сплите.
 */
function ensureTabLoaded(tab: ShellTab): void {
  const o = options
  if (!o || tab.loaded) return
  tab.loaded = true
  o.container.appendChild(tab.view)
  viewLoadUrl(tab)
}

/** Загрузка/переход гостя на tab.url с безопасной обработкой ошибок. */
function viewLoadUrl(tab: ShellTab): void {
  try {
    tab.view.setAttribute('src', tab.url)
  } catch (err) {
    console.warn('[shell] tab load failed:', err)
  }
}

/**
 * Сообщить main, какой гость сейчас опросный (первая вкладка): только ему
 * оболочка оставляет таймеры без троттлинга — на нём висит tasks-notify.
 */
function publishPollHost(): void {
  if (typeof window === 'undefined' || !window.shell || typeof window.shell.setGuestPollHost !== 'function') return
  const primary = tabs.find((tab) => tab.isPrimary)
  void window.shell.setGuestPollHost(primary?.guestId ?? 0)
}

/** Гость вкладки поднялся (dom-ready): запоминаем его id и публикуем опросного хоста. */
export function setTabGuestId(tab: ShellTab, id: number): void {
  tab.guestId = id
  publishPollHost()
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
  publishPollHost()
  // Новый опросный хост обязан быть загружен: на нём висит tasks-notify.
  if (tabs.length > 0) ensureTabLoaded(tabs[0])
  // Разделение держится на двух вкладках: закрыли одну — остаётся одна на всё окно
  if (split && tabs.length !== 2) {
    unsplit()
    return
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
    ensureTabLoaded(next)
    applyVisibility()
    renderTabBar()
    o.hooks.onActivated(next)
    return
  }
  renderTabBar()
}

/**
 * Переставить вкладку на позицию toIndex (порядок вкладок = порядок массива).
 * Опросный хост — первая вкладка, поэтому при перестановке он меняется:
 * прежнему хосту оболочка гасит опрос, а новый поднимет его сам при первом
 * взятии очереди. Активная вкладка не меняется.
 */
export function moveTab(id: number, toIndex: number): void {
  const o = options
  if (!o || split) return
  const from = tabs.findIndex((tab) => tab.id === id)
  if (from < 0) return
  const to = Math.max(0, Math.min(tabs.length - 1, Math.floor(toIndex)))
  if (to === from) return
  const previousPrimary = tabs[0]
  const [tab] = tabs.splice(from, 1)
  tabs.splice(to, 0, tab)
  if (tabs[0] !== previousPrimary) {
    previousPrimary.isPrimary = false
    tabs[0].isPrimary = true
    o.hooks.onPrimaryChanged?.(previousPrimary)
    publishPollHost()
    // Новый опросный хост должен быть загружен, иначе tasks-notify некуда встать.
    ensureTabLoaded(tabs[0])
  }
  renderTabBar()
}

export function activateTab(tab: ShellTab): void {
  if (!options || !tabs.includes(tab)) return
  // В разделении обе вкладки и так на виду: активация — это перевод фокуса на панель
  if (split) {
    const pane = splitPaneOf(tab)
    if (pane) {
      setSplitFocus(pane)
      return
    }
  }
  activeId = tab.id
  ensureTabLoaded(tab)
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

/**
 * Активировать уже открытую вкладку с таким URL. false — такой вкладки нет,
 * и вызывающий решает сам: перейти текущей или создать новую (focusOrOpenTab).
 * Лента ссылок этим отличается от неё: ЛКМ не должен плодить вкладки.
 */
export function focusTabByUrl(rawUrl: string): boolean {
  const url = normalizeTabUrl(rawUrl)
  if (!url) return false
  const found = tabs.find((tab) => tab.url === url)
  if (!found) return false
  activateTab(found)
  return true
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
  const o = options
  if (!o) return
  if (split) {
    o.container.setAttribute('data-split', '')
    for (const tab of tabs) {
      const pane = splitPaneOf(tab)
      if (!pane) {
        tab.view.setAttribute('data-hidden', '')
        continue
      }
      tab.view.removeAttribute('data-hidden')
      // Раскладку панелей задаём прямо на webview: контейнер остаётся без
      // промежуточных узлов, CSS рисует разделитель по первому потомку.
      tab.view.setAttribute('style', pane === 'left' ? 'left:0;width:50%' : 'left:50%;width:50%')
    }
    return
  }
  o.container.removeAttribute('data-split')
  for (const tab of tabs) {
    tab.view.removeAttribute('style')
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
    // Ctrl+ЛКМ уже отработал на mousedown (открыл окно) — вкладку не активируем.
    if (suppressClickTabId === tab.id) {
      suppressClickTabId = 0
      return
    }
    activateTab(tab)
  })
  button.addEventListener('mousedown', (event) => {
    const mouse = event as MouseEvent
    suppressClickTabId = 0
    if (!isOpenInWindowGesture(mouse)) return
    // Ловим на mousedown, а не на click: окно должно подняться сразу,
    // не дожидаясь отпускания кнопки. preventDefault гасит фокус и выделение.
    mouse.preventDefault()
    suppressClickTabId = tab.id
    openTabInPageWindow(tab)
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
  wireTabDrag(button, tab)
  return button
}

/** Перетаскиваемая вкладка (0 — не перетаскиваем). */
let dragTabId = 0

/**
 * Место вставки при броске на targetId. Считаем по индексам, без геометрии:
 * тянем вправо (с меньшего индекса на больший) — вставляем после цели, иначе
 * до неё. Так перетаскивание вправо всегда даёт ожидаемый порядок, и правило
 * работает одинаково при любой ширине окна.
 */
function dropIndexFor(targetId: number): number {
  const from = tabs.findIndex((tab) => tab.id === dragTabId)
  const target = tabs.findIndex((tab) => tab.id === targetId)
  if (from < 0 || target < 0 || from === target) return -1
  return from < target ? target + 1 : target
}

/**
 * Классы состояния перетаскивания. Полоса работает через className (так же,
 * как updateTabButton), а не через classList, — чтобы не расходились два
 * способа задать один и тот же набор классов.
 */
function markTabDrag(button: HTMLButtonElement, marks: { drag?: boolean; before?: boolean; after?: boolean }): void {
  const active = button.className.includes(' active')
  const parts = ['tab-btn']
  if (active) parts.push('active')
  if (marks.drag) parts.push('dragging')
  if (marks.before) parts.push('drop-before')
  if (marks.after) parts.push('drop-after')
  button.className = parts.join(' ')
}

function clearDropMarks(): void {
  for (const button of stripButtons.values()) {
    if (button.className.includes('drop-')) markTabDrag(button, {})
  }
}

function wireTabDrag(button: HTMLButtonElement, tab: ShellTab): void {
  button.draggable = true
  button.addEventListener('dragstart', (event) => {
    const drag = event as DragEvent
    // В разделении двум вкладкам переставляться нечего, а панели привязаны к
    // вкладкам — перенос сорвал бы порядок [левая, правая] и выбор опросного хоста
    if (split) {
      drag.preventDefault?.()
      return
    }
    dragTabId = tab.id
    markTabDrag(button, { drag: true })
    // Без setData Firefox не начинает перетаскивание. Тип у drag.dataTransfer
    // в тестовом дубле может отсутствовать — отсюда проверка.
    if (drag.dataTransfer) {
      drag.dataTransfer.effectAllowed = 'move'
      drag.dataTransfer.setData('text/plain', String(tab.id))
    }
  })
  button.addEventListener('dragover', (event) => {
    if (!dragTabId || dragTabId === tab.id) return
    const over = event as DragEvent
    // Без preventDefault браузер не согласится на drop.
    over.preventDefault()
    if (over.dataTransfer) over.dataTransfer.dropEffect = 'move'
    clearDropMarks()
    const from = tabs.findIndex((t) => t.id === dragTabId)
    const target = tabs.findIndex((t) => t.id === tab.id)
    markTabDrag(button, from < target ? { after: true } : { before: true })
  })
  button.addEventListener('dragleave', () => {
    if (button.className.includes('drop-')) markTabDrag(button, {})
  })
  button.addEventListener('drop', (event) => {
    const drop = event as DragEvent
    drop.preventDefault()
    const to = dropIndexFor(tab.id)
    const dragged = dragTabId
    clearDropMarks()
    markTabDrag(button, {})
    dragTabId = 0
    if (to >= 0) moveTab(dragged, to)
  })
  button.addEventListener('dragend', () => {
    clearDropMarks()
    if (button.className.includes('dragging')) markTabDrag(button, {})
    dragTabId = 0
  })
}

function updateTabButton(button: HTMLButtonElement, tab: ShellTab): void {
  button.className = tab.id === activeId ? 'tab-btn active' : 'tab-btn'
  // Метка панели — визуальная подсказка «эта вкладка в сплите» (рисуется в CSS)
  const pane = splitPaneOf(tab)
  if (pane) button.setAttribute('data-pane', pane)
  else button.removeAttribute('data-pane')
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

/**
 * Открыть адрес в отдельном окне страницы. Общая точка для полосы вкладок
 * и ленты ссылок: main сам разбирается с allowlist и заголовком окна.
 */
export function openUrlInPageWindow(url: string, title = ''): void {
  if (!url) return
  if (typeof window === 'undefined' || !window.shell || typeof window.shell.openPageWindow !== 'function') return
  void window.shell.openPageWindow(url, title)
}

/**
 * Открыть страницу вкладки в отдельном окне (Ctrl+ЛКМ по вкладке и пункт
 * контекстного меню). Вкладка в оболочке остаётся на месте — окно получает
 * копию страницы.
 */
export function openTabInPageWindow(tab: ShellTab): void {
  openUrlInPageWindow(tab.url || tab.lastAllowedUrl, tab.title)
}

function showTabMenu(tab: ShellTab): void {
  if (typeof window === 'undefined' || !window.shell || typeof window.shell.popupMenu !== 'function') return
  const index = tabs.findIndex((entry) => entry.id === tab.id)
  const items: Array<{ label: string; action: string }> = [
    { label: 'Открыть в новом окне', action: 'open-window' },
    { label: 'Закрыть вкладку', action: 'close' },
  ]
  if (split) {
    // При двух вкладках «закрыть другие/справа» бессмысленны
    items.push({ label: 'Свернуть окно', action: 'unsplit' })
  } else {
    if (canSplit()) items.push({ label: 'Разделить окно', action: 'split' })
    if (tabs.length > 1) items.push({ label: 'Закрыть другие вкладки', action: 'close-others' })
    if (index >= 0 && index < tabs.length - 1) {
      items.push({ label: 'Закрыть вкладки справа', action: 'close-right' })
    }
  }
  // ПКМ не активирует вкладку — запоминаем, к какой вкладке относится меню
  menuTabId = tab.id
  void window.shell.popupMenu(items)
}

function handleTabMenuAction(tab: ShellTab, action: string): void {
  if (action === 'open-window') {
    openTabInPageWindow(tab)
    return
  }
  if (action === 'split') {
    splitView()
    return
  }
  if (action === 'unsplit') {
    unsplit()
    return
  }
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
