import { activeView, focusOrOpenTab, focusTabByUrl, openTab } from './tabs'
import { isOpenInWindowGesture } from './tabs-core.ts'
import { UNASSIGNED_FOLDER, fillFolderSelect, hasUserFolders, orderedGroups, tabsInFolder } from './nav-store'

/**
 * Лента ссылок под тулбаром и выпадающий список вкладок папки.
 * Формы вкладок/папок живут в tabs-overlay, а строки вкладок строятся здесь,
 * поэтому функции перемещения/редактирования приходят снаружи: модули не
 * импортируют друг друга.
 */
export interface LinkStripDeps {
  config(): ShellConfig | null
  /** Разрешить раскрытие защищённой папки (без пароля, «запомнено» или введён). */
  ensureFolderAccess(folderId: string): Promise<boolean>
  closeTabs(): void
  moveTab(tabId: string, delta: number): void
  openEditForm(tab: NavTab): void
  deleteTab(tabId: string): void
  moveTabToFolder(tabId: string, folderId: string | null): void
  /** Навигация активной вкладки (обёртка над address-bar navigate) с проверкой allowlist. */
  navigateCurrent(url: string): void
}

/** Действия контекстного меню вкладки ленты. Префикс nav- отделяет их от меню
 *  полосы вкладок: onMenuAction один на оба, и чужое action'у не должно совпасть. */
const NAV_MENU_CURRENT = 'nav-current'
const NAV_MENU_NEW = 'nav-new'

/** URL вкладки, для которой открыто контекстное меню: ПКМ сам по себе ничего не открывает. */
let menuUrl: string | null = null

/** URL вкладки, у которой mousedown уже открыл окно: ensuing click не должен
 *  ещё и увести текущую вкладку. Сбрасывается на самом click. */
let suppressClickUrl: string | null = null

let deps!: LinkStripDeps

export function initLinkStrip(d: LinkStripDeps): void {
  deps = d
  if (typeof window !== 'undefined' && window.shell && typeof window.shell.onMenuAction === 'function') {
    window.shell.onMenuAction((action) => {
      const url = menuUrl
      menuUrl = null
      if (!url) return
      if (action === NAV_MENU_NEW) openTab(url, { activate: true })
      else if (action === NAV_MENU_CURRENT && !focusTabByUrl(url)) deps.navigateCurrent(url)
    })
  }
}

function stripEl(): HTMLElement {
  return document.getElementById('tabstrip') as HTMLElement
}

function tabsBarEl(): HTMLElement {
  return document.getElementById('tabs') as HTMLElement
}

function groupPanelEl(): HTMLElement {
  return document.getElementById('tab-group-panel') as HTMLElement
}

let expandedGroupId: string | null = null
let panelOutsideHandler: ((event: MouseEvent) => void) | null = null

/** Открыт ли выпадающий список папки — нужно escape-цепочке хоткеев. */
export function isGroupPanelOpen(): boolean {
  return expandedGroupId !== null
}

export function currentViewUrl(): string {
  try {
    return activeView()?.getURL() ?? ''
  } catch {
    return ''
  }
}

/**
 * Поведение вкладки ленты (и строки её в выпадающем списке папки):
 * ЛКМ — переход в текущем окне: если вкладка с таким URL уже открыта,
 * переключаемся на неё, иначе навигируем текущую (новую не создаём);
 * СКМ и пункт меню — новая вкладка;
 * Ctrl+ЛКМ — новая вкладка в фоне (как Ctrl+клик по ссылке в самой странице:
 * LINK_HOOK в tab-events.ts тоже открывает её без активации).
 * afterOpen вызывается после любого открытия — списку папки он закрывает себя.
 */
function wireNavTab(el: HTMLElement, url: string, afterOpen?: () => void): void {
  el.addEventListener('click', () => {
    // Ctrl+ЛКМ уже отработал на mousedown (открыл вкладку) — перехода не будет.
    if (suppressClickUrl === url) {
      suppressClickUrl = null
      return
    }
    if (!focusTabByUrl(url)) deps.navigateCurrent(url)
    afterOpen?.()
  })
  el.addEventListener('mousedown', (event) => {
    const mouse = event as MouseEvent
    // Сброс на каждом нажатии: если click не придёт (строку выпадающего списка
    // уже отсоединил afterOpen), флаг не должен утечь на следующий клик.
    suppressClickUrl = null
    if (!isOpenInWindowGesture(mouse)) return
    // Ловим на mousedown, чтобы вкладка появилась сразу, не дожидаясь
    // отпускания кнопки; preventDefault гасит фокус и выделение.
    mouse.preventDefault()
    suppressClickUrl = url
    openTab(url)
    afterOpen?.()
  })
  el.addEventListener('auxclick', (event) => {
    const mouse = event as MouseEvent
    // Кнопка 1 — средняя. На button'е средний клик не даёт click, на строке
    // списка — тем более, так что ЛКМ-обработчик сюда не попадёт.
    if (mouse.button !== 1) return
    mouse.preventDefault()
    openTab(url, { activate: true })
    afterOpen?.()
  })
  el.addEventListener('contextmenu', (event) => {
    const mouse = event as MouseEvent
    mouse.preventDefault()
    showNavTabMenu(url)
  })
}

/** Контекстное меню вкладки ленты: открыть в текущем окне или в новой вкладке. */
function showNavTabMenu(url: string): void {
  if (typeof window === 'undefined' || !window.shell || typeof window.shell.popupMenu !== 'function') return
  menuUrl = url
  void window.shell.popupMenu([
    { label: 'Открыть в текущем окне', action: NAV_MENU_CURRENT },
    { label: 'Открыть в новой вкладке', action: NAV_MENU_NEW },
  ])
}

// Лента ссылок в третьей строке оболочки (под полосой вкладок и тулбаром).
// Всегда видима (даже при пустом списке), иначе кнопки +/⋮ внутри скрытой
// ленты недостижимы, а в тулбаре отдельной кнопки не было — на чистой
// установке вкладки нельзя было создать. При отсутствии папок — плоская лента
// (обратная совместимость); при наличии вкладки без папки отображаются плоскими
// строками, а по реальным папкам строятся группы, раскрытие которых показывает
// список вкладок выпадающим блоком под лентой.
export function renderStrip(): void {
  if (!stripEl() || !tabsBarEl() || !deps.config()) return
  stripEl().hidden = false
  tabsBarEl().innerHTML = ''
  const current = currentViewUrl()
  // Вкладки без папки отображаем плоскими строками (без группы «Без папки»).
  for (const tab of tabsInFolder(UNASSIGNED_FOLDER)) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tab' + (tab.url === current ? ' active' : '')
    btn.dataset.url = tab.url
    btn.textContent = tab.name
    btn.title = tab.url
    wireNavTab(btn, tab.url)
    tabsBarEl().append(btn)
  }
  if (!hasUserFolders()) return
  for (const group of orderedGroups()) {
    if (group.id === UNASSIGNED_FOLDER) continue
    const groupTabs = tabsInFolder(group.id)
    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'tab-group-header'
    header.dataset.folderId = group.id
    const chevron = document.createElement('span')
    chevron.className = 'tab-group-chevron'
    chevron.textContent = expandedGroupId === group.id ? '▼' : '▶'
    const label = document.createElement('span')
    label.className = 'tab-group-name'
    label.textContent = group.name
    const count = document.createElement('span')
    count.className = 'tab-group-count'
    count.textContent = String(groupTabs.length)
    header.append(chevron, label, count)
    header.title = group.id === UNASSIGNED_FOLDER ? `Вкладки без папки (${groupTabs.length})` : `${group.name} (${groupTabs.length})`
    header.addEventListener('click', () => toggleExpandInStrip(group.id))
    tabsBarEl().append(header)
  }
}

/** Развернуть вкладки папки списком под лентой (по одному). Повторный клик — свернуть.
 *  Защищённую папку разворачиваем только после ввода правильного пароля. */
async function toggleExpandInStrip(folderId: string): Promise<void> {
  // Свёрнутая папка — разворачиваем (защищённую: с запросом пароля).
  if (expandedGroupId === folderId) {
    closeGroupPanel()
    renderStrip()
    return
  }
  // Защищённую папку разворачиваем только после ввода правильного пароля
  // (или пока он «запомнен» — тогда диалога нет).
  if (!(await deps.ensureFolderAccess(folderId))) return
  expandedGroupId = folderId
  renderStrip()
  renderGroupPanel()
}

/** Скрыть выпадающий список папки и снять обработчики. */
export function closeGroupPanel(): void {
  expandedGroupId = null
  if (groupPanelEl()) groupPanelEl().hidden = true
  if (groupPanelEl()) groupPanelEl().innerHTML = ''
  if (panelOutsideHandler) {
    document.removeEventListener('click', panelOutsideHandler, true)
    panelOutsideHandler = null
  }
}

/** Построить выпадающий список вкладок развёрнутой папки под лентой. */
function renderGroupPanel(): void {
  if (!groupPanelEl()) return
  if (expandedGroupId === null) {
    closeGroupPanel()
    return
  }
  const group = orderedGroups().find((g) => g.id === expandedGroupId)
  if (!group) {
    closeGroupPanel()
    return
  }
  const groupTabs = tabsInFolder(group.id)

  groupPanelEl().innerHTML = ''
  const section = document.createElement('div')
  section.className = 'tg-section'
  const head = document.createElement('div')
  head.className = 'tg-section-head'
  const headName = document.createElement('span')
  headName.textContent = group.name
  const headCount = document.createElement('span')
  headCount.className = 'tg-count'
  headCount.textContent = `(${groupTabs.length})`
  head.append(headName, headCount)
  section.append(head)

  const list = document.createElement('div')
  list.className = 'tg-list'
  if (!groupTabs.length) {
    const empty = document.createElement('div')
    empty.className = 'tabs-empty-hint'
    empty.textContent = 'Нет вкладок'
    list.append(empty)
  }
  const current = currentViewUrl()
  for (const tab of groupTabs) {
    const row = document.createElement('div')
    row.className = 'tg-row' + (tab.url === current ? ' active' : '')
    row.dataset.url = tab.url
    const name = document.createElement('span')
    name.className = 'tg-name'
    name.textContent = tab.name
    name.title = tab.url
    const url = document.createElement('span')
    url.className = 'tg-url'
    url.textContent = tab.url
    row.append(name, url)
    wireNavTab(row, tab.url, closeGroupPanel)
    list.append(row)
  }
  section.append(list)
  groupPanelEl().append(section)

  // Показываем до измерения (display:none дает scrollWidth=0), всё синхронно — без мерцания.
  groupPanelEl().hidden = false

  // Привязка под шапку папки: ширина из CSS, центрирование под кнопкой с отступом от краёв.
  const header = stripEl()?.querySelector<HTMLElement>(`.tab-group-header[data-folder-id="${expandedGroupId}"]`)
  if (header) {
    const rect = header.getBoundingClientRect()
    let left = rect.left + (rect.width - groupPanelEl().offsetWidth) / 2
    left = Math.max(12, Math.min(left, window.innerWidth - 12 - groupPanelEl().offsetWidth))
    groupPanelEl().style.left = `${left}px`
  }

  wireGroupPanelDismiss()
}

/** Закрытие выпадающего списка: клик вне панели или Esc. */
function wireGroupPanelDismiss(): void {
  if (panelOutsideHandler) return
    panelOutsideHandler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      // Клик по строке вкладки — её собственный слушатель навигирует и закрывает.
      if (target && target.closest('.tg-row')) return
      // Клик по шапке группы обрабатывается её собственным слушателем — не закрываем.
      if (target && target.closest('.tab-group-header')) return
      closeGroupPanel()
    }
  document.addEventListener('click', panelOutsideHandler, true)
}

// Точечное обновление активного класса без пересборки ленты (без потери фокуса).
export function updateActiveTab(): void {
  if (!tabsBarEl()) return
  const current = currentViewUrl()
  for (const el of tabsBarEl().querySelectorAll<HTMLElement>('.tab')) {
    el.classList.toggle('active', el.dataset.url === current)
  }
  if (groupPanelEl() && expandedGroupId !== null) {
    for (const row of groupPanelEl().querySelectorAll<HTMLElement>('.tg-row')) {
      row.classList.toggle('active', row.dataset.url === current)
    }
  }
}

/** Переход по строке вкладки оверлея. Вкладки защищённой папки в оверлее не
 *  рисуются, пока пароль не введён; проверка здесь — страховка на случай, если
 *  строка всё же оказалась в DOM (или папку заблокировали при открытом оверлее). */
async function navigateFromOverlayRow(tab: NavTab): Promise<void> {
  if (tab.folderId && !(await deps.ensureFolderAccess(tab.folderId))) return
  deps.closeTabs()
  focusOrOpenTab(tab.url)
}

/** Перенос вкладки из строки в выбранную папку. В защищённую — только после
 *  пароля, иначе вкладка попала бы в закрытую папку без спроса. При отказе
 *  выбор возвращается к фактической папке вкладки. */
async function moveRowToFolder(tab: NavTab, sel: HTMLSelectElement, value: string): Promise<void> {
  if (value === UNASSIGNED_FOLDER) {
    deps.moveTabToFolder(tab.id, null)
    return
  }
  if (!(await deps.ensureFolderAccess(value))) {
    fillFolderSelect(sel, tab.folderId)
    return
  }
  deps.moveTabToFolder(tab.id, value)
}

// Строка вкладки в оверлее: название/ссылка + перемещение по папке, поднять/
// опустить (в пределах папки), редактирование, удаление. Клик по строке —
// навигация; кнопки и селектор папки через stopPropagation.
export function createTabRow(tab: NavTab): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tab-row'
  row.dataset.tabId = tab.id
  const info = document.createElement('div')
  info.className = 'tab-info'
  const name = document.createElement('span')
  name.className = 'tab-name'
  name.textContent = tab.name
  name.title = tab.url
  const url = document.createElement('span')
  url.className = 'tab-url'
  url.textContent = tab.url
  info.append(name, url)
  row.append(info)
  row.addEventListener('click', (e: MouseEvent) => {
    if ((e.target as HTMLElement)?.closest('.tab-row button') || (e.target as HTMLElement).closest('.tab-folder-select')) return
    void navigateFromOverlayRow(tab)
  })
  const up = tabRowButton('↑', 'Поднять выше', () => void deps.moveTab(tab.id, -1))
  const down = tabRowButton('↓', 'Опустить ниже', () => void deps.moveTab(tab.id, 1))
  const edit = tabRowButton('✎', 'Редактировать', () => deps.openEditForm(tab))
  const del = tabRowButton('🗑', 'Удалить', () => void deps.deleteTab(tab.id), 'tab-del')
  row.append(up, down, edit, del)
  const sel = document.createElement('select')
  sel.className = 'tab-folder-select'
  sel.title = 'Папка'
  fillFolderSelect(sel, tab.folderId)
  sel.addEventListener('change', (e: Event) => {
    const v = (e.target as HTMLSelectElement).value
    void moveRowToFolder(tab, sel, v)
  })
  row.append(sel)
  return row
}

export function tabRowButton(text: string, title: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = extraClass
  b.textContent = text
  b.title = title
  b.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); onClick() })
  return b
}

// Список вкладок в оверлее управления. При отсутствии папок — плоский список
// (как раньше); при наличии — секции по папкам со сворачиванием.
