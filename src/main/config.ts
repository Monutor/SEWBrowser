import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface NavTab {
  id: string;
  name: string;
  url: string;
  /** ID папки (NavFolder.id) или отсутствует — вкладка «без папки». */
  folderId?: string;
}

/** Папка для группировки вкладок. Один уровень вложенности (папка → вкладки). */
export interface NavFolder {
  id: string;
  name: string;
  /** ID записи пароля в шифрохранилище ОС (credentials/folderPasswords.ts). Нет — папка без защиты. */
  passwordId?: string;
}

/** Детерминированный id папки из пути (стабильный через рестарты). */
function folderIdFor(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'sf_' + (h >>> 0).toString(36)
}

/** Одна папка со сканами. id стабилен через рестарты (детерминирован из path). */
export interface ScanFolder {
  /** Уникальный идентификатор папки (для UI/удаления), не привязан к пути. */
  id: string
  /** Абсолютный путь к папке со сканами на диске. */
  path: string
}

/** Настройки диалога печати (renderer, src/renderer/src/print-dialog.ts) */
export interface PrintSettings {
  destination: 'pdf' | 'printer';
  deviceName: string;
  rangeMode: 'all' | 'current' | 'custom';
  rangeFrom: number;
  rangeTo: number;
  copies: number;
  landscape: boolean;
  pageSize: 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid';
  /** Поля в миллиметрах */
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  /** Проценты, 10..200 */
  scale: number;
  printBackground: boolean;
  displayHeaderFooter: boolean;
}

export interface SewConfig {
  startUrl: string;
  debug: boolean;
  allowlistEnabled: boolean;
  allowlist: string[];
  plugins: Record<string, boolean>;
   /** Запомненный зум страниц: host -> zoom factor (1 = 100%) */
   zoom: Record<string, number>;
   /** Настройки диалога печати; undefined — ещё не печатали (renderer ставит дефолты) */
   print?: PrintSettings;
   /** Автоочистка при выходе: 'none' | 'cache' (только HTTP-кэш) | 'all' (кэш + все хранилища) */
   clearOnExit: 'none' | 'cache' | 'all';
   tabs: NavTab[];
   /** Папки для группировки вкладок (один уровень). Связаны через NavTab.folderId. */
   folders: NavFolder[];
  /** Путь до внешнего софта сканера (напр. HP) — запускается по кнопке «Сканы» */
  scannerAppPath: string;
  /** Аргументы запуска софта сканера (напр. HP G3110 требует -mg3110) */
  scannerAppArgs: string;
  /** Папки, куда HP-софт сохраняет отсканированные файлы — мониторятся на новые файлы */
  scanFolders: ScanFolder[];
  /** Устаревшее одиночное поле (миграция со старых конфигов). Не используется как источник истины. */
  scanFolder?: string;
}

const DEFAULTS: SewConfig = {
  startUrl: 'https://sew.mvideoeldorado.ru/v2/',
  debug: false,
  allowlistEnabled: true,
  // kc.tech.mvideo.ru — SSO (Keycloak), без него не пройти логин в SEW.
  // *.mvideo.ru — визит для cookie-consent + прогрев кук: BFF-мост sew-helper
  // (net:fetch, default session) без MVID-кук отдаёт пусто, принять куки можно
  // только зайдя на www.mvideo.ru прямо из приложения.
   // monutor.github.io — встроенные инструменты в тулбаре (Генератор ШК / База товаров).
   allowlist: ['*.mvideoeldorado.ru', 'kc.tech.mvideo.ru', '*.mvideo.ru', '*.monutor.github.io'],
  plugins: {},
  zoom: {},
    clearOnExit: 'none',
    tabs: [],
    folders: [],
    scannerAppPath: '',
    scannerAppArgs: '',
    scanFolders: [],
}

function configFile(): string {
  return join(app.getPath('userData'), 'config.json')
}

function readUserConfig(): Partial<SewConfig> {
  const file = configFile()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Partial<SewConfig>
  } catch {
    // повреждённый конфиг — используем дефолты
    return {}
  }
}

export function getConfig(): SewConfig {
  const user = readUserConfig()
  return sanitizeConfig(user)
}

/** Отсечь мусор из config.json: неверный тип любого поля -> дефолт (иначе падает isAllowedUrl и др.) */
function sanitizeConfig(user: Partial<SewConfig>): SewConfig {
  const pickString = (v: unknown, fallback: string): string =>
    typeof v === 'string' ? v : fallback
  const pickStringArray = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : fallback
  const pickBoolMap = (v: unknown): Record<string, boolean> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'boolean') out[k] = val
    }
    return out
  }
  const pickZoom = (v: unknown): Record<string, number> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, number> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'number' && Number.isFinite(val) && val > 0 && val <= 5) out[k] = val
    }
    return out
  }
  const pickTabs = (v: unknown): NavTab[] => {
    if (!Array.isArray(v)) return []
    return v
      .filter(
        (t): t is NavTab =>
          !!t && typeof t === 'object' && typeof (t as NavTab).name === 'string' && typeof (t as NavTab).url === 'string' && typeof (t as NavTab).id === 'string',
      )
      .map((t) => ({
        id: (t as NavTab).id,
        name: (t as NavTab).name,
        url: (t as NavTab).url,
        ...(typeof (t as NavTab).folderId === 'string' ? { folderId: (t as NavTab).folderId } : {}),
      }))
      .slice(0, 500)
  }
  const pickFolders = (v: unknown): NavFolder[] => {
    if (!Array.isArray(v)) return []
    const out: NavFolder[] = []
    const seen = new Set<string>()
    for (const item of v) {
      if (!item || typeof item !== 'object') continue
      const name = typeof (item as NavFolder).name === 'string' ? (item as NavFolder).name.trim() : ''
      const id = typeof (item as NavFolder).id === 'string' ? (item as NavFolder).id : ''
      if (!name || !id || seen.has(id)) continue
      seen.add(id)
      const passwordId = typeof (item as NavFolder).passwordId === 'string' ? (item as NavFolder).passwordId : undefined
      out.push({ id, name, ...(passwordId ? { passwordId } : {}) })
    }
    return out
  }
  // Папки со сканами: валидные {id,path}. Явно заданный массив (даже пустой) —
  // источник истины. Устаревшее одиночное scanFolder мигрируем ТОЛЬКО когда
  // поля scanFolders в файле вообще нет (старый конфиг); иначе удалённая
  // последняя папка воскресала бы из legacy при каждом чтении.
  const pickScanFolders = (v: unknown): ScanFolder[] => {
    if (Array.isArray(v)) {
      const out: ScanFolder[] = []
      const seen = new Set<string>()
      for (const item of v) {
        if (item && typeof item === 'object' && typeof (item as ScanFolder).path === 'string') {
          const path = (item as ScanFolder).path.trim()
          if (!path || seen.has(path.toLowerCase())) continue
          seen.add(path.toLowerCase())
          out.push({ id: typeof (item as ScanFolder).id === 'string' ? (item as ScanFolder).id : folderIdFor(path), path })
        }
      }
      return out
    }
    // legacy-миграция: одна папка из старого поля scanFolder
    const legacy = typeof user.scanFolder === 'string' ? user.scanFolder.trim() : ''
    if (legacy) return [{ id: folderIdFor(legacy), path: legacy }]
    return DEFAULTS.scanFolders
  }
  // Настройки печати: неверный тип/значение -> дефолт. absent/undefined
  // остаётся undefined — renderer применит свои дефолты (A4, книжная, 20/20/10/10).
  const pickPrint = (v: unknown): PrintSettings | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const raw = v as Record<string, unknown>
    const sizes = ['A3', 'A4', 'A5', 'A6', 'Legal', 'Letter', 'Tabloid'] as const
    const int = (x: unknown, min: number, max: number, fallback: number): number => {
      const n = Math.floor(Number(x))
      return Number.isFinite(n) && n >= min && n <= max ? n : fallback
    }
    const mm = (x: unknown, fallback: number): number => {
      const n = Math.round(Number(x) * 100) / 100
      return Number.isFinite(n) && n >= 0 && n <= 50 ? n : fallback
    }
    return {
      destination: raw.destination === 'printer' ? 'printer' : 'pdf',
      deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : '',
      rangeMode: raw.rangeMode === 'current' || raw.rangeMode === 'custom' ? raw.rangeMode : 'all',
      rangeFrom: int(raw.rangeFrom, 1, 100000, 1),
      rangeTo: int(raw.rangeTo, 1, 100000, 1),
      copies: int(raw.copies, 1, 99, 1),
      landscape: raw.landscape === true,
      pageSize: sizes.includes(raw.pageSize as (typeof sizes)[number]) ? (raw.pageSize as PrintSettings['pageSize']) : 'A4',
      marginTop: mm(raw.marginTop, 20),
      marginBottom: mm(raw.marginBottom, 20),
      marginLeft: mm(raw.marginLeft, 10),
      marginRight: mm(raw.marginRight, 10),
      scale: int(raw.scale, 10, 200, 100),
      printBackground: raw.printBackground === true,
      displayHeaderFooter: raw.displayHeaderFooter === true,
    }
  }
  const folders = pickFolders(user.folders)
  const folderIds = new Set(folders.map((f) => f.id))
  const tabs = pickTabs(user.tabs).map((t) =>
    t.folderId && !folderIds.has(t.folderId) ? { ...t, folderId: undefined } : t,
  )
  return {
    startUrl: pickString(user.startUrl, DEFAULTS.startUrl) || DEFAULTS.startUrl,
    debug: typeof user.debug === 'boolean' ? user.debug : DEFAULTS.debug,
    allowlistEnabled: typeof user.allowlistEnabled === 'boolean' ? user.allowlistEnabled : DEFAULTS.allowlistEnabled,
    allowlist: pickStringArray(user.allowlist, DEFAULTS.allowlist),
    plugins: { ...DEFAULTS.plugins, ...pickBoolMap(user.plugins) },
    zoom: { ...DEFAULTS.zoom, ...pickZoom(user.zoom) },
    print: pickPrint(user.print),
    clearOnExit: user.clearOnExit === 'cache' || user.clearOnExit === 'all' ? user.clearOnExit : 'none',
    folders,
    tabs,
    scannerAppPath: pickString(user.scannerAppPath, ''),
    scannerAppArgs: pickString(user.scannerAppArgs, ''),
    scanFolders: pickScanFolders(user.scanFolders),
  }
}

/** Частичное обновление пользовательского конфига с сохранением на диск */
export function saveConfig(partial: Partial<SewConfig>): SewConfig {
  const current = readUserConfig()
  const validPartial: Partial<SewConfig> = { ...partial }
  // Битый тип в patch не должен затирать хорошее значение в файле
  if ('plugins' in validPartial && (!validPartial.plugins || typeof validPartial.plugins !== 'object')) {
    delete validPartial.plugins
  }
  if ('zoom' in validPartial && (!validPartial.zoom || typeof validPartial.zoom !== 'object')) {
    delete validPartial.zoom
  }
  const merged: Partial<SewConfig> = {
    ...current,
    ...validPartial,
    plugins: { ...(current.plugins ?? {}), ...(validPartial.plugins ?? {}) },
    zoom: { ...(current.zoom ?? {}), ...(validPartial.zoom ?? {}) },
  }
  // Раз список папок явно перезаписали — legacy-поле больше не нужно,
  // иначе оно вечно хранится в config.json мёртвым грузом.
  if ('scanFolders' in validPartial) delete merged.scanFolder
  try {
    writeFileSync(configFile(), JSON.stringify(merged, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[SEWBrowser] failed to write config:', err)
  }
  return getConfig()
}

export function isDebugMode(): boolean {
  // Dev (npm run dev/dev:watch, app не упакован): дебаг всегда включён.
  // Релиз (app.isPackaged): дебаг выключен, включается только флагом --debug.
  // Поле config.debug больше не читаем, чтобы случайно сохранённый в dev
  // debug:true не протекал в релиз (у dev и релиза общий userData/config.json).
  if (process.argv.includes('--debug')) return true
  return !app.isPackaged
}
