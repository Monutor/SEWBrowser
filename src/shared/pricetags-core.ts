/** Чистая логика фичи «Ценники»: типы, разбор ввода, контракты запросов SEW,
 *  валидаторы конфига. Видна и main, и renderer, и тестам — поэтому без DOM и
 *  без импортов electron/node (иначе `node --test` её не поднимет). */

export interface SewTemplate {
  id: number
  name: string
  width?: number
  height?: number
}

export interface SewStore {
  id: string
  name: string
}

/** Позиция, найденная по SKU. Цена зафиксирована на момент `pricetag/search`. */
export interface PrepareItem {
  sku: string
  name: string
  price: number
}

export interface PrepareResult {
  /** Найденные позиции в порядке ввода пользователя. */
  items: PrepareItem[]
  /** SKU, которых SEW не нашёл. */
  missing: string[]
  /** Шаблоны печати, доступные для позиций (из первого элемента ответа). */
  templates: SewTemplate[]
  /** Предупреждение SEW целиком, если был `responseHeader.errors`. */
  warning?: string
}

export interface BuildInput {
  objectId: string
  items: PrepareItem[]
  templateId: number
  paperColorId: number
  copies: number
}

/** Сколько ждём рендер HTML на стороне SEW, прежде чем отменить задание. */
export const RENDER_TIMEOUT_MS = 60_000
/** Паузы между попытками забрать `pricetag-content`: рендер в SEW асинхронный,
 *  но 60 одинаковых запросов в минуту — лишняя нагрузка на API магазина. */
export const RENDER_BACKOFF_MS = [1_000, 2_000, 3_000, 5_000, 5_000, 5_000]

/** Цвета бумаги — из `GET /api/pricetags-management/sew/paper-color/list`. */
export const PAPER_COLORS: readonly { id: number; name: string }[] = [
  { id: 1, name: 'Белая' },
  { id: 2, name: 'Жёлтая' },
  { id: 3, name: 'Розовая' },
]

/** Допустимы `[0-9A-Za-z_-]` и хотя бы одна цифра: у SKU SEW цифры всегда есть,
 *  а буквенный мусор из соседнего текста (`abc`) в список пролезать не должен. */
const SKU_RE = /^[\w-]*\d[\w-]*$/

/** SKU из буфера/строки ввода: переводы строк, табуляции, запятые, точки с
 *  запятой; мусор отбрасываем, дубли схлопываем с сохранением порядка. */
export function parseSkuInput(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    const value = raw.trim()
    if (!value || !SKU_RE.test(value) || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readTemplates(row: Record<string, unknown>): SewTemplate[] {
  if (!Array.isArray(row.templates)) return []
  const out: SewTemplate[] = []
  for (const item of row.templates) {
    if (!isRecord(item)) continue
    const id = item.id
    const name = item.name
    if (typeof id !== 'number' || !Number.isFinite(id) || typeof name !== 'string') continue
    const width = typeof item.width === 'number' ? item.width : undefined
    const height = typeof item.height === 'number' ? item.height : undefined
    out.push(width === undefined && height === undefined ? { id, name } : { id, name, width, height })
  }
  return out
}

/**
 * Разбор ответа `POST /api/pricetags-print-tasks/sew/pricetag/search`.
 * SEW отдаёт позиции в своём порядке, а пользователь ждёт свой, поэтому
 * переупорядочиваем по `wanted`. Штрих-кода в ответе нет — он уже вшит сервером
 * в HTML ценника, нам его знать не нужно.
 */
export function normalizeSearchResponse(json: unknown, wanted: readonly string[]): PrepareResult {
  const wantedList = Array.isArray(wanted) ? wanted.map((s) => String(s)) : []
  const envelope = isRecord(json) ? json : {}
  const header = isRecord(envelope.responseHeader) ? envelope.responseHeader : {}
  const rawErrors = Array.isArray(header.errors) ? header.errors : []
  const warning = rawErrors
    .map((e) => (isRecord(e) ? asString(e.message) : ''))
    .find((message) => message.length > 0)

  const rows = Array.isArray(envelope.responseBody) ? envelope.responseBody.filter(isRecord) : []
  const bySku = new Map<string, Record<string, unknown>>()
  let templates: SewTemplate[] = []
  for (const row of rows) {
    const sku = asString(row.materialId)
    if (!sku) continue
    if (!bySku.has(sku)) bySku.set(sku, row)
    if (templates.length === 0) templates = readTemplates(row)
  }

  const items: PrepareItem[] = []
  const missing: string[] = []
  for (const sku of wantedList) {
    const row = bySku.get(sku)
    if (!row) {
      missing.push(sku)
      continue
    }
    items.push({ sku, name: asString(row.materialName), price: asNumber(row.price) })
  }
  return { items, missing, templates, warning }
}

/** Тело `pricetag/search` — 1:1 снято с HAR (см. спеку, разведка API). */
export function buildSearchBody(objectId: string, skus: readonly string[]): Record<string, unknown> {
  return {
    requestHeader: { headerParams: [] },
    requestBody: {
      objectId,
      barCodes: [],
      matNames: [],
      zcodes: [],
      matNos: [...skus],
      goodsGroups: [],
      brands: [],
      dynamicAttrs: {},
      requestOnlineSources: true,
      promo: [],
      onStock: true,
      onlyMarkdown: false,
    },
  }
}

/** Тело `print-task` — 1:1 с HAR. `printMode: "M"` = MANUAL (см. спеку). */
export function buildPrintTaskBody(input: BuildInput): Record<string, unknown> {
  const copies = isValidCopies(input.copies) ? Math.floor(input.copies) : 1
  return {
    requestBody: {
      objectId: input.objectId,
      forChanges: false,
      priceTags: input.items.map((item) => ({
        materialId: item.sku,
        materialName: item.name,
        price: item.price,
        objectId: input.objectId,
        paperColorId: input.paperColorId,
        templateId: input.templateId,
        totalCopies: copies,
        zCoupon: null,
      })),
      printMode: 'M',
      isOnline: true,
    },
  }
}

/** Тексты ошибок по образцу `runStockDownload` (src/main/index.ts:1450). */
export function sewErrorMessage(status: number, subject: string): string {
  if (status === 401) return 'сессия SEW протухла — обновите страницу SEW'
  if (status === 403) return `нет прав на ${subject} по магазину`
  return `SEW ответил HTTP ${status} (${subject})`
}

export function isValidTemplateId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function isValidPaperColorId(value: unknown): value is number {
  return typeof value === 'number' && PAPER_COLORS.some((c) => c.id === value)
}

export function isValidCopies(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 999
}

const pad = (n: number, len = 2): string => String(n).padStart(len, '0')

/** Имя PDF вида «Ценники S187 2026-10-07-1504.pdf» — с кодом магазина и датой. */
export function pricetagFileName(objectId: string, now: Date): string {
  const shop = asString(objectId).replace(/[^\w-]+/g, '_') || 'shop'
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `Ценники ${shop} ${stamp}.pdf`
}
