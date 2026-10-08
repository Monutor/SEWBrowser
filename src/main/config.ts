import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeRememberMinutes } from './credentials/folderUnlock'
import { DEFAULT_OBJECT_ID, isValidObjectId } from './downloads/stockReport'
// Санитайз четырёх ключей фичи «Ценники» вынесен в модуль без electron: сам
// config.ts под `node --test` не грузится, а тихих путей отказа у ключей два
// (чтение config.json и патч config:set). Валидаторы config-core.ts берёт те
// же, из shared/stockReport, — свои правила не дублируются.
import { dropInvalidPricetags, pickPricetagConfig } from './config-core'
// Валидатор логина SEW живёт в ./sew-api — том же electron-free модуле, где
// сам заголовок x-username собирается. Правило проверки и правило отправки не
// должны разъезжаться: если здесь принять строку, которую sew-api потом пошлёт
// «как есть», в заголовок может попасть мусор из config.json.
import { isValidSewUsername } from './sew-api'

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
  /** Папка сохранения файлов по умолчанию; пустая строка — системная «Загрузки» */
  downloadsDir?: string;
  /** Папка для отчёта об остатках; пустая строка — та же, что downloadsDir */
  stockDir?: string;
  /** Логин SEW — личный табельный номер сотрудника. Уходит в заголовке
   *  `x-username` на каждый запрос подсистемы ценников: без него SEW не понимает,
   *  от чьего имени выполняется запрос, и отвечает 403. В HAR его шлёт SPA (все
   *  40 запросов `/api/pricetags-*`), но само значение нигде в ответах SEW не
   *  приходит — только вход в SEW. Пустая строка = заголовок не шлём вовсе. */
  sewUsername: string;
  /** Код магазина для отчёта об остатках (objectId в запросе) */
  stockObjectId: string;
  /** Код магазина для ценников (напр. S187) — по умолчанию тот же, что у остатков:
   *  отдельный ключ нужен, чтобы печать ценников не ломалась у другого магазина. */
  pricetagObjectId: string;
  /** id шаблона печати ценника (89 = А6 ПРОМО, 96 = ШТРИХ-КОД 24, …) */
  pricetagTemplateId: number;
  /** 1 — белая, 2 — жёлтая, 3 — розовая */
  pricetagPaperColorId: number;
  /** Сколько копий каждого ценника */
  pricetagCopies: number;
  /** Ширина штрих-кода на ценнике (1..999). У SEW поля ширины нет — ключ
   *  проходит санитайз и хранится, но в задание печати пока не уходит. */
  pricetagBarcodeWidth: number;
   /** Автоочистка при выходе: 'none' | 'cache' (только HTTP-кэш) | 'all' (кэш + все хранилища) */
  clearOnExit: 'none' | 'cache' | 'all';
   tabs: NavTab[];
   /** Папки для группировки вкладок (один уровень). Связаны через NavTab.folderId. */
   folders: NavFolder[];
  /** Путь до внешнего софта сканера (напр. HP) — запускается по кнопке «Сканы» */
  scannerAppPath: string;
  /** Аргументы запуска софта сканера (напр. HP G3110 требует -mg3110) */
  scannerAppArgs: string;
  /** Сколько минут не спрашивать пароль защищённой папки после галки «запомнить» (1..1440) */
  folderPasswordRememberMinutes: number;
  /** Папки, куда HP-софт сохраняет отсканированные файлы — мониторятся на новые файлы */
  scanFolders: ScanFolder[];
  /** Устаревшее одиночное поле (миграция со старых конфигов). Не используется как источник истины. */
  scanFolder?: string;
  /**
   * Сколько гостей (процессов Chromium) держать живыми одновременно. Дальние по
   * LRU фоновые вкладки выгружаются: webview разрывается, память освобождается,
   * при возврате вкладка грузится заново. 0 или отсутствие поля — не выгружать.
   */
  maxLiveTabs?: number;
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
  folderPasswordRememberMinutes: 5,
  stockObjectId: DEFAULT_OBJECT_ID,
  // Пусто = заголовок x-username не уходит вовсе (см. isValidSewUsername).
  sewUsername: '',
  pricetagObjectId: DEFAULT_OBJECT_ID,
  pricetagTemplateId: 89,
  pricetagPaperColorId: 1,
  pricetagCopies: 1,
  pricetagBarcodeWidth: 100,
    scanFolders: [],
  maxLiveTabs: 4,
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
    downloadsDir: pickString(user.downloadsDir, ''),
    stockDir: pickString(user.stockDir, ''),
    stockObjectId: isValidObjectId(user.stockObjectId) ? user.stockObjectId : DEFAULT_OBJECT_ID,
    // Логин приходит из config.json -> заголовок x-username. Пустая строка
    // ЗДЕСЬ осмысленна и хранится: это «не отправлять заголовок» (например,
    // пользователь стёр поле, чтобы вернуться к настройке без логина).
    // Отвергать её нельзя — тогда очистить поле было бы невозможно. Сам
    // заголовок пустую строку всё равно не выпустит: см. sewHeaders.
    sewUsername:
      user.sewUsername === '' || isValidSewUsername(user.sewUsername) ? user.sewUsername : DEFAULTS.sewUsername,
    // Ценники: битое значение из config.json -> дефолт, иначе запрос уйдёт
    // в SEW с несуществующим шаблоном/цветом бумаги и вернёт 500.
    ...pickPricetagConfig(user, DEFAULTS),
    clearOnExit: user.clearOnExit === 'cache' || user.clearOnExit === 'all' ? user.clearOnExit : 'none',
    folders,
    tabs,
    scannerAppPath: pickString(user.scannerAppPath, ''),
    scannerAppArgs: pickString(user.scannerAppArgs, ''),
    folderPasswordRememberMinutes: normalizeRememberMinutes(
      user.folderPasswordRememberMinutes,
      DEFAULTS.folderPasswordRememberMinutes,
    ),
    scanFolders: pickScanFolders(user.scanFolders),
    maxLiveTabs: pickMaxLiveTabs(user.maxLiveTabs),
  }
}

/** Бюджет живых гостей: целое >= 1. 0 и мусор — дефолт (выгрузка не выключается
 *  битым значением из файла, иначе пользователь молча потеряет экономию памяти). */
function pickMaxLiveTabs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULTS.maxLiveTabs ?? 4
  const whole = Math.floor(value)
  return whole >= 1 ? whole : DEFAULTS.maxLiveTabs ?? 4
}

/** Частичное обновление пользовательского конфига с сохранением на диск */
export function saveConfig(partial: Partial<SewConfig>): SewConfig {
  const current = readUserConfig()
  const validPartial: Partial<SewConfig> = dropInvalidPricetags({ ...partial })
  // Битый тип в patch не должен затирать хорошее значение в файле
  if ('plugins' in validPartial && (!validPartial.plugins || typeof validPartial.plugins !== 'object')) {
    delete validPartial.plugins
  }
  if ('zoom' in validPartial && (!validPartial.zoom || typeof validPartial.zoom !== 'object')) {
    delete validPartial.zoom
  }
  // Явный print: undefined в патче не должен затирать настройки печати в файле
  if ('print' in validPartial && (!validPartial.print || typeof validPartial.print !== 'object' || Array.isArray(validPartial.print))) {
    delete validPartial.print
  }
  // Пустая строка — валидное значение («системные Загрузки»), поэтому чистим
  // только не-строки, а не пустые.
  if ('downloadsDir' in validPartial && typeof validPartial.downloadsDir !== 'string') {
    delete validPartial.downloadsDir
  }
  if ('stockDir' in validPartial && typeof validPartial.stockDir !== 'string') {
    delete validPartial.stockDir
  }
  if ('stockObjectId' in validPartial && !isValidObjectId(validPartial.stockObjectId)) {
    delete validPartial.stockObjectId
  }
  // Критерий ровно тот же, что и в sanitizeConfig: битый логин выбрасываем из
  // патча, а не пишем в config.json — иначе следующий запуск поднимет мусор
  // «как есть» и он уйдёт в заголовок x-username. Пустая строка — не мусор, а
  // осознанное «очистить поле», её пропускаем.
  if ('sewUsername' in validPartial && validPartial.sewUsername !== '' && !isValidSewUsername(validPartial.sewUsername)) {
    delete validPartial.sewUsername
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
