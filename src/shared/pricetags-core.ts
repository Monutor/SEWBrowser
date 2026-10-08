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

/** Тексты ошибок по образцу `runStockDownload` (src/main/index.ts:1450).
 *
 *  `body` — тело не-2xx ответа SEW, если клиент его сохранил. Причина отказа
 *  написана только там: по коду 403 мы способны лишь догадаться («нет прав на
 *  ценники»), а эта догадка уже дважды уводила в сторону от настоящей причины.
 *  Поэтому свой текст SEW показываем буквально, а догадку по статусу оставляем
 *  только на тот случай, когда распознать тело не удалось. */
export function sewErrorMessage(status: number, subject: string, body?: string): string {
  const fromSew = body ? sewContentError(body) : null
  if (fromSew) return fromSew
  if (status === 401) return 'сессия SEW протухла — обновите страницу SEW'
  if (status === 403) return `нет прав на ${subject} по магазину`
  return `SEW ответил HTTP ${status} (${subject})`
}

/**
 * Текст ошибки из тела `GET pricetag-content/{id}` — конверт SEW с HTTP 200.
 *
 * Зачем: рендер ценников асинхронный, поэтому содержимое опрашивают в цикле, и
 * «ещё не готово» от SEW приходит двумя разными телами. Пока рендер идёт — это
 * ПУСТОЕ тело (проверено по HAR: `size: 0` при HTTP 200), и его мы обязаны
 * распознать как «жди дальше». А вот JSON-ошибка при HTTP 200 — это отказ,
 * и раньше он молча уходил в тот же опрос: пользователь 60 с смотрел на
 * «Рендер ценников не успел» вместо реального объяснения SEW.
 *
 * Возвращает `null`, если это точно не ошибка: пустое тело, HTML (в том числе
 * частично отрисованный — он JSON не разбирается) и любой JSON без
 * распознанного текста ошибки. Намеренно снисходителен к форме: HAR снят на
 * успешной сессии и ни одного ошибочного ответа не содержит, поэтому опираться
 * приходится на конвенцию конверта, а не на один «канонический» вид.
 */
export function sewContentError(body: string): string | null {
  const raw = String(body ?? '').trim()
  if (!raw) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    // HTML (или его обрывок) — это рендер, а не ошибка.
    return null
  }
  if (!isRecord(json)) return null

  // Конвенция SEW: responseHeader.errors[].message — тем же разбирается
  // normalizeSearchResponse, где errors[] трактуется как предупреждения.
  const header = isRecord(json.responseHeader) ? json.responseHeader : {}
  const firstErrorMessage = (list: unknown): string => {
    if (!Array.isArray(list)) return ''
    for (const item of list) {
      const message = isRecord(item) ? asString(item.message).trim() : ''
      if (message) return message
    }
    return ''
  }
  const candidates = [
    firstErrorMessage(header.errors),
    firstErrorMessage(json.errors),
    asString(json.message).trim(),
    asString(json.error).trim(),
    isRecord(json.error) ? asString(json.error.message).trim() : '',
    asString(json.error_description).trim(),
    asString(json.detail).trim(),
    asString(json.reason).trim(),
  ]
  return candidates.find((message) => message.length > 0) ?? null
}

/** Отказ шлюза именно по правам. SEW на отказ подсистемы ценников отдаёт
 *  либо HTTP 403 с телом «…Access Denied…», либо HTTP 200 с тем же текстом в
 *  `responseHeader.errors[].message` — второй случай разбирает `sewContentError`,
 *  и его текст доходит до пользователя английским. */
export function isAccessDenied(status: number, body?: string): boolean {
  return status === 403 || /access\s*denied/i.test(String(body ?? ''))
}

/**
 * Объяснение отказа по правам в ценниках: почти всегда это несовпадение
 * табельного номера в поле «Логин SEW» с тем, под кем открыта сессия SEW.
 * `sessionUsername` — логин, который живая SPA кладёт в `x-username`; пусто,
 * если перехвата не было, и тогда подсказка ограничивается первым предложением.
 */
export function pricetagAccessHint(configured?: string, sessionUsername?: string): string {
  const mine = String(configured ?? '').trim()
  const live = String(sessionUsername ?? '').trim()
  if (live && mine && live !== mine) {
    return (
      `SEW не пускает к ценникам под логином «${mine}»: сессия открыта под «${live}». ` +
      'Подставьте логин сессии в поле «Логин SEW» — он уходит в заголовке x-username.'
    )
  }
  if (live && !mine) {
    return (
      `в поле «Логин SEW» пусто, а сессия открыта под «${live}» — подставьте его, ` +
      'он уходит в заголовке x-username.'
    )
  }
  return mine
    ? `нет прав у логина «${mine}». Проверьте поле «Логин SEW»: обычно SEW открыт под другим сотрудником.`
    : 'нет прав на ценники. Укажите табельный номер в поле «Логин SEW».'
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

/**
 * Ширина штрих-кода на ценнике — целое от 1 до 999 (в единицах шаблона).
 *
 * Диапазон намеренно тот же, что у `isValidCopies`, но функция отдельная:
 * это разные величины, и общий валидатор связывает их диапазоны намертво —
 * расширение копий до 9999 заодно расширило бы штрих, а сужение сломало бы
 * конфиг у пользователей с широким штрихом.
 *
 * ВАЖНО: у SEW нет поля ширины штриха — ни в теле задания печати, ни среди
 * admin-settings (в HAR за 2026-10-07 проверено: есть только `barcode_template`
 * = id шаблона). Ключ проходит санитайз и хранится в config.json, но в запрос
 * пока не уходит. Прежде чем слать его в SEW, нужно найти фактическое поле.
 */
export function isValidBarcodeWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 999
}

const pad = (n: number, len = 2): string => String(n).padStart(len, '0')

/** Имя PDF вида «Ценники S187 2026-10-07-1504.pdf» — с кодом магазина и датой. */
export function pricetagFileName(objectId: string, now: Date): string {
  const shop = asString(objectId).replace(/[^\w-]+/g, '_') || 'shop'
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `Ценники ${shop} ${stamp}.pdf`
}
