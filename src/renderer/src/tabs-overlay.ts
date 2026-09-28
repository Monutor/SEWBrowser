import { setStatus } from './status-ui'
import { normalizeUrl, hostOf } from './util'
import { createTabRow, tabRowButton, closeGroupPanel, renderStrip } from './link-strip'
import {
  orderedGroups,
  tabsInFolder,
  hasUserFolders,
  UNASSIGNED_FOLDER,
  isFolderCollapsed,
  toggleFolderCollapse,
  fillFolderSelect,
  generateFolderId,
  generateTabId,
  saveTabs,
  saveFolders,
  exportTabs,
  importTabs,
} from './nav-store'

export interface TabsOverlayDeps {
  config(): ShellConfig | null
  /** Разрешить операцию с защищённой папкой (пароль введён или «запомнен»). */
  requireFolderPassword(folderId: string): Promise<boolean>
  cancelFolderPasswordPrompt(): void
}

let deps!: TabsOverlayDeps

export function initTabsOverlay(d: TabsOverlayDeps): void {
  deps = d
}

function overlayEl(): HTMLElement {
  return document.getElementById('tabs-overlay') as HTMLElement
}
function listEl(): HTMLElement {
  return document.getElementById('tabs-list') as HTMLElement
}
function tabFormEl(): HTMLElement {
  return document.getElementById('tab-form') as HTMLElement
}
function tabNameEl(): HTMLInputElement {
  return document.getElementById('tab-name') as HTMLInputElement
}
function tabUrlEl(): HTMLInputElement {
  return document.getElementById('tab-url') as HTMLInputElement
}
function exportBtnEl(): HTMLButtonElement {
  return document.getElementById('tabs-export') as HTMLButtonElement
}
function importBtnEl(): HTMLButtonElement {
  return document.getElementById('tabs-import') as HTMLButtonElement
}
function importFileEl(): HTMLInputElement {
  return document.getElementById('tabs-import-file') as HTMLInputElement
}
function folderFormEl(): HTMLElement {
  return document.getElementById('folder-form') as HTMLElement
}
function folderNameEl(): HTMLInputElement {
  return document.getElementById('folder-name') as HTMLInputElement
}
function folderProtectEl(): HTMLInputElement {
  return document.getElementById('folder-protect') as HTMLInputElement
}
function folderPasswordEl(): HTMLInputElement {
  return document.getElementById('folder-password') as HTMLInputElement
}
function folderPwdFieldEl(): HTMLElement {
  return document.getElementById('folder-pwd-field') as HTMLElement
}
function folderSelectEl(): HTMLSelectElement {
  return document.getElementById('tab-folder') as HTMLSelectElement
}

let tabsOpen = false
let editingTabId: string | null = null
let editingFolderId: string | null = null

export function isTabsOpen(): boolean {
  return tabsOpen
}

export function tabsOverlayEl(): HTMLElement {
  return overlayEl()
}

export function wireTabs(): void {
  document.getElementById('tab-add')?.addEventListener('click', () => void openTabs())
  document.getElementById('tab-manage')?.addEventListener('click', () => void openTabs())
  document.getElementById('tab-add-new')?.addEventListener('click', () => { resetForm(); openEditForm({ id: '', name: '', url: '' }) })
  exportBtnEl()?.addEventListener('click', () => void exportTabs())
  importBtnEl()?.addEventListener('click', () => { if (importFileEl()) importFileEl().click() })
  importFileEl()?.addEventListener('change', (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) void importTabs(file)
    // Снимаем значение, чтобы повторный выбор того же файла снова сработал
    if (importFileEl()) importFileEl().value = ''
  })
  document.getElementById('tab-save')?.addEventListener('click', () => void saveCurrentTab())
  document.getElementById('tab-cancel')?.addEventListener('click', () => { resetForm() })
  document.getElementById('tabs-close')?.addEventListener('click', closeTabs)
  tabNameEl()?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void saveCurrentTab() })
  tabUrlEl()?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void saveCurrentTab() })
  document.getElementById('folder-add-new')?.addEventListener('click', () => openFolderForm())
  document.getElementById('folder-save')?.addEventListener('click', () => void saveCurrentFolder())
  document.getElementById('folder-cancel')?.addEventListener('click', () => resetFolderForm())
  folderProtectEl()?.addEventListener('change', toggleFolderPasswordField)
  folderNameEl()?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') void saveCurrentFolder() })
}

// Клик строго по фону оверлея (мимо карточки) закрывает модалку
// ---------- Папки для вкладок ----------

export function openFolderForm(folder?: NavFolder): void {
  editingFolderId = folder?.id ?? null
  if (folderNameEl()) folderNameEl().value = folder?.name ?? ''
  // Защита: для уже защищённой папки галочка включена, поле пустое (пароль не показываем).
  if (folderProtectEl()) {
    folderProtectEl().checked = !!folder?.passwordId
    if (folderPasswordEl()) folderPasswordEl().placeholder = folder?.passwordId ? 'Новый пароль (пусто = без изменений)' : ''
  }
  toggleFolderPasswordField()
  folderFormEl() && (folderFormEl().hidden = false)
  folderNameEl()?.focus()
}

function resetFolderForm(): void {
  editingFolderId = null
  if (folderNameEl()) folderNameEl().value = ''
  if (folderProtectEl()) folderProtectEl().checked = false
  if (folderPasswordEl()) { folderPasswordEl().value = ''; folderPasswordEl().placeholder = '' }
  toggleFolderPasswordField()
  folderFormEl() && (folderFormEl().hidden = true)
}

/** Показать/скрыть поле пароля в зависимости от галочки «защитить папку». */
function toggleFolderPasswordField(): void {
  const show = folderProtectEl()?.checked ?? false
  if (folderPwdFieldEl()) folderPwdFieldEl().hidden = !show
  if (show && folderPasswordEl()) folderPasswordEl().focus()
}

export async function saveCurrentFolder(): Promise<void> {
  const name = folderNameEl()?.value.trim() ?? ''
  if (!name) {
    setStatus('Укажите название папки')
    return
  }
  const protectChecked = folderProtectEl()?.checked ?? false
  // Пароль тримим сразу: пробелы по краям не значимы (хранилище тоже тримит),
  // иначе пароль из одних пробелов молча снимал бы защиту или лочил папку.
  const password = (folderPasswordEl()?.value ?? '').trim()
  const folders = [...(deps.config()?.folders ?? [])]
  if (editingFolderId) {
    const i = folders.findIndex((f) => f.id === editingFolderId)
    if (i !== -1) {
      const existing = folders[i]
      // Снятие или смена пароля уже защищённой папки — только после проверки текущего пароля.
      const touchesProtection = !protectChecked || Boolean(password)
      if (existing.passwordId && touchesProtection && !(await deps.requireFolderPassword(existing.id))) return
      if (protectChecked && password) {
        // Задать или заменить пароль.
        const pid = await window.shell.saveFolderPassword(existing.id, password)
        folders[i] = { ...existing, name, ...(pid ? { passwordId: pid } : {}) }
        if (!pid) setStatus('Шифрохранилище недоступно — папка без пароля')
      } else if (!protectChecked) {
        // Снять защиту.
        await window.shell.clearFolderPassword(existing.id)
        folders[i] = { ...existing, name, passwordId: undefined }
      } else if (existing.passwordId) {
        // Галочка включена, но пароль пустой — оставляем старый (редактирование имени).
        folders[i] = { ...existing, name }
      } else {
        // Галочка включена, пароль пустой и раньше его не было — без защиты (с предупреждением).
        folders[i] = { ...existing, name, passwordId: undefined }
        setStatus('Пароль пустой — папка сохранена без защиты')
      }
    }
  } else {
    const id = generateFolderId()
    if (protectChecked && password) {
      const pid = await window.shell.saveFolderPassword(id, password)
      folders.push({ id, name, ...(pid ? { passwordId: pid } : {}) })
      if (!pid) setStatus('Шифрохранилище недоступно — папка без пароля')
    } else {
      // Галка защиты с пустым паролем — папка без защиты, но не молча.
      if (protectChecked) setStatus('Пароль пустой — папка создана без защиты')
      folders.push({ id, name })
    }
  }
  await saveFolders(folders)
  resetFolderForm()
}

export async function deleteFolder(id: string): Promise<void> {
  // Защищённую папку удаляем только после проверки пароля.
  if (!(await deps.requireFolderPassword(id))) return
  const cfg = deps.config()
  if (!cfg || !window.confirm('Удалить папку? Вкладки из неё станут «без папки».')) return
  const folders = cfg.folders.filter((f) => f.id !== id)
  // Вкладки удалённой папки переходят в «без папки».
  const tabs = cfg.tabs.map((t) => (t.folderId === id ? { ...t, folderId: undefined } : t))
  await Promise.all([saveFolders(folders), saveTabs(tabs)])
}

export function refreshTabsList(): void {
  const cfg = deps.config()
  if (!listEl() || !cfg) return
  listEl().innerHTML = ''
  if (!hasUserFolders()) {
    for (const tab of cfg.tabs) listEl().append(createTabRow(tab))
    return
  }
  // Вкладки без папки — плоским списком (без секции «Без папки»).
  for (const tab of tabsInFolder(UNASSIGNED_FOLDER)) listEl().append(createTabRow(tab))
  for (const group of orderedGroups()) {
    if (group.id === UNASSIGNED_FOLDER) continue
    const groupTabs = tabsInFolder(group.id)
    const section = document.createElement('div')
    section.className = 'folder-section' + (isFolderCollapsed(group.id) ? ' collapsed' : '')
    section.dataset.folderId = group.id
    const header = document.createElement('div')
    header.className = 'folder-header'
    const chevron = document.createElement('span')
    chevron.className = 'folder-chevron'
    chevron.textContent = isFolderCollapsed(group.id) ? '▶' : '▼'
    const titleEl = document.createElement('span')
    titleEl.className = 'folder-name'
    titleEl.textContent = group.name
    const count = document.createElement('span')
    count.className = 'folder-count'
    count.textContent = String(groupTabs.length)
    header.append(chevron, titleEl, count)
    // Сворачивание секции по клику на шапке (кнопки переименования/удаления — отдельно).
    header.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null
      if (target && target.closest('.folder-rename, .folder-del')) return
      toggleFolderCollapse(group.id)
    })
    if (group.id !== UNASSIGNED_FOLDER) {
      const rename = tabRowButton('✎', 'Переименовать', () => openFolderForm(cfg.folders.find((f) => f.id === group.id)))
      rename.className = 'folder-rename'
      header.append(rename)
      const del = tabRowButton('🗑', 'Удалить папку (вкладки станут «без папки»)', () => void deleteFolder(group.id), 'folder-del')
      header.append(del)
    }
    section.append(header)
    const body = document.createElement('div')
    body.className = 'folder-tabs'
    if (!groupTabs.length) {
      const empty = document.createElement('div')
      empty.className = 'tabs-empty-hint'
      empty.textContent = 'Нет вкладок'
      body.append(empty)
    }
    for (const tab of groupTabs) body.append(createTabRow(tab))
    section.append(body)
    listEl().append(section)
  }
}

export function openEditForm(tab: NavTab): void {
  editingTabId = tab.id
  if (tabNameEl()) tabNameEl().value = tab.name
  if (tabUrlEl()) tabUrlEl().value = tab.url
  if (folderSelectEl()) fillFolderSelect(folderSelectEl(), tab.folderId)
  tabFormEl() && (tabFormEl().hidden = false)
  tabNameEl()?.focus()
}

function resetForm(): void {
  editingTabId = null
  if (tabNameEl()) tabNameEl().value = ''
  if (tabUrlEl()) tabUrlEl().value = ''
  tabFormEl() && (tabFormEl().hidden = true)
}

export async function saveCurrentTab(): Promise<void> {
  const name = tabNameEl()?.value.trim() ?? ''
  const urlRaw = tabUrlEl()?.value.trim() ?? ''
  if (!name || !urlRaw) {
    setStatus('Укажите название и ссылку')
    return
  }
  const url = normalizeUrl(urlRaw)
  let folderId: string | undefined
  if (folderSelectEl()) {
    const v = folderSelectEl().value
    folderId = v === UNASSIGNED_FOLDER ? undefined : v
  } else {
    const existing = deps.config()?.tabs.find((t) => t.id === editingTabId)
    folderId = existing?.folderId
  }
  const tabs = [...(deps.config()?.tabs ?? [])]
  if (editingTabId) {
    const i = tabs.findIndex((t) => t.id === editingTabId)
    if (i !== -1) tabs[i] = { ...tabs[i], name, url, folderId }
  } else {
    tabs.push({ id: generateTabId(), name, url, folderId })
  }
  await saveTabs(tabs)
  resetForm()
}

export async function deleteTab(id: string): Promise<void> {
  const cfg = deps.config()
  if (!cfg || !window.confirm('Удалить вкладку?')) return
  const tabs = cfg.tabs.filter((t) => t.id !== id)
  await saveTabs(tabs)
}

// Перемещение вкладки вверх/вниз внутри своей папки (или «без папки»).
export async function moveTab(id: string, dir: number): Promise<void> {
  const cfg = deps.config()
  if (!cfg) return
  const tabs = cfg.tabs
  const target = tabs.find((t) => t.id === id)
  if (!target) return
  const groupId = target.folderId ?? UNASSIGNED_FOLDER
  const groupTabs = tabs.filter((t) => (t.folderId ?? UNASSIGNED_FOLDER) === groupId)
  const idx = groupTabs.findIndex((t) => t.id === id)
  const j = idx + dir
  if (idx === -1 || j < 0 || j >= groupTabs.length) return
  const iFull = tabs.findIndex((t) => t.id === id)
  const jFull = tabs.findIndex((t) => t.id === groupTabs[j].id)
  ;[tabs[iFull], tabs[jFull]] = [tabs[jFull], tabs[iFull]]
  await saveTabs(tabs)
}

// Смена папки вкладки (из селектора в оверлее).
export async function moveTabToFolder(id: string, folderId: string | null): Promise<void> {
  const cfg = deps.config()
  if (!cfg) return
  const tabs = [...cfg.tabs]
  const i = tabs.findIndex((t) => t.id === id)
  if (i === -1) return
  tabs[i] = { ...tabs[i], folderId: folderId ?? undefined }
  await saveTabs(tabs)
}

export function openTabs(): void {
  if (!overlayEl()) return
  editingTabId = null
  editingFolderId = null
  resetFolderForm()
  tabFormEl() && (tabFormEl().hidden = true)
  refreshTabsList()
  overlayEl().hidden = false
  tabsOpen = true
}

export function closeTabs(): void {
  if (!overlayEl()) return
  overlayEl().hidden = true
  tabsOpen = false
  editingTabId = null
  editingFolderId = null
  resetFolderForm()
  tabFormEl() && (tabFormEl().hidden = true)
}

