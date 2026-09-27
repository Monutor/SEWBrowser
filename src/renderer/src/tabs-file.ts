import { normalizeUrl } from './util.ts'

/** Формат файла: заголовок для валидации + папки + массив вкладок. */
export const TABS_FILE_FORMAT = 'sewbrowser-tabs'
export const TABS_FILE_VERSION = 2

export interface TabFilePayload {
  format: string
  version: number
  /** Папки (v2); старые файлы v1 без них. */
  folders?: NavFolder[]
  tabs: NavTab[]
}

/** Причина отказа импорта: 'json' — не JSON, 'format' — чужой формат, 'empty' — нет валидных вкладок. */
export type TabFileError = 'json' | 'format' | 'empty'

export type TabFileParseResult =
  | { ok: false; error: TabFileError }
  | { ok: true; tabs: NavTab[]; folders: NavFolder[] }

export interface TabFileParseOptions {
  /** id уже существующих папок — их коллизии разрешаются пересозданием id. */
  existingFolderIds?: readonly string[]
  generateTabId?: () => string
  generateFolderId?: () => string
}

function defaultTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

function defaultFolderId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }
}

/**
 * Разбор файла экспорта вкладок. Никаких побочных эффектов: без window.confirm,
 * без записи в конфиг и без статуса — вызывающий решает, что делать с результатом.
 *
 * Логика перенесена из `importTabs` дословно: вкладки без имени или url отбрасываются,
 * папки с коллизией id получают новый id, ссылки вкладок переписываются через карту
 * ремаппинга, «висячие» ссылки на несуществующие папки обнуляются.
 */
export function parseTabFile(
  raw: string,
  options: TabFileParseOptions = {},
): TabFileParseResult {
  const genTab = options.generateTabId ?? defaultTabId
  const genFolder = options.generateFolderId ?? defaultFolderId
  const existing = new Set(options.existingFolderIds ?? [])

  let data: Partial<TabFilePayload>
  try {
    data = JSON.parse(raw) as Partial<TabFilePayload>
  } catch {
    return { ok: false, error: 'json' }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'format' }
  if (data.format !== TABS_FILE_FORMAT || !Array.isArray(data.tabs)) {
    return { ok: false, error: 'format' }
  }

  const tabs: NavTab[] = []
  for (const rawTab of data.tabs) {
    if (!rawTab || typeof rawTab !== 'object') continue
    const name = String((rawTab as NavTab).name ?? '').trim()
    const urlRaw = String((rawTab as NavTab).url ?? '').trim()
    if (!name || !urlRaw) continue
    tabs.push({
      id: genTab(),
      name,
      url: normalizeUrl(urlRaw),
      ...(typeof (rawTab as NavTab).folderId === 'string' ? { folderId: (rawTab as NavTab).folderId } : {}),
    })
  }

  // Папки из файла (v2): полная замена структуры. Коллизии id — пересоздаём,
  // ссылки вкладок переписываем через карту ремаппинга (иначе повторный импорт
  // разваливает раскладку: вкладки выпадают в «без папки»).
  const folders: NavFolder[] = []
  const folderIds = new Set<string>()
  const folderRemap = new Map<string, string>()
  if (Array.isArray(data.folders)) {
    for (const rawFolder of data.folders) {
      if (!rawFolder || typeof rawFolder !== 'object') continue
      const fname = String((rawFolder as NavFolder).name ?? '').trim()
      let fid = String((rawFolder as NavFolder).id ?? '')
      if (!fname || !fid) continue
      if (existing.has(fid)) {
        // Коллизия с текущей структурой — новый id + ремаппинг ссылок вкладок.
        const nid = genFolder()
        folderRemap.set(fid, nid)
        fid = nid
      } else if (folderIds.has(fid)) {
        // Дубль внутри файла — новый id без ремаппинга (вкладки остаются у первой папки).
        fid = genFolder()
      }
      folderIds.add(fid)
      folders.push({ id: fid, name: fname })
    }
  }
  // Переписываем ссылки вкладок на пересозданные папки, затем отсекаем «висячие».
  for (const t of tabs) {
    if (t.folderId) t.folderId = folderRemap.get(t.folderId) ?? t.folderId
  }
  // Отсекаем «висячие» ссылки на папки, которых нет в импортированном наборе.
  for (const t of tabs) {
    if (t.folderId && !folderIds.has(t.folderId)) t.folderId = undefined
  }

  if (!tabs.length) return { ok: false, error: 'empty' }
  return { ok: true, tabs, folders }
}
