import { activeView, focusOrOpenTab } from './tabs'
import { UNASSIGNED_FOLDER, fillFolderSelect, hasUserFolders, orderedGroups, tabsInFolder } from './nav-store'

/**
 * Лента ссылок под тулбаром и выпадающий список вкладок папки.
 * Формы вкладок/папок живут в tabs-overlay, а строки вкладок строятся здесь,
 * поэтому функции перемещения/редактирования приходят снаружи: модули не
 * импортируют друг друга.
 */
export interface LinkStripDeps {
  config(): ShellConfig | null
  promptFolderPassword(folderId: string): Promise<string | null>
  closeTabs(): void
  moveTab(tabId: string, delta: number): void
  openEditForm(tab: NavTab): void
  deleteTab(tabId: string): void
  moveTabToFolder(tabId: string, folderId: string | null): void
}

let deps!: LinkStripDeps

export function initLinkStrip(d: LinkStripDeps): void {
  deps = d
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
    btn.addEventListener('click', () => focusOrOpenTab(tab.url))
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
  const group = orderedGroups().find((g) => g.id === folderId)
  // Защищённую папку разворачиваем только после ввода правильного пароля.
  if (group?.passwordId && (await deps.promptFolderPassword(folderId)) === null) return // Отмена.
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
    row.addEventListener('click', () => {
      focusOrOpenTab(tab.url)
      closeGroupPanel()
    })
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
    void deps.closeTabs()
    focusOrOpenTab(tab.url)
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
    void deps.moveTabToFolder(tab.id, v === UNASSIGNED_FOLDER ? null : v)
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
