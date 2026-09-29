/** Отчёт об остатках SEW. Разбор ответа вынесен из main, чтобы покрыть
 *  тестами: сам IPC-обработчик сетевой и в node не проверяется. */

/** Адрес отчёта. objectId добавляется отдельно — из renderer приходит только
 *  код магазина, произвольный URL здесь не собирается никогда. */
const STOCK_REPORT_ENDPOINT = 'https://sew.mvideoeldorado.ru/v2/api/stockmanagement/report/stock-balance'

export const DEFAULT_OBJECT_ID = 'S187'

/** Код магазина: только символы, безопасные для query-параметра и для имени файла. */
export function isValidObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(value)
}

export function stockReportUrl(objectId: string): string {
  return `${STOCK_REPORT_ENDPOINT}?objectId=${encodeURIComponent(objectId)}`
}

/** Схема, которую шлёт сама SPA, и предел длины — страница отдаёт значение
 *  через executeJavaScript, там может оказаться что угодно. */
const BEARER_PREFIX = 'Bearer '
const MAX_BEARER_LEN = 4096

/**
 * Значение заголовка Authorization из гостевой страницы. API SEW отдаёт 401 на
 * запрос без него (куки гостя недостаточно) — токен перехватывает плагин
 * features/sew-auth. Фильтр отсекает мусор из страницы: не строку, не
 * заголовок, пустую схему и несоразмерное значение.
 */
export function bearerHeader(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (!token.startsWith(BEARER_PREFIX)) return null
  if (token.length <= BEARER_PREFIX.length || token.length > MAX_BEARER_LEN) return null
  return token
}

export interface StockReport {
  /** Готовые байты файла */
  data: Buffer
  /** Дата ответа сервера (ISO) — по ней имя файла, а не по системным часам */
  responseDate: string
  /** Расширение, определённое по содержимому, а не по Content-Type */
  ext: string
}

/** Расширение по магии файла. xlsx — это zip; xls — OLE2; остальное — текст. */
function detectExt(data: Buffer): string {
  if (data.length >= 4) {
    const magic = data.readUInt32LE(0)
    if (magic === 0x04034b50) return 'xlsx' // PK\x03\x04
    if (magic === 0xe011cfd0) return 'xls' // \xD0\xCF\x11\xE0
  }
  const head = data.subarray(0, 64).toString('utf-8').trimStart()
  if (head.startsWith('<')) return 'html'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'csv'
}

/** Конверт ответа: { responseHeader: { responseDate }, responseBody: { fileData } },
 *  где fileData — base64 с самим файлом. */
export function parseStockReport(body: unknown): StockReport {
  const root = (body ?? {}) as Record<string, unknown>
  const payload = (root.responseBody ?? {}) as Record<string, unknown>
  const fileData = payload.fileData
  if (typeof fileData !== 'string' || fileData.length === 0) {
    throw new Error('в ответе нет fileData — возможно, сессия SSO протухла')
  }
  const data = Buffer.from(fileData, 'base64')
  if (data.length === 0) throw new Error('fileData пустой')
  const ext = detectExt(data)
  if (ext === 'html' || ext === 'json') {
    throw new Error('вместо файла пришёл ' + ext.toUpperCase() + ' — войдите в SEW заново и повторите')
  }
  const header = (root.responseHeader ?? {}) as Record<string, unknown>
  const responseDate = typeof header.responseDate === 'string' ? header.responseDate : ''
  return { data, responseDate, ext }
}

/** «Остатки S187 2026-09-29.xlsx». Дата — из ответа сервера, переведённая в
 *  локальную; если её нет или она не разбирается, берётся сегодняшняя. */
export function stockFileName(objectId: string, responseDate: string, ext: string, now: Date = new Date()): string {
  const stamp = Number.isNaN(new Date(responseDate).getTime()) ? now : new Date(responseDate)
  const y = stamp.getFullYear()
  const m = String(stamp.getMonth() + 1).padStart(2, '0')
  const d = String(stamp.getDate()).padStart(2, '0')
  // Код магазина фильтруем ещё раз: isValidObjectId проверяет на входе, но имя
  // файла уходит на диск, и слеши в нём недопустимы.
  const shop = objectId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16)
  return `Остатки ${shop ? `${shop} ` : ''}${y}-${m}-${d}.${ext}`
}
