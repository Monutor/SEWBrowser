import { exportableTabs } from './folder-access-core'
import { setStatus } from './status-ui'
import { TABS_FILE_FORMAT, TABS_FILE_VERSION, parseTabFile, type TabFilePayload } from './tabs-file.ts'

export interface NavStoreDeps {
  config(): ShellConfig | null
  setConfig(patch: Partial<ShellConfig>): Promise<ShellConfig | null>
  renderStrip(): void
  refreshTabsList(): void
  closeGroupPanel(): void
}

let deps!: NavStoreDeps

/** Свёрнутые папки ленты. Состояние живёт здесь, потому что им пользуются и рендеры. */
const collapsedFolders = new Set<string>()

export function initNavStore(d: NavStoreDeps): void {
  deps = d
}

/** Свёрнута ли папка в ленте. */
export function isFolderCollapsed(folderId: string): boolean {
  return collapsedFolders.has(folderId)
}

/** Формат файла: заголовок для валидации + папки + массив вкладок. */
export function buildTabsJson(): string {
  // Защищённые папки и вкладки внутри них в файл не попадают: иначе пароль
  // обходится выгруженной ссылкой.
  const { folders, tabs } = exportableTabs({ folders: deps.config()?.folders ?? [], tabs: deps.config()?.tabs ?? [] })
  const payload: TabFilePayload = {
    format: TABS_FILE_FORMAT,
    version: TABS_FILE_VERSION,
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    tabs: tabs.map((t) => ({ id: t.id, name: t.name, url: t.url, ...(t.folderId ? { folderId: t.folderId } : {}) })),
  }
  return JSON.stringify(payload, null, 2)
}

export async function exportTabs(): Promise<void> {
  const cfg = deps.config()
  if (!cfg?.tabs.length) {
    setStatus('Нет вкладок для экспорта')
    return
  }
  const { folders, tabs } = exportableTabs({ folders: cfg.folders, tabs: cfg.tabs })
  if (!tabs.length) {
    setStatus('Все вкладки в защищённых папках — экспортировать нечего')
    return
  }
  const skipped = cfg.tabs.length - tabs.length
  const info = skipped ? `, скрыто защищённых: ${skipped}` : ''
  const stamp = new Date().toISOString().slice(0, 10)
  const ok = await window.shell.saveTabsFile(buildTabsJson(), `sewbrowser-tabs-${stamp}.json`)
  setStatus(ok ? `Экспорт: ${tabs.length} вкладок (${folders.length} папок) сохранён${info}` : 'Экпорт отменён')
}

export function importTabs(file: File): void {
  const reader = new FileReader()
  reader.onload = async () => {
    const parsed = parseTabFile(String(reader.result ?? ''), {
      existingFolderIds: (deps.config()?.folders ?? []).map((f) => f.id),
      generateTabId,
      generateFolderId,
    })
    if (!parsed.ok) {
      setStatus(
        parsed.error === 'json'
          ? 'Файл не является валидным JSON'
          : parsed.error === 'format'
            ? 'Неверный формат файла (ожидался экспорт вкладок SEWBrowser)'
            : 'В файле нет валидных вкладок',
      )
      return
    }
    if (!window.confirm(`Заменить текущие ${deps.config()?.tabs.length ?? 0} вкладок на ${parsed.tabs.length} импортированные?`)) {
      return
    }
    await saveTabs(parsed.tabs)
    // Если в файле есть папки — заменяем структуру папок целиком.
    if (parsed.folders.length) await saveFolders(parsed.folders)
    setStatus(`Импорт: ${parsed.tabs.length} вкладок из ${file.name}`)
  }
  reader.onerror = () => setStatus('Не удалось прочитать файл')
  reader.readAsText(file)
}
export function generateTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

/** Сентинель для вкладок без папки (не может совпасть с реальным id — начинается с _). */
export const UNASSIGNED_FOLDER = '__unassigned__'

export function hasUserFolders(): boolean {
  return (deps.config()?.folders ?? []).length > 0
}

/** Папки в порядке хранения + фиктивная секция «Без папки» в начале. */
export function orderedGroups(): Array<{ id: string; name: string; passwordId?: string }> {
  return [{ id: UNASSIGNED_FOLDER, name: 'Без папки' }, ...(deps.config()?.folders ?? [])]
}

/** Вкладки конкретной папки (UNASSIGNED_FOLDER — вкладки без folderId). */
export function tabsInFolder(folderId: string): NavTab[] {
  const tabs = deps.config()?.tabs ?? []
  if (folderId === UNASSIGNED_FOLDER) return tabs.filter((t) => !t.folderId)
  return tabs.filter((t) => t.folderId === folderId)
}

export function generateFolderId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

export async function saveFolders(folders: NavFolder[]): Promise<void> {
  // Через deps.setConfig, а не window.shell.setConfig напрямую: обёртка в main
  // перезаписывает его кэш конфига, и renderStrip ниже читает уже свежие данные.
  await deps.setConfig({ folders })
  deps.closeGroupPanel()
  deps.renderStrip()
  deps.refreshTabsList()
}

/** Свернуть/развернуть секцию папки в ленте и оверлее. */
export function toggleFolderCollapse(folderId: string): void {
  if (collapsedFolders.has(folderId)) collapsedFolders.delete(folderId)
  else collapsedFolders.add(folderId)
  deps.renderStrip()
  deps.refreshTabsList()
}

/** Заполнить <select> папками (всегда есть опция «Без папки»). */
export function fillFolderSelect(sel: HTMLSelectElement, folderId: string | undefined): void {
  sel.innerHTML = ''
  const unassigned = document.createElement('option')
  unassigned.value = UNASSIGNED_FOLDER
  unassigned.textContent = 'Без папки'
  sel.append(unassigned)
  for (const f of deps.config()?.folders ?? []) {
    const opt = document.createElement('option')
    opt.value = f.id
    opt.textContent = f.name
    sel.append(opt)
  }
  sel.value = folderId ?? UNASSIGNED_FOLDER
}

export async function saveTabs(tabs: NavTab[]): Promise<void> {
  // См. saveFolders: без обёртки deps.setConfig кэш конфига в main остался бы
  // старым, и лента перерисовалась бы по прежним вкладкам.
  await deps.setConfig({ tabs })
  deps.closeGroupPanel()
  deps.renderStrip()
  deps.refreshTabsList()
}
